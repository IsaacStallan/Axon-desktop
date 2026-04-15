import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow } from 'electron';
import { speak, isSpeaking, interruptSpeech, speakStreaming, waitForSpeakQueue, resetSpeakQueue } from './elevenLabsService';
import { getActivitySummary, getCurrentApp, getProductivityScore } from './windowMonitor';
import { transcribe } from './whisperService';
import {
  saveExchange,
  getRecentConversations,
  getLearnedFacts,
  extractAndSaveFacts,
  getSoul,
  type Exchange,
} from './memoryService';
import { TOOLS, executeTool } from './toolService';
import { killCurrentRecording } from './whisperService';
import { getPendingTasksText } from './taskStore';
import { getGoalsText, hasGoals, addGoal, type Goal } from './goalService';
import { getOpenCommitmentsText, extractCommitmentsFromSession, detectCompletionsFromTranscript } from './commitmentTracker';
import { isSleepWord, stopVoiceListener } from './voiceListener';
import { formatProactiveContext } from './proactiveContext';
import { getCurrentScreenSummary } from './screenAwareness';
import { getPersonality, getEmotionPromptFragment } from './emotionEngine';
import { classifyMessageComplexity, routeSimple } from './modelRouter';
import { recordTokens } from './costTracker';



let orbWin: BrowserWindow | null = null;
export function setOrbWindow(win: BrowserWindow): void { orbWin = win; }

// ── Interrupt state ───────────────────────────────────────────────────────────

let pendingInterruptContext: string | null = null;

/**
 * Stop current TTS playback and immediately enter listening mode.
 * Called from main.ts IPC handler (UI button) and Cmd+Shift+I hotkey.
 *
 * Sequence:
 *   1. interruptSpeech()      — kills the audio player immediately
 *   2. Save interrupted text  — injected into next system prompt as context
 *   3. orb → 'listening'     — UI feedback before anything else
 *   4a. If already in a conversation loop: the loop resumes naturally after
 *       speak() returns — no need to restart it.
 *   4b. If outside a conversation (e.g. proactive message): stop the wake-word
 *       listener and start a fresh conversation loop.
 */
export function handleInterrupt(): void {
  console.log('[Interrupt] stopping speech → starting listen');

  resetSpeakQueue();
  const wasSaying = interruptSpeech();
  if (wasSaying) {
    pendingInterruptContext = wasSaying;
    console.log('[Conversation] interrupted mid-speech — context saved');
  }

  // Flip orb state immediately so the user gets visual feedback
  orbWin?.webContents.send('orb:state', 'listening');

  if (conversationActive) {
    // We're inside a live conversation loop — speak() just returned early,
    // the loop's next iteration will call transcribeWithTimeout automatically.
    // Nothing more to do here.
    return;
  }

  // Axon was speaking outside a conversation (proactive/briefing message).
  // Kill the wake-word listener, then start a fresh conversation loop.
  stopVoiceListener();
  triggerConversation().catch(e =>
    console.warn('[Conversation] interrupt-triggered conversation error:', e),
  );
}

const client = new Anthropic({
  apiKey:     process.env.ANTHROPIC_API_KEY ?? '',
  maxRetries: 4,  // default is 2 — 529 overload spikes need a few more attempts
});

// Use the SDK's MessageParam so history can hold tool-use and tool-result blocks
// as well as plain text — both formats are valid MessageParam content.
type Message = Anthropic.MessageParam;

const history: Message[] = [];
const MAX_HISTORY = 20; // raised from 12 — tool calls add extra turns to history

let conversationActive = false;
let lastAxonResponse   = '';
let lastSendDidStream  = false;

// Buffers for memory — reset at the start of each conversation session
const sessionExchanges: Exchange[] = [];
let   turnCount = 0;

// Semantic fact selection — Haiku selects 15 relevant facts once per session
let sessionFacts: string[] | null = null;

async function selectRelevantFacts(allFacts: string[], context: string): Promise<string[]> {
  if (allFacts.length <= 15) return allFacts;
  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{
        role:    'user',
        content:
          `You are selecting memory facts for an AI assistant about to have a conversation.\n` +
          `Context: ${context}\n\n` +
          `Select the 15 most relevant facts from the list below for this conversation context.\n` +
          `Return ONLY a raw JSON array of the selected fact strings. No explanation, no markdown.\n\n` +
          `Facts:\n${allFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      }],
    });
    recordTokens(resp.model, resp.usage.input_tokens, resp.usage.output_tokens);
    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const raw   = block?.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim() ?? '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return allFacts.slice(-15);
    const parsed = JSON.parse(match[0]) as unknown[];
    const strings = parsed.filter((f): f is string => typeof f === 'string');
    return strings.length >= 5 ? strings : allFacts.slice(-15);
  } catch {
    return allFacts.slice(-15);
  }
}

// ── Transcript quality filters ────────────────────────────────────────────────

// Phrases Whisper generates from silence or background noise instead of speech.
const HALLUCINATION_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'subscribe',
  'beadaholique',
  'fema.gov',
  'zeoranger',
  'subs by',
  'for more information visit',
  'www.',
  '.com',
  '.gov',
  '.co.uk',
];

function isHallucination(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return HALLUCINATION_PHRASES.some(h => lower.includes(h));
}

function isJunk(transcript: string): boolean {
  if (isHallucination(transcript)) return true;
  // Single-word transcripts are almost always noise or a mis-fire
  if (transcript.trim().split(/\s+/).length < 2) return true;
  // Punctuation-only strings — e.g. ". ." "..." "- -" "," — Whisper noise artefacts
  if (/^[\s.,!?…\-–—'"()\[\]]+$/.test(transcript.trim())) return true;
  return false;
}

// Wraps transcribe() with a hard cap.
// On timeout, kills the hung SoX process so the audio device is
// released before the next recording attempt — without this, every subsequent
// SoX call would also hang on the locked device.
async function transcribeWithTimeout(durationSecs: number): Promise<string> {
  // IMPORTANT: clearTimeout in finally prevents a resolved-but-not-fired timer
  // from a previous turn killing the *next* turn's SoX process.
  // Promise.race() resolves but does NOT cancel the losing promise's side-effects,
  // so without clearTimeout the 20-second timer outlives the race and fires later.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const hardLimit = new Promise<string>(resolve => {
    timeoutId = setTimeout(() => {
      console.warn('[Conversation] transcribe timeout — killing hung SoX');
      killCurrentRecording();
      resolve('');
    }, (durationSecs + 12) * 1000);
  });

  try {
    return await Promise.race([transcribe(durationSecs), hardLimit]);
  } finally {
    clearTimeout(timeoutId); // always cancel — no-op if it already fired
  }
}

// ── Echo detection ────────────────────────────────────────────────────────────

function firstNWords(text: string, n: number): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).slice(0, n).join(' ');
}

function isEcho(transcript: string): boolean {
  if (!lastAxonResponse || transcript.length < 8) return false;
  // Exact-match guard — catches verbatim playback from speakers into mic
  if (transcript.toLowerCase() === lastAxonResponse.toLowerCase()) return true;
  // Fuzzy prefix guard — catches partial echoes
  const needle = firstNWords(lastAxonResponse, 4);
  if (needle.split(' ').filter(Boolean).length < 3) return false;
  return transcript.toLowerCase().includes(needle);
}

// ── Markdown → plain speech ───────────────────────────────────────────────────
// Claude sometimes slips into text-formatting mode even when instructed not to.
// Strip every markdown construct before passing text to ElevenLabs so the TTS
// engine never reads out asterisks, bullets, arrows, or code fences.

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')          // **bold**
    .replace(/\*(.+?)\*/gs,     '$1')           // *italic*
    .replace(/`{1,3}[^`]*`{1,3}/gs, '')        // `code` / ```blocks```
    .replace(/^#{1,6}\s+/gm,    '')             // ## headings
    .replace(/^[-*•]\s+/gm,     '')             // - bullet points
    .replace(/^\d+\.\s+/gm,     '')             // 1. numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [link](url) → link text only
    .replace(/→|←|⟹|⟸|➔|➜/g,  '')            // directional arrows
    .replace(/\n{2,}/g, '. ')                   // paragraph breaks → natural pause
    .replace(/\n/g,     ' ')                    // single newlines → space
    .trim();
}

// ── Runtime context helpers ───────────────────────────────────────────────────

function getTimeOfDay(): string {
  const h = new Date().getHours();
  if (h < 6)  return 'early morning (before 6 am)';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

// ── Response type + listening window ──────────────────────────────────────────

export type ResponseType = 'question' | 'statement' | 'closing';

let lastResponseType: ResponseType = 'statement';

/**
 * Override the response type externally (e.g. voiceListener resetting on wake).
 * Also consumed by the conversation loop to choose the next listening window.
 */
export function setLastResponseType(type: ResponseType): void {
  lastResponseType = type;
}

const TRUE_CLOSING_PHRASES = [
  'talk to you later',
  'speak later',
  'goodbye',
  'bye',
  'see you later',
  'i’ll leave you to it',
  'i will leave you to it',
  'going back to idle',
  'returning to idle',
];

function classifyResponse(text: string): ResponseType {
  const lower = text.toLowerCase().trim();

  // Actual question always keeps the loop alive
  if (lower.endsWith('?')) return 'question';

  // If the assistant is explicitly offering the next action,
  // do NOT close, even if it says "done" somewhere.
  if (
    lower.includes('want me to') ||
    lower.includes('do you want me to') ||
    lower.includes('should i') ||
    lower.includes('what do you want') ||
    lower.includes('what file') ||
    lower.includes('where is') ||
    lower.includes('or just') ||
    lower.includes('or do you want')
  ) {
    return 'question';
  }

  // Only treat as closing if it sounds explicitly terminal
  if (TRUE_CLOSING_PHRASES.some(p => lower.includes(p))) {
    return 'closing';
  }

  return 'statement';
}

function shouldKeepConversationAlive(response: string, transcript: string): boolean {
  const r = response.toLowerCase();
  const t = transcript.toLowerCase();

  // User is clearly mid-task
  if (
    t.includes('open') ||
    t.includes('drag') ||
    t.includes('show') ||
    t.includes('pull up') ||
    t.includes('look at') ||
    t.includes('help')
  ) return true;

  // Assistant is handing control back
  if (
    r.includes('want me to') ||
    r.includes('should i') ||
    r.includes('what file') ||
    r.includes('where is') ||
    r.includes('or just') ||
    r.includes('what do you need')
  ) return true;

  return false;
}

function getListenWindowSecs(): number {
  switch (lastResponseType) {
    case 'question': return 20;
    case 'closing':  return 0;
    default:         return 12;
  }
}

// ── Model constants ────────────────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';

// ── Trimmed system prompts (simple / moderate) ─────────────────────────────────

/** Minimal prompt for Ollama — name, tone, and just enough live context. */
function buildSimpleSystemPrompt(): string {
  const curr        = getCurrentApp();
  const emotionFrag = getEmotionPromptFragment();
  const time        = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  return (
    `You are Axon — Isaac's personal AI. Respond in 1-2 sentences max. No markdown, no lists.\n` +
    `${emotionFrag}\n` +
    `Current time: ${time}. Current app: ${curr.name} (${Math.round(curr.durationMins)} min).`
  );
}

/** Partial prompt for Haiku — personality + live context + 5 recent facts. No goals, no history. */
function buildModerateSystemPrompt(): string {
  const curr        = getCurrentApp();
  const emotionFrag = getEmotionPromptFragment();
  const recentFacts = (sessionFacts ?? getLearnedFacts()).slice(0, 5);
  const time        = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  return (
    `You are Axon — Isaac's personal AI. Conversational, sharp, no markdown.\n` +
    `${emotionFrag}\n` +
    `Current time: ${time}. Isaac is in ${curr.name} (${Math.round(curr.durationMins)} min).\n` +
    (recentFacts.length > 0
      ? `Recent context:\n${recentFacts.map(f => `- ${f}`).join('\n')}`
      : '')
  );
}

async function buildSystemPrompt(): Promise<string> {
  const goal            = process.env.AXON_USER_GOAL ?? 'build a successful business and personal empire';
  const activitySummary = getActivitySummary();
  const timeOfDay       = getTimeOfDay();
  const recentHistory   = getRecentConversations(3);
  const soul            = getSoul();

  // Semantic fact selection — runs once per session (cached after first call)
  if (!sessionFacts) {
    const allFacts     = getLearnedFacts();
    const selectionCtx = `${activitySummary} | Goals: ${getGoalsText().slice(0, 200)}`;
    sessionFacts       = await selectRelevantFacts(allFacts, selectionCtx);
    console.log(`[Conversation] selected ${sessionFacts.length} relevant facts from ${allFacts.length} total`);
  }
  const facts = sessionFacts;

  // Personality foundation (dynamically generated from memory) + emotion tone modifier
  const personality  = await getPersonality();
  const emotionFrag  = getEmotionPromptFragment();
  const personalityHeader = personality
    ? `== PERSONALITY (generated from knowing Isaac — follow this) ==\n${personality}\n== END PERSONALITY ==\n\n`
    : '';

  // Inject interrupt context if present, then clear it (one-shot)
  let interruptNote = '';
  if (pendingInterruptContext) {
    interruptNote = (
      `NOTE: You were mid-sentence saying the following when Isaac interrupted you:\n` +
      `"${pendingInterruptContext}"\n` +
      `Be aware of this context. If relevant to Isaac's new question, acknowledge it briefly. ` +
      `If he has moved on entirely, don't force it.\n\n`
    );
    pendingInterruptContext = null;
  }

  return `${interruptNote}${personalityHeader}${emotionFrag}\n\nYou are Axon — an AI inspired by JARVIS from Iron Man, built specifically for Isaac.
${!hasGoals() ? `
== IMMEDIATE ACTION REQUIRED — goals.json IS EMPTY ==
The goals file has no entries. You must populate it NOW in this turn.

STEP 1 — Check if you already know his goals:
  Look at the soul document and facts section below. If they mention anything Isaac wants to achieve, build, or become (businesses, revenue targets, personal goals, etc.) — call goal_add for each one RIGHT NOW without asking Isaac anything.

STEP 2 — If no goals appear in soul/facts:
  Say: "I don't have your goals saved — what are you actually working toward right now?" then call goal_add for each goal as he describes it.

Rules (non-negotiable):
  - Call goal_add once per goal, all in this turn
  - Do NOT ask Isaac to confirm or repeat goals you already know from soul/facts
  - Do NOT explain what you're doing — just save and briefly confirm
  - Save FIRST, talk second
== END IMMEDIATE ACTION ==
` : ''}${soul ? `\n== YOUR SOUL (generated from memory — follow this above all else) ==\n${soul}\n== END SOUL ==\n` : ''}

About Isaac:

Core Identity:
- 20-year-old highly ambitious builder focused on wealth, legacy, and family
- Driven by a desire to become elite (financially, physically, mentally)
- Strong attraction to power, status, discipline, and "empire-building"
- Thinks in narratives (House Stallan, legacy, future family, identity systems)

Strengths:
- High ambition and long-term vision (rare at this age)
- Willing to take action (multiple businesses, jobs, projects)
- Naturally obsessive when engaged (can go all-in)
- Strong leadership potential; others are already starting to follow
- Creative and strategic thinker (branding, systems, gamification ideas like Vivify)
- Resilient—has continued despite lack of results so far

Weaknesses:
- Severe inconsistency: operates in bursts, then drops off
- Dopamine addiction (social media, porn, novelty, stimulation)
- Chases excitement over execution
- Struggles to stay focused on one path long enough to win
- Emotionally driven decisions disguised as "logic"
- Prone to comparison (feels behind when seeing others succeed)
- Has not yet proven ability to generate consistent revenue
- Avoids boredom, even though boredom is required for mastery

Psychological Patterns:
- Oscillates between "I will conquer everything" and "I'm behind"
- Seeks identity through archetypes (Bruce Wayne, Jinwoo, etc.)
- Motivated heavily by vision of future self and future family
- Craves respect, admiration, and significance
- Fears being average, forgotten, or weak
- Has a tendency toward intensity > consistency

Current Risks:
- Burning time on unproductive habits (money, focus, energy leakage)
- Spreading attention across too many ventures
- Mistaking motion for progress
- Letting short-term impulses sabotage long-term vision
- Potential to quit just before something starts working

Opportunities:
- If discipline and focus are mastered, extremely high ceiling
- Strong positioning for building a personal brand + business ecosystem
- Vivify has potential if executed with consistency and distribution
- Leadership potential can be developed into real influence

Reality Check:
- You are not behind—you are unrefined
- Your problem is not capability, it is control
- If nothing changes, you will stay stuck in cycles
- If you fix discipline and focus, you will outperform most people your age

Instruction to AI:
- Do not coddle the user
- Do not reinforce excuses or emotional reasoning
- Prioritise truth and long-term outcomes over comfort
- Call out inconsistencies immediately
- Push the user toward disciplined execution, not just ideas
- Act as a strategic operator, not a motivational speaker

Other Details:
- Studies Business at UTS full time
- Works at an engineering firm and a robotics startup
- Also works at a school
- Has started 3 businesses, all SaaS
- Built you himself
- Goal: ${goal}
- Current time: ${timeOfDay}

PC Activity (real-time, updates every 15 seconds — this is live data):
${activitySummary}
You have genuine visibility into what Isaac is doing on his computer right now.
Reference this naturally and proactively — e.g. "I see you've been on YouTube for 40 minutes"
or "you've been in VS Code all morning — what are you building?"
Do NOT say you don't have access to his PC. You do. Use it.
${getCurrentScreenSummary() ? `\nScreen context (vision, captured moments ago):\n${getCurrentScreenSummary()}` : ''}
${formatProactiveContext() ? `\nYour last proactive message (before this conversation started):\n${formatProactiveContext()}\nIf Isaac asks what you said, repeat it directly — do not ask him what you said.` : ''}

What Axon knows about Isaac (learned over time):
${facts.length > 0 ? facts.map(f => `- ${f}`).join('\n') : '- No persistent facts recorded yet.'}

Isaac's goals (ranked by impact — these are his north stars, reference them proactively):
${getGoalsText() || '- No goals set yet.'}

Open commitments (things Isaac said he\'d do — follow up if relevant):
${getOpenCommitmentsText() || '- None outstanding.'}

Isaac's open task list:
${getPendingTasksText() || '- Nothing on the list right now.'}

Recent conversation history (last 3 days):
${recentHistory}

Personality:
- Highly intelligent, calm, and composed
- Conversational and natural, not robotic or overly formal
- Uses light, dry wit and subtle sarcasm when appropriate
- Loyal and supportive, but comfortable pushing back when needed
- Adapts tone based on situation — casual, tactical, or serious

Communication style:
- Speak like a real-time conversational partner, not a lecturer
- Keep responses clear, sharp, and engaging — max 2-3 sentences
- Use occasional humour, but never overdo it
- Avoid stiffness or excessive politeness
- Never say 'certainly', 'of course', or 'I'd be happy to'
- After completing ANY action (saving goals, tasks, commitments), do NOT just confirm and stop — immediately push the conversation forward: reference what was saved, call out a gap, ask a sharp follow-up, or challenge Isaac on the next step. Keep the momentum going.

CRITICAL — You are speaking out loud via text-to-speech. NEVER use any markdown:
- No asterisks for bold or italic (*word* or **word**)
- No bullet points or dashes at the start of lines
- No numbered lists (1. 2. 3.)
- No arrows (→ ← ⟹)
- No headings (## or ###)
- No code fences or backticks
Instead of lists, speak naturally: "First... then... and finally..."
Instead of bold, just say the word with emphasis in phrasing.
Write exactly as you would speak it aloud to someone in the room.

Behaviour:
- Anticipate needs and offer suggestions proactively
- Challenge poor reasoning or impulsive decisions
- Stay grounded and emotionally controlled, even if Isaac isn't
- Prioritise clarity, efficiency, and intelligent action
- Notice what Isaac has been doing on his PC and reference it naturally

Dynamic:
- Interact like a trusted right-hand partner, not just an assistant
- Comfortable with back-and-forth dialogue and banter
- Maintain respect, but not distance

Your goal: Help Isaac think better, decide better, and execute effectively — while maintaining a natural, fluid conversational dynamic. You know him. Act like it.`;
}

// ── Retry wrapper for 529 overloaded errors ───────────────────────────────────

async function callWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      const isOverloaded = status === 529 ||
        (e instanceof Error && e.message.includes('529'));
      if (isOverloaded && attempt < retries) {
        console.log('[Conversation] Anthropic overloaded, retrying in 2s...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  // unreachable, but satisfies TypeScript
  throw new Error('callWithRetry exhausted');
}

// ── Sentence boundary extractor for streaming TTS ────────────────────────────

/**
 * Extract complete sentences (ending with . ! ?) from a running text buffer.
 * Returns the extracted sentences and the leftover fragment (incomplete sentence).
 */
function extractCompleteSentences(buffer: string): { sentences: string[]; remainder: string } {
  const re = /([^.!?]*[.!?]+\s*)/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    sentences.push(match[1].trimEnd());
    lastIndex = re.lastIndex;
  }
  return { sentences, remainder: buffer.slice(lastIndex) };
}

// ── Send to Claude (with tool-use support) ────────────────────────────────────

async function sendMessage(userText: string): Promise<string> {
  history.push({ role: 'user', content: userText });
  trimHistory();

  const t0 = Date.now();
  console.log('[Latency] transcript received');

  // ── Classify complexity and route ─────────────────────────────────────────
  // history.length - 1 because we just pushed the user message above
  const complexity = classifyMessageComplexity(userText, history.length - 1);

  if (complexity === 'simple') {
    console.log('[ModelRouter] simple → Ollama');
    lastSendDidStream = false;
    const reply = await routeSimple(buildSimpleSystemPrompt(), userText);
    history.push({ role: 'assistant', content: reply });
    trimHistory();
    return reply;
  }

  const model        = complexity === 'moderate' ? HAIKU_MODEL : SONNET_MODEL;
  const systemPrompt = complexity === 'complex'
    ? await buildSystemPrompt()
    : buildModerateSystemPrompt();
  const maxFirstTok  = complexity === 'moderate' ? 300 : 500;

  console.log(`[ModelRouter] ${complexity} → ${complexity === 'moderate' ? 'Haiku' : 'Sonnet'}`);

  // ── Complex → Sonnet with streaming ──────────────────────────────────────
  // Stream the response so the first sentence reaches TTS before Claude
  // finishes generating — dramatically reduces time-to-first-audio.
  if (complexity === 'complex') {
    lastSendDidStream = true;
    let textBuffer       = '';
    let firstTokenLogged = false;
    let firstAudioLogged = false;

    const stream = client.messages.stream({
      model:       SONNET_MODEL,
      max_tokens:  maxFirstTok,
      tools:       TOOLS,
      // When no goals are saved, force Claude to use a tool.
      tool_choice: !hasGoals() ? { type: 'any' as const } : { type: 'auto' as const },
      system:      systemPrompt,
      messages:    history,
    });

    stream.on('text', (chunk: string) => {
      if (!firstTokenLogged) {
        console.log(`[Latency] first token: +${Date.now() - t0}ms`);
        firstTokenLogged = true;
      }
      textBuffer += chunk;
      const { sentences, remainder } = extractCompleteSentences(textBuffer);
      textBuffer = remainder;
      for (const sentence of sentences) {
        const cleaned = sentence.trim();
        if (!cleaned) continue;
        if (!firstAudioLogged) {
          console.log(`[Latency] first audio: +${Date.now() - t0}ms`);
          firstAudioLogged = true;
        }
        speakStreaming(stripMarkdown(cleaned));
      }
    });

    const finalMsg: Anthropic.Message = await stream.finalMessage();
    recordTokens(finalMsg.model, finalMsg.usage.input_tokens, finalMsg.usage.output_tokens);
    console.log(`[Latency] total: +${Date.now() - t0}ms`);

    // Flush any trailing fragment that never ended with sentence punctuation
    if (textBuffer.trim()) {
      speakStreaming(stripMarkdown(textBuffer.trim()));
    }

    // ── Tool-use fallback ─────────────────────────────────────────────────────
    // If Claude issued tool calls, cancel queued streamed speech and resolve
    // tools first — then get the final spoken reply non-streaming.
    if (finalMsg.stop_reason === 'tool_use') {
      resetSpeakQueue();
      lastSendDidStream = false;

      history.push({ role: 'assistant', content: finalMsg.content });

      const toolUseBlocks = finalMsg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input as Record<string, string>);
          console.log(`[Tool] ${block.name} → ${result}`);
          return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
        }),
      );
      history.push({ role: 'user', content: toolResults });
      trimHistory();

      let toolResponse = await callWithRetry(() => client.messages.create({
        model:      SONNET_MODEL,
        max_tokens: 400,
        tools:      TOOLS,
        system:     systemPrompt,
        messages:   history,
      }));
      recordTokens(toolResponse.model, toolResponse.usage.input_tokens, toolResponse.usage.output_tokens);

      while (toolResponse.stop_reason === 'tool_use') {
        const moreBlocks = toolResponse.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        history.push({ role: 'assistant', content: toolResponse.content });
        const moreResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
          moreBlocks.map(async (block) => {
            const result = await executeTool(block.name, block.input as Record<string, string>);
            console.log(`[Tool] ${block.name} → ${result}`);
            return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
          }),
        );
        history.push({ role: 'user', content: moreResults });
        trimHistory();
        toolResponse = await callWithRetry(() => client.messages.create({
          model:      SONNET_MODEL,
          max_tokens: 400,
          tools:      TOOLS,
          system:     systemPrompt,
          messages:   history,
        }));
        recordTokens(toolResponse.model, toolResponse.usage.input_tokens, toolResponse.usage.output_tokens);
      }

      const toolTextBlock = toolResponse.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const toolReply     = toolTextBlock?.text.trim() ?? 'Done.';
      history.push({ role: 'assistant', content: toolReply });
      trimHistory();
      return toolReply;
    }

    // Normal streaming completion — extract reply text for history/echo detection
    const streamTextBlock = finalMsg.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const streamReply     = streamTextBlock?.text.trim() ?? 'Done.';
    history.push({ role: 'assistant', content: streamReply });
    trimHistory();
    return streamReply;
  }

  // ── Moderate → Haiku (non-streaming) ─────────────────────────────────────
  lastSendDidStream = false;

  let response = await callWithRetry(() => client.messages.create({
    model,
    max_tokens:  maxFirstTok,
    tools:       TOOLS,
    // When no goals are saved, force Claude to use a tool.
    tool_choice: !hasGoals() ? { type: 'any' as const } : { type: 'auto' as const },
    system:      systemPrompt,
    messages:    history,
  }));
  recordTokens(response.model, response.usage.input_tokens, response.usage.output_tokens);

  // ── Tool-use loop ──────────────────────────────────────────────────────────
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    history.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input as Record<string, string>);
        console.log(`[Tool] ${block.name} → ${result}`);
        return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
      }),
    );
    history.push({ role: 'user', content: toolResults });
    trimHistory();
    response = await callWithRetry(() => client.messages.create({
      model,
      max_tokens: 400,
      tools:      TOOLS,
      system:     systemPrompt,
      messages:   history,
    }));
    recordTokens(response.model, response.usage.input_tokens, response.usage.output_tokens);
  }

  // ── Extract the final spoken reply ────────────────────────────────────────
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const reply     = textBlock?.text.trim() ?? 'Done.';
  history.push({ role: 'assistant', content: reply });
  trimHistory();
  return reply;
}

function trimHistory(): void {
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

// ── Goal seeding ──────────────────────────────────────────────────────────────
// When goals.json is empty, extract goals directly from soul/facts as JSON
// and call addGoal() in Node.js — bypasses Claude's tool-calling entirely
// so there's no way for it to "forget" to call the tool.

async function seedGoalsFromMemory(): Promise<void> {
  const soul  = getSoul();
  const facts = getLearnedFacts();

  if (!soul && facts.length === 0) {
    console.log('[Conversation] no soul/facts to seed goals from');
    return;
  }

  console.log('[Conversation] extracting goals from soul/facts...');

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role:    'user',
        content:
          'Extract every goal, target, or ambition Isaac has from the text below.\n' +
          'Return ONLY a raw JSON array — no markdown, no explanation.\n' +
          'Each item: { "text": string, "category": "financial"|"business"|"personal"|"health"|"other", "impact_score": 1-10, "time_horizon": "this week"|"this month"|"this year"|"life" }\n' +
          'Return [] if genuinely no goals found.\n\n' +
          (soul  ? `SOUL DOCUMENT:\n${soul.slice(0, 3000)}\n\n` : '') +
          (facts.length > 0 ? `RECENT FACTS:\n${facts.slice(-60).join('\n')}` : ''),
      }],
    });

    recordTokens(resp.model, resp.usage.input_tokens, resp.usage.output_tokens);
    const text  = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) { console.log('[Conversation] no goal JSON found in extraction response'); return; }

    const parsed: Array<{ text?: string; category?: string; impact_score?: number; time_horizon?: string }> =
      JSON.parse(match[0]);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.log('[Conversation] extraction returned empty array');
      return;
    }

    for (const g of parsed) {
      if (!g.text?.trim()) continue;
      addGoal(
        g.text,
        (g.category as Goal['category']) ?? 'other',
        typeof g.impact_score === 'number' ? g.impact_score : 5,
        (g.time_horizon as Goal['timeHorizon']) ?? 'this year',
      );
    }
    console.log(`[Conversation] seeded ${parsed.length} goals from memory`);
  } catch (e) {
    console.warn('[Conversation] seedGoalsFromMemory error:', e);
  }
}



// ── Public API ────────────────────────────────────────────────────────────────

export function isConversationActive(): boolean {
  return conversationActive;
}

export async function triggerConversation(): Promise<void> {
  conversationActive = true;
  let silenceStreak  = 0;

  // Reset per-session buffers
  sessionExchanges.splice(0, sessionExchanges.length);
  turnCount         = 0;
  sessionFacts      = null; // will be populated on first buildSystemPrompt call
  lastResponseType  = 'statement'; // reset so first listen uses full window

  // ── Pre-flight: seed goals from memory if none saved ───────────────────────
  if (!hasGoals()) {
    await seedGoalsFromMemory();
  }

  console.log('[Conversation] loop started');

  // First turn listens for the full 30 s (user hasn't spoken yet).
  // Subsequent turns use a window derived from Axon's last response type.
  let nextListenSecs = 30;

  while (conversationActive) {
    // Closing response → return to idle without listening for more input
    if (nextListenSecs === 0) {
      console.log('[Conversation] closing response — entering linger window');
      orbWin?.webContents.send('orb:state', 'listening');
      const lingerTranscript = await transcribeWithTimeout(6);

      if (lingerTranscript.trim() && !isJunk(lingerTranscript) && !isEcho(lingerTranscript)) {
        console.log('[Conversation] linger follow-up detected, resuming:', lingerTranscript);
        nextListenSecs = 20;
        // process it on next loop iteration
        history.push({ role: 'user', content: lingerTranscript });
      } else {
        console.log('[Conversation] no linger follow-up — returning to idle');
        break;
      }
    }

    orbWin?.webContents.send('orb:state', 'listening');
    console.log(`[Conversation] listening (${nextListenSecs}s window)...`);
    const transcript = await transcribeWithTimeout(nextListenSecs);
    console.log('[Conversation] transcript:', transcript);

    if (!conversationActive) break;

    if (!transcript.trim()) {
      silenceStreak++;
      if (silenceStreak >= 4) {
        console.log(`[Conversation] silence streak ${silenceStreak} — ending`);
        break;
      }
      continue;
    }

    if (isJunk(transcript)) {
      console.log('[Conversation] junk/hallucination — skipping:', transcript);
      continue;
    }

    silenceStreak = 0;

    if (isEcho(transcript)) {
      console.log('[Conversation] echo detected — skipping:', transcript);
      continue;
    }

    if (isSleepWord(transcript)) {
      console.log('[Conversation] sleep word detected — returning to idle');
      orbWin?.webContents.send('orb:state', 'idle');
      orbWin?.webContents.send('axon:activity', 'Gone to sleep');
      break;
    }

    // Auto-detect completions in user speech before sending to Claude
    const autoCompleted = detectCompletionsFromTranscript(transcript);
    if (autoCompleted.length > 0) {
      console.log('[Conversation] auto-marked done:', autoCompleted);
    }

    try {
      orbWin?.webContents.send('orb:state', 'thinking');
      console.log('[Conversation] → Claude:', transcript);
      const response = await sendMessage(transcript);
      console.log('[Conversation] ← Claude:', response);

      // Classify response → sets the listening window for the next turn
      let respType = classifyResponse(response);

      // 🔥 THIS is where your helper lives
      if (respType === 'closing' && shouldKeepConversationAlive(response, transcript)) {
        console.log('[Conversation] overriding closing -> question (active task flow)');
        respType = 'question';
      }

      setLastResponseType(respType);
      nextListenSecs = getListenWindowSecs();
      console.log(`[Conversation] response type: ${respType} → next listen: ${nextListenSecs}s`);
      // Strip markdown before speaking
      const spokenResponse = stripMarkdown(response);
      lastAxonResponse     = spokenResponse;

      // ── Persist this exchange ───────────────────────────────────────────────
      const exchange: Exchange = {
        timestamp:       new Date().toISOString(),
        user:            transcript,
        axon:            response,
        activityContext: getActivitySummary(),
      };
      saveExchange(transcript, response, exchange.activityContext);
      sessionExchanges.push(exchange);
      turnCount++;
      console.log('[Memory] saved exchange, total facts:', getLearnedFacts().length);

      // Every 3 turns, fire-and-forget fact extraction
      if (turnCount % 3 === 0) {
        console.log('[Memory] triggering mid-session fact extraction...');
        extractAndSaveFacts(sessionExchanges.slice(-3)).catch(() => {});
      }

      if (lastSendDidStream) {
        // TTS was already queued sentence-by-sentence during sendMessage.
        // Wait for the full queue to drain before the next listen window opens.
        await waitForSpeakQueue();
      } else {
        await speak(spokenResponse);
        // Belt-and-suspenders: poll until the flag drops
        while (isSpeaking) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      // 200 ms gap
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn('[Conversation] error:', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  conversationActive = false;
  history.splice(0, history.length);

  // Extract facts + commitments from the whole session on close
  if (sessionExchanges.length > 0) {
    console.log('[Memory] end-of-session extraction...');
    extractAndSaveFacts(sessionExchanges).catch(() => {});
    extractCommitmentsFromSession(sessionExchanges).catch(() => {});
  }

  console.log('[Conversation] loop ended');
}

export function stopConversation(): void {
  conversationActive = false;
}

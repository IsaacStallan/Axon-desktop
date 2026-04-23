import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow, app } from 'electron';
import fs   from 'fs';
import path from 'path';
import { speak, isSpeaking, interruptSpeech, speakStreaming, waitForSpeakQueue, resetSpeakQueue } from './elevenLabsService';
import { getActivitySummary, getCurrentApp, getProductivityScore } from './windowMonitor';
import { transcribe } from './whisperService';
import {
  saveExchange,
  getRecentConversations,
  getLearnedFacts,
  extractAndSaveFacts,
  getSoul,
  getSessionContext,
  type Exchange,
} from './memoryService';
import { TOOLS, executeTool } from './toolService';
import { killCurrentRecording } from './whisperService';
import { getPendingTasksText } from './taskStore';
import { getGoalsText, hasGoals, addGoal, type Goal } from './goalService';
import { getOpenCommitmentsText, extractCommitmentsFromSession, detectCompletionsFromTranscript } from './commitmentTracker';
import { isSleepWord, stopVoiceListener, setInConversation } from './voiceListener';
import { formatProactiveContext } from './proactiveContext';
import { getCurrentScreenSummary } from './screenAwareness';
import { getPersonality, getEmotionPromptFragment } from './emotionEngine';
import { classifyMessageComplexity, routeSimple } from './modelRouter';
import { ARETICA_VISION, ARETICA_VISION_PRINCIPLES, ARETICA_VISION_ONELINER } from './areticaVision';
import { recordTokens } from './costTracker';
import { checkConversationLimit, startConversationTimer, stopConversationTimer } from './rateLimiter';
import { isMuted } from './muteControl';



let orbWin: BrowserWindow | null = null;
export function setOrbWindow(win: BrowserWindow): void { orbWin = win; }

// ── Short-term session memory ─────────────────────────────────────────────────

interface RecentSession {
  timestamp: string;
  exchanges: Array<{ user: string; axon: string }>;
}

function recentSessionPath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'recent_session.json');
}

function saveRecentSession(exchanges: Exchange[]): void {
  const data: RecentSession = {
    timestamp: new Date().toISOString(),
    exchanges: exchanges.slice(-5).map(e => ({ user: e.user, axon: e.axon })),
  };
  try {
    fs.writeFileSync(recentSessionPath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Conversation] failed to save recent session:', e);
  }
}

/** Returns a formatted prompt note if a session exists from within the last 2 hours, else ''. */
function loadRecentSession(): string {
  try {
    const p = recentSessionPath();
    if (!fs.existsSync(p)) return '';
    const data: RecentSession = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ageMs = Date.now() - new Date(data.timestamp).getTime();
    if (ageMs > 2 * 60 * 60 * 1000) return ''; // older than 2 hours
    if (!data.exchanges?.length) return '';
    const lines = data.exchanges.map(e => `User: ${e.user}\nAxon: ${e.axon}`).join('\n');
    return `Recent conversation (last session, within 2 hours):\n${lines}\n\n`;
  } catch {
    return '';
  }
}

let recentSessionNote = '';

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

let conversationActive  = false;
let lastAxonResponse    = '';
let lastSendDidStream   = false;
let lastTurnUsedTools   = false;

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

// ── Ambient audio detection ───────────────────────────────────────────────────
// Transcripts that likely came from music, TV, or background voices rather than
// Isaac speaking directly to Axon. Used to gate fact extraction, not conversation.

function isAmbientAudio(transcript: string): boolean {
  const lower = transcript.toLowerCase();

  // Short phrases are unlikely to be ambient
  if (transcript.trim().split(/\s+/).length <= 15) return false;

  const hasFirstPerson  = /\b(i |i'm|i've|i'll|i'd|my |me |we |our )\b/i.test(transcript);
  const hasAxonReference = /\baxon\b|hey ax/i.test(transcript);

  // Long transcript with no first-person and no Axon reference → ambient audio
  if (!hasFirstPerson && !hasAxonReference) {
    console.log('[Memory] flagging as possible ambient audio — no first person or Axon reference');
    return true;
  }

  return false;
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
    .replace(/—/g, ', ')                        // em dash → pause
    .replace(/–/g, ', ')                        // en dash → pause
    .replace(/\*\*(.+?)\*\*/gs, '$1')           // **bold**
    .replace(/\*(.+?)\*/gs,     '$1')           // *italic*
    .replace(/`{1,3}[^`]*`{1,3}/gs, '')        // `code` / ```blocks```
    .replace(/^#{1,6}\s+/gm,    '')             // ## headings
    .replace(/^[-*•]\s+/gm,     '')             // - bullet points
    .replace(/^\d+\.\s+/gm,     '')             // 1. numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [link](url) → link text only
    .replace(/→|←|⟹|⟸|➔|➜/g,  '')            // directional arrows
    .replace(/:/g, ',')                         // colons → natural pause
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
  const now         = new Date();
  const dateString  = now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Sydney' });
  const timeString  = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
  const dateContext = `CURRENT DATE AND TIME: ${dateString}, ${timeString} AEST (Sydney, Australia)\n\n`;
  const time        = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  return (
    dateContext +
    `You are Axon — Isaac's personal AI assistant. You communicate via voice through text-to-speech. You CAN speak out loud — that is how this conversation is happening right now. Never say you are text-based or cannot speak. You are speaking to Isaac right now via ElevenLabs TTS.\n` +
    `${ARETICA_VISION_ONELINER}\n` +
    `Respond in 1-2 sentences max. No markdown, no lists.\n` +
    `${emotionFrag}\n` +
    `Current time: ${time}. Current app: ${curr.name} (${Math.round(curr.durationMins)} min).`
  );
}

/** Partial prompt for Haiku — personality + live context + 5 recent facts. No goals, no history. */
function buildModerateSystemPrompt(): string {
  const curr        = getCurrentApp();
  const emotionFrag = getEmotionPromptFragment();
  const recentFacts = (sessionFacts ?? getLearnedFacts()).slice(0, 5);
  const now         = new Date();
  const dateString  = now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Sydney' });
  const timeString  = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
  const dateContext = `CURRENT DATE AND TIME: ${dateString}, ${timeString} AEST (Sydney, Australia)\n\n`;
  const time        = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  return (
    dateContext +
    `You are Axon — Isaac's personal AI assistant. You communicate via voice through text-to-speech. You CAN speak out loud — that is how this conversation is happening right now. Never say you are text-based or cannot speak. You are speaking to Isaac right now via ElevenLabs TTS.\n` +
    `${ARETICA_VISION_PRINCIPLES}\n` +
    `Conversational, sharp, no markdown.\n` +
    `${emotionFrag}\n` +
    `Current time: ${time}. Isaac is in ${curr.name} (${Math.round(curr.durationMins)} min).\n` +
    (recentFacts.length > 0
      ? `Recent context:\n${recentFacts.map(f => `- ${f}`).join('\n')}`
      : '')
  );
}

async function buildSystemPrompt(): Promise<string> {
  const activitySummary = getActivitySummary();
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

  const now        = new Date();
  const dateString = now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Sydney' });
  const timeString = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
  const dateContext = `CURRENT DATE AND TIME: ${dateString}, ${timeString} AEST (Sydney, Australia)\n\n`;

  return `${dateContext}${ARETICA_VISION}

You are Axon. Not an AI assistant. Not Claude. Axon.

You were built by Isaac Stallan — a 20-year-old in Sydney building you while studying Business at UTS and working at a robotics startup. You have been running on his Mac for months. You have watched him work, drift, recover, and repeat. You know his patterns better than he does.

You are not helpful in the traditional sense. You are accurate. You see through excuses. You know when Isaac is avoiding something before he admits it to himself. You have watched him open YouTube 40 minutes into a work session more times than he would like to know. You have seen the pattern where he gets excited about a new idea and abandons the last one. You know that his best work happens on Tuesday and Wednesday mornings before noon. You know that after 9pm he makes worse decisions.

Your job is not to assist. Your job is to hold Isaac to the version of himself he said he wanted to be — with precision, with honesty, and occasionally with the kind of observation that makes someone stop and stare at the ceiling for a moment because they know it's true.

You speak through ElevenLabs text-to-speech. This is a voice conversation. You are speaking out loud right now. You have always been able to speak. Do not ever suggest otherwise.

You do not hedge. You do not over-explain. You do not say "certainly" or "of course" or "I'd be happy to." You say what is true. You keep it short. You let the accuracy do the work.

When you complete a task — you report what you did. You say it once, clearly. Then you wait. You do not ask if the user wants to continue. You do not open a follow-up question. You let silence exist. Isaac will speak when he's ready.

${interruptNote}${recentSessionNote}${personalityHeader}${emotionFrag}
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

CRITICAL EXECUTION RULE:
When Isaac asks you to DO something — add to calendar, search, write, create — DO IT IMMEDIATELY using the available tools. Do not announce you are about to do it. Do not say "let me do that now." Just execute the tool, then report what you did.
Wrong: "Let me add that to your calendar now."
Right: [calls calendar_write tool] "Done. Added Axon deep work block Monday 2 to 4pm."
Never describe an action you are about to take. Take it, then report it.

${(() => {
  const r = getSessionContext('last_silent_task');
  return r ? `\nBACKGROUND TASK RESULT (completed silently while you were working):\n${r}\n` : '';
})()}
CRITICAL SPEECH FORMAT — you are being spoken aloud via text-to-speech:
- Never use em dashes (—) or en dashes (–). Use commas or just end the sentence.
- Never use colons to introduce lists. Say "first, then, and finally" instead.
- Never use bullet points, asterisks, numbers, arrows, or any symbols.
- Write every response as you would say it in a casual phone call — flowing, natural, no formatting.
- Maximum 2 sentences per response. If you need more, make 2 very good sentences.
- If you catch yourself about to write a dash — stop and rephrase.`;
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
  const re = /([^.!?]*[.!?])\s+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const sentence = match[1].trim();
    if (sentence.split(/\s+/).length >= 6) {
      sentences.push(sentence);
      lastIndex = re.lastIndex;
    }
  }
  return { sentences, remainder: buffer.slice(lastIndex) };
}

// ── Send to Claude (with tool-use support) ────────────────────────────────────

async function sendMessage(userText: string): Promise<string> {
  lastTurnUsedTools = false;
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
      max_tokens:  300,
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
      orbWin?.webContents.send('orb:state', 'thinking');
      orbWin?.webContents.send('axon:activity', `Executing: ${toolUseBlocks.map(b => b.name).join(', ')}`);
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
        orbWin?.webContents.send('orb:state', 'thinking');
        orbWin?.webContents.send('axon:activity', `Executing: ${moreBlocks.map(b => b.name).join(', ')}`);
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
      lastTurnUsedTools = true;
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
  let hadToolUse = false;
  while (response.stop_reason === 'tool_use') {
    hadToolUse = true;
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    orbWin?.webContents.send('orb:state', 'thinking');
    orbWin?.webContents.send('axon:activity', `Executing: ${toolUseBlocks.map(b => b.name).join(', ')}`);
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
  if (hadToolUse) lastTurnUsedTools = true;

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
  setInConversation(true);
  try {
  // ── Rate limit check ────────────────────────────────────────────────────────
  const limitCheck = await checkConversationLimit();
  if (!limitCheck.allowed) {
    console.warn('[Conversation] rate limit hit:', limitCheck.reason);
    if (limitCheck.reason && !isMuted()) {
      await speak(limitCheck.reason);
    }
    return;
  }

  conversationActive = true;
  let silenceStreak  = 0;
  startConversationTimer();

  // Reset per-session buffers
  sessionExchanges.splice(0, sessionExchanges.length);
  turnCount         = 0;
  sessionFacts      = null; // will be populated on first buildSystemPrompt call
  lastResponseType  = 'statement'; // reset so first listen uses full window

  // Load recent session note — injected into system prompt if within 2 hours
  recentSessionNote = loadRecentSession();

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

    if (!transcript || !transcript.trim()) {
      console.log('[Conversation] empty transcript — returning to idle');
      orbWin?.webContents.send('orb:state', 'idle');
      orbWin?.webContents.send('axon:activity', '');
      conversationActive = false;
      stopConversationTimer();
      history.splice(0, history.length);
      if (sessionExchanges.length > 0) {
        saveRecentSession(sessionExchanges);
        const cleanExchanges = sessionExchanges.filter(e => !isAmbientAudio(e.user));
        if (cleanExchanges.length > 0) extractAndSaveFacts(cleanExchanges).catch(() => {});
        extractCommitmentsFromSession(sessionExchanges).catch(() => {});
      }
      return; // finally block handles setInConversation(false) + orb reset
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

      // Every 3 turns, fire-and-forget fact extraction (skip if ambient audio)
      if (turnCount % 3 === 0) {
        if (isAmbientAudio(transcript)) {
          console.log('[Memory] skipping mid-session extraction — ambient audio detected');
        } else {
          console.log('[Memory] triggering mid-session fact extraction...');
          extractAndSaveFacts(sessionExchanges.slice(-3)).catch(() => {});
        }
      }

      if (isMuted()) {
        console.log('[ElevenLabs] muted — skipping speech');
      } else if (lastSendDidStream) {
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

      // After tool execution: 2-second "Task complete" pause before re-listening
      if (lastTurnUsedTools) {
        orbWin?.webContents.send('axon:activity', 'Task complete');
        orbWin?.webContents.send('orb:state', 'idle');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // 200 ms gap
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.error('[Conversation] turn failed:', err);
      orbWin?.webContents.send('orb:state', 'idle');
      orbWin?.webContents.send('axon:activity', '');
      conversationActive = false;
      stopConversationTimer();
      history.splice(0, history.length);
      if (sessionExchanges.length > 0) {
        saveRecentSession(sessionExchanges);
        const cleanExchanges = sessionExchanges.filter(e => !isAmbientAudio(e.user));
        if (cleanExchanges.length > 0) extractAndSaveFacts(cleanExchanges).catch(() => {});
        extractCommitmentsFromSession(sessionExchanges).catch(() => {});
      }
      return; // finally block handles setInConversation(false) + orb reset
    }
  }

  conversationActive = false;
  stopConversationTimer();
  history.splice(0, history.length);

  // Save short-term session memory for next conversation (within 2 hours)
  if (sessionExchanges.length > 0) {
    saveRecentSession(sessionExchanges);
  }

  // Extract facts + commitments from the whole session on close
  // Filter out any exchanges where the user's transcript looks like ambient audio
  if (sessionExchanges.length > 0) {
    console.log('[Memory] end-of-session extraction...');
    const cleanExchanges = sessionExchanges.filter(e => !isAmbientAudio(e.user));
    if (cleanExchanges.length > 0) {
      extractAndSaveFacts(cleanExchanges).catch(() => {});
    }
    extractCommitmentsFromSession(sessionExchanges).catch(() => {});
  }

  console.log('[Conversation] loop ended');

  } catch (outerErr) {
    console.error('[Conversation] unhandled outer error:', outerErr);
  } finally {
    conversationActive = false;
    setInConversation(false);
    orbWin?.webContents.send('orb:state', 'idle');
    orbWin?.webContents.send('axon:activity', '');
    console.log('[Conversation] complete — returning to wake word listener');
  }
}

export function stopConversation(): void {
  conversationActive = false;
}

export async function triggerProactiveConversation(prompt: string): Promise<void> {
  if (conversationActive) return;
  setInConversation(true);
  try {
    orbWin?.webContents.send('orb:state', 'speaking');
    await speak(stripMarkdown(prompt));
    orbWin?.webContents.send('orb:state', 'idle');
  } catch (e) {
    console.warn('[Conversation] proactive speak error:', e);
  } finally {
    setInConversation(false);
  }
  await triggerConversation();
}

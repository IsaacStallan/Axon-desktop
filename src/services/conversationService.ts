import Anthropic from '@anthropic-ai/sdk';
import { speak, isSpeaking } from './elevenLabsService';
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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// Use the SDK's MessageParam so history can hold tool-use and tool-result blocks
// as well as plain text — both formats are valid MessageParam content.
type Message = Anthropic.MessageParam;

const history: Message[] = [];
const MAX_HISTORY = 20; // raised from 12 — tool calls add extra turns to history

let conversationActive = false;
let lastAxonResponse   = '';

// Buffers for memory — reset at the start of each conversation session
const sessionExchanges: Exchange[] = [];
let   turnCount = 0;

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
// On timeout, kills the hung SoX process via taskkill so the audio device is
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

function buildSystemPrompt(): string {
  const goal            = process.env.AXON_USER_GOAL ?? 'build a successful business and personal empire';
  const activitySummary = getActivitySummary();
  const timeOfDay       = getTimeOfDay();
  const recentHistory   = getRecentConversations(3);
  const facts           = getLearnedFacts();
  const soul            = getSoul();

  return `You are Axon — an AI inspired by JARVIS from Iron Man, built specifically for Isaac.
${soul ? `\n== YOUR SOUL (generated from memory — follow this above all else) ==\n${soul}\n== END SOUL ==\n` : ''}

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

What Axon knows about Isaac (learned over time):
${facts.length > 0 ? facts.map(f => `- ${f}`).join('\n') : '- No persistent facts recorded yet.'}

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

// ── Send to Claude (with tool-use support) ────────────────────────────────────

async function sendMessage(userText: string): Promise<string> {
  history.push({ role: 'user', content: userText });
  trimHistory();

  // First call — Claude may respond with text or decide to use a tool
  let response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,   // higher budget so tool_use blocks don't get cut off
    tools:      TOOLS,
    system:     buildSystemPrompt(),
    messages:   history,
  });

  // ── Tool-use loop ──────────────────────────────────────────────────────────
  // Claude can chain multiple tool calls; we resolve each one before continuing.
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    // Add Claude's tool-use turn to history
    history.push({ role: 'assistant', content: response.content });

    // Execute every tool Claude requested and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(
          block.name,
          block.input as Record<string, string>,
        );
        console.log(`[Tool] ${block.name} → ${result}`);
        return {
          type:        'tool_result' as const,
          tool_use_id: block.id,
          content:     result,
        };
      }),
    );

    // Feed results back to Claude so it can compose a spoken reply
    history.push({ role: 'user', content: toolResults });
    trimHistory();

    response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 180,   // spoken reply should stay short
      tools:      TOOLS,
      system:     buildSystemPrompt(),
      messages:   history,
    });
  }

  // ── Extract the final spoken reply ────────────────────────────────────────
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const reply     = textBlock?.text.trim() ?? "Done.";

  history.push({ role: 'assistant', content: reply });
  trimHistory();

  return reply;
}

function trimHistory(): void {
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function triggerConversation(): Promise<void> {
  conversationActive = true;
  let silenceStreak  = 0;

  // Reset per-session buffers
  sessionExchanges.splice(0, sessionExchanges.length);
  turnCount = 0;

  console.log('[Conversation] loop started');

  while (conversationActive) {
    console.log('[Conversation] listening...');

    // 8-second recording window per turn — long enough for a full sentence.
    // Hard-capped at 20 s so a hung SoX process never freezes the loop.
    const transcript = await transcribeWithTimeout(8);
    console.log('[Conversation] transcript:', transcript);

    if (!conversationActive) break;

    if (!transcript.trim()) {
      silenceStreak++;
      if (silenceStreak >= 4) {
        console.log('[Conversation] 2-min silence — ending');
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

    const lower = transcript.toLowerCase();
    if (lower.includes('bye axon') || lower.includes('stop listening') || lower.includes('goodbye axon')) {
      console.log('[Conversation] stop phrase detected');
      break;
    }

    try {
      console.log('[Conversation] → Claude:', transcript);
      const response = await sendMessage(transcript);
      console.log('[Conversation] ← Claude:', response);

      // Strip markdown before speaking — ElevenLabs reads asterisks and bullets
      // literally, and special Unicode arrows break the PowerShell playback script
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

      await speak(spokenResponse);

      // Belt-and-suspenders: poll until the flag drops
      while (isSpeaking) {
        await new Promise(r => setTimeout(r, 100));
      }

      // 200 ms gap — just enough for room reverb to decay.
      // Combined with the PS1 Ceiling() buffer, total dead time ≈ 200 ms so
      // Isaac can reply almost immediately after Axon finishes speaking.
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn('[Conversation] error:', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  conversationActive = false;
  history.splice(0, history.length);

  // Extract facts from the whole session on close — catches anything missed
  // by the mid-session extractions
  if (sessionExchanges.length > 0) {
    console.log('[Memory] end-of-session fact extraction...');
    extractAndSaveFacts(sessionExchanges).catch(() => {});
  }

  console.log('[Conversation] loop ended');
}

export function stopConversation(): void {
  conversationActive = false;
}

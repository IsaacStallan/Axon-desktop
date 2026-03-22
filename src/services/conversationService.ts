import Anthropic from '@anthropic-ai/sdk';
import { speak, isSpeaking } from './elevenLabsService';
import { getActivitySummary, getCurrentApp, getProductivityScore } from './windowMonitor';
import { transcribe } from './whisperService';

const client     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

type Message = { role: 'user' | 'assistant'; content: string };

const history: Message[] = [];
const MAX_HISTORY = 12;

let conversationActive = false;
let lastAxonResponse   = '';

// ── Echo detection ────────────────────────────────────────────────────────────

function firstNWords(text: string, n: number): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).slice(0, n).join(' ');
}

function isEcho(transcript: string): boolean {
  if (!lastAxonResponse || transcript.length < 8) return false;
  const needle = firstNWords(lastAxonResponse, 4);
  if (needle.split(' ').filter(Boolean).length < 3) return false;
  return transcript.toLowerCase().includes(needle);
}

// ── Send to Claude ────────────────────────────────────────────────────────────

async function sendMessage(userText: string): Promise<string> {
  const ctx     = getCurrentApp();
  const summary = getActivitySummary();
  const score   = getProductivityScore();

  history.push({ role: 'user', content: userText });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 180,
    system:
      `You are Axon — an ambient AI presence running on Isaac's PC. You are direct, warm, no fluff. ` +
      `Current context: Isaac is using ${ctx.name} (${ctx.label}) for ${Math.round(ctx.durationMins)} minutes. ` +
      `${summary}. Productivity score: ${score}%. ` +
      `Respond in 1–2 sentences max. Like a mate who's always in his corner. No affirmations.`,
    messages: history,
  });

  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const reply = block?.text.trim() ?? "I didn't catch that.";

  history.push({ role: 'assistant', content: reply });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  return reply;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function triggerConversation(): Promise<void> {
  conversationActive = true;
  let silenceStreak  = 0;

  console.log('[Conversation] loop started');

  while (conversationActive) {
    console.log('[Conversation] listening...');

    // 8-second recording window per turn — long enough for a full sentence
    const transcript = await transcribe(8);
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

    silenceStreak = 0;

    if (isEcho(transcript)) {
      console.log('[Conversation] echo detected — skipping');
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

      lastAxonResponse = response;
      await speak(response);

      // Belt-and-suspenders: poll until the flag drops
      while (isSpeaking) {
        await new Promise(r => setTimeout(r, 100));
      }

      // 1.5 s gap so room reverb decays before the mic opens again
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn('[Conversation] error:', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  conversationActive = false;
  history.splice(0, history.length);
  console.log('[Conversation] loop ended');
}

export function stopConversation(): void {
  conversationActive = false;
}

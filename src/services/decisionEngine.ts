import Anthropic from '@anthropic-ai/sdk';
import { speak } from './elevenLabsService';
import { getCurrentApp, getActivitySummary, getProductivityScore } from './windowMonitor';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

type OrbState = 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent';
type SetState = (s: OrbState) => void;

const POLL_INTERVAL_MS          = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVENTION_GAP_MS   = 20 * 60 * 1000; // 20 minutes between interventions
let   lastInterventionTime       = 0;

// ── Decision call ─────────────────────────────────────────────────────────────

async function shouldIntervene(): Promise<{ intervene: boolean; message: string } | null> {
  const ctx     = getCurrentApp();
  const summary = getActivitySummary();
  const score   = getProductivityScore();
  const hour    = new Date().getHours();

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 120,
      system:
        `You are Axon's decision engine. Isaac is a 20-year-old entrepreneur. ` +
        `Decide if he needs an intervention RIGHT NOW. ` +
        `Be sparing — only intervene if genuinely necessary. ` +
        `Response must be valid JSON only: {"intervene": true/false, "message": "short spoken message or empty"}`,
      messages: [{
        role:    'user',
        content:
          `Current app: ${ctx.name} (${ctx.label}), open for ${Math.round(ctx.durationMins)} min.\n` +
          `${summary}\n` +
          `Productivity score: ${score}%\n` +
          `Time: ${hour}:00\n` +
          `Should Axon intervene?`,
      }],
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) return null;

    // Strip markdown code fences Claude sometimes wraps around JSON responses
    const cleaned = block.text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i,     '')
      .replace(/```\s*$/i,     '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('[DecisionEngine] JSON parse failed. Raw response:', block.text.trim());
      return null;
    }
  } catch (e) {
    console.warn('[DecisionEngine] API error:', e);
    return null;
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

export function startDecisionLoop(setOrbState: SetState): void {
  setInterval(poll, POLL_INTERVAL_MS);
}

async function poll(): Promise<void> {
  const now = Date.now();
  if (now - lastInterventionTime < MIN_INTERVENTION_GAP_MS) return;

  const decision = await shouldIntervene();
  if (!decision?.intervene || !decision.message) return;

  lastInterventionTime = now;
  console.log('[DecisionEngine] intervening:', decision.message);

  // Flash the orb urgent — we can't easily call setOrbState here without
  // circular deps so we emit via the main process IPC
  try {
    await speak(decision.message);
  } catch (e) {
    console.warn('[DecisionEngine] speak failed:', e);
  }
}

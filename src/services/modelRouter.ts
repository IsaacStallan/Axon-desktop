import Anthropic from '@anthropic-ai/sdk';

// ── Types ──────────────────────────────────────────────────────────────────────

export type MessageComplexity = 'simple' | 'moderate' | 'complex';

export type TaskType =
  | 'simple_reminder'   // Tier 1 — Ollama llama3.2:3b (free, local, zero latency)
  | 'intervention'      // Tier 2 — Claude Haiku
  | 'break_suggestion'  // Tier 2 — Claude Haiku
  | 'conversation'      // Tier 3 — Claude Sonnet
  | 'goal_analysis'     // Tier 3 — Claude Sonnet
  | 'weekly_review'     // Tier 4 — Claude Opus
  | 'pattern_analysis'; // Tier 2 — Claude Haiku

export interface RouteOptions {
  taskType:   TaskType;
  system:     string;
  prompt:     string;
  maxTokens?: number;
}

// ── Model assignments ──────────────────────────────────────────────────────────

type Tier = 'ollama' | 'haiku' | 'sonnet' | 'opus';

const TIER_MAP: Record<TaskType, Tier> = {
  simple_reminder:  'ollama',
  intervention:     'haiku',
  break_suggestion: 'haiku',
  pattern_analysis: 'haiku',
  conversation:     'sonnet',
  goal_analysis:    'sonnet',
  weekly_review:    'opus',
};

const ANTHROPIC_MODELS: Record<Exclude<Tier, 'ollama'>, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6',
};

// ── Conversation message complexity classifier ─────────────────────────────────
// Pure heuristics — no API call. Runs before every conversation turn.

const GREETING_RE     = /^(hey|hello|hi|axon|what'?s up|you there|morning|evening)\b\.?$/i;
const CONFIRM_RE      = /^(yes|no|ok|okay|sure|yep|nope|nah|sounds good|do it|go ahead|got it|perfect|thanks|thank you|cool|great|nice|done|fine)\b\.?$/i;
const STATUS_RE       = /^(what time is it|what am i doing|how long have i been|what'?s the time|what day is it|what are you doing)\b/i;
const COMPLEX_KW_RE   = /\b(plan|strategy|build|creat|implement|design|analy[sz]|write|review|explain|help me|(how|what|why) (do|can|should|is|are|did)|goal|project|business|decision|should i|think about|advice|cod(e|ing)|debug|fix|optim|architect|structur|strateg|priorit|reflect|weekly|monthly)\b/i;

/**
 * Classifies a user message into simple / moderate / complex before any API call.
 * Pass historyLength (turns already in session) so in-session confirmations are
 * promoted to moderate rather than being sent to Ollama with no context.
 */
export function classifyMessageComplexity(
  transcript:    string,
  historyLength: number = 0,
): MessageComplexity {
  const trimmed   = transcript.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // Complex thresholds — always Sonnet
  if (wordCount > 25)              return 'complex';
  if (COMPLEX_KW_RE.test(trimmed)) return 'complex';

  // Simple — only safe to use Ollama when there's no session context
  if (historyLength === 0) {
    if (GREETING_RE.test(trimmed))  return 'simple';
    if (STATUS_RE.test(trimmed))    return 'simple';
    if (CONFIRM_RE.test(trimmed) && wordCount <= 4) return 'simple';
  }

  // In-session confirmations need tool capability → moderate
  if (CONFIRM_RE.test(trimmed) && historyLength > 0) return 'moderate';

  // Default: 1-25 words without complex keywords
  return 'moderate';
}

// ── Call tracking + monthly cost estimation ────────────────────────────────────

interface CallStats { ollama: number; haiku: number; sonnet: number; opus: number }

const callCounts: CallStats  = { ollama: 0, haiku: 0, sonnet: 0, opus: 0 };
const sessionStartMs         = Date.now();

// Rough average cost per call (estimated input + output at published pricing)
const COST_PER_CALL: Record<keyof CallStats, number> = {
  ollama: 0,
  haiku:  0.00022,   // ~600 input × $0.00025/1K + 150 output × $0.00125/1K
  sonnet: 0.0085,    // ~2200 input × $0.003/1K  + 350 output × $0.015/1K
  opus:   0.048,     // ~2000 input × $0.015/1K  + 500 output × $0.075/1K
};

function logMonthlyCostEstimate(): void {
  const sessionHours = Math.max((Date.now() - sessionStartMs) / 3_600_000, 0.01);
  const sessionCost  = (Object.keys(callCounts) as (keyof CallStats)[])
    .reduce((sum, t) => sum + callCounts[t] * COST_PER_CALL[t], 0);
  const monthly      = (sessionCost / sessionHours) * 12 * 30; // 12 h/day × 30 days
  const total        = Object.values(callCounts).reduce((a, b) => a + b, 0);
  console.log(
    `[ModelRouter] monthly estimate: ~$${monthly.toFixed(2)} ` +
    `(${callCounts.ollama} Ollama / ${callCounts.haiku} Haiku / ` +
    `${callCounts.sonnet} Sonnet / ${callCounts.opus} Opus — ${total} calls this session)`,
  );
}

setInterval(logMonthlyCostEstimate, 3_600_000);

// ── Ollama (Tier 1) ────────────────────────────────────────────────────────────

const OLLAMA_URL     = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL   = 'llama3.2:3b';
const OLLAMA_TIMEOUT = 8_000;  // hard cap — interventions can't afford to wait

interface OllamaResponse {
  response: string;
  done:     boolean;
}

async function callOllama(system: string, prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);

    const res = await fetch(OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:  OLLAMA_MODEL,
        prompt: `${system}\n\n${prompt}`,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[ModelRouter] Ollama HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as OllamaResponse;
    const text = data.response?.trim();
    return text || null;
  } catch (e) {
    // Ollama not running, port closed, or timed out — this is expected when offline
    console.warn('[ModelRouter] Ollama unavailable:', (e as Error).message.slice(0, 60));
    return null;
  }
}

// ── Anthropic (Tiers 2–4) ─────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

async function callAnthropic(
  model:     string,
  system:    string,
  prompt:    string,
  maxTokens: number,
): Promise<string> {
  const resp = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages:   [{ role: 'user', content: prompt }],
  });
  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return block?.text.trim() ?? '';
}

// ── Public: route ──────────────────────────────────────────────────────────────

/**
 * Routes a generation request to the correct model tier.
 *
 * Tier 1 (Ollama llama3.2:3b):  simple_reminder — local, free, <1s
 * Tier 2 (Claude Haiku):         intervention, break_suggestion, pattern_analysis
 * Tier 3 (Claude Sonnet):        conversation, goal_analysis
 * Tier 4 (Claude Opus):          weekly_review
 *
 * If Ollama is unavailable, Tier 1 automatically falls back to Haiku.
 * Never throws — always returns a string.
 */
export async function route(opts: RouteOptions): Promise<string> {
  const { taskType, system, prompt, maxTokens = 120 } = opts;
  const tier = TIER_MAP[taskType];

  console.log(`[ModelRouter] ${taskType} → ${tier}`);

  if (tier === 'ollama') {
    const ollamaResult = await callOllama(system, prompt);
    if (ollamaResult) {
      callCounts.ollama++;
      return ollamaResult;
    }
    // Fallback to Haiku — silent, automatic
    console.log('[ModelRouter] Ollama → Haiku fallback');
    callCounts.haiku++;
    return callAnthropic(ANTHROPIC_MODELS.haiku, system, prompt, maxTokens);
  }

  if (tier === 'haiku')  callCounts.haiku++;
  if (tier === 'sonnet') callCounts.sonnet++;
  if (tier === 'opus')   callCounts.opus++;

  return callAnthropic(ANTHROPIC_MODELS[tier], system, prompt, maxTokens);
}

// ── Conversation simple turn (Ollama → Haiku → Sonnet fallback chain) ─────────

/**
 * Routes a simple conversation turn with a minimal system prompt.
 * Tries Ollama first (free, local), falls back to Haiku, then Sonnet.
 * Never throws.
 */
export async function routeSimple(system: string, userText: string): Promise<string> {
  // Try Ollama
  const ollamaResult = await callOllama(system, userText);
  if (ollamaResult) {
    callCounts.ollama++;
    return ollamaResult;
  }

  // Fallback: Haiku
  console.log('[ModelRouter] simple → Ollama unavailable, falling back to Haiku');
  try {
    callCounts.haiku++;
    return await callAnthropic(ANTHROPIC_MODELS.haiku, system, userText, 100);
  } catch {
    // Ultimate fallback: Sonnet
    console.log('[ModelRouter] simple → Haiku failed, falling back to Sonnet');
    callCounts.sonnet++;
    return await callAnthropic(ANTHROPIC_MODELS.sonnet, system, userText, 100);
  }
}

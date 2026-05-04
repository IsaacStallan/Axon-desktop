import Anthropic from '@anthropic-ai/sdk';

const AXON_CORE_MODE   = process.env.AXON_CORE_MODE === 'true';
const LOCAL_MODEL_NAME = process.env.AXON_LOCAL_MODEL ?? 'axon-personal';

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
  taskType:         TaskType;
  system:           string;
  prompt:           string;
  maxTokens?:       number;
  /** Set true when tool calls are expected (research, search, browser tasks). */
  requiresToolUse?: boolean;
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

// ── Tool-use detection ─────────────────────────────────────────────────────────

const TOOL_USE_KW_RE = /\b(search|look up|find|research|browse|open|visit|go to|check|wikipedia|bing|google|web|url|http|news|weather|stock|price|latest|current|today'?s|who is|what is the|where is|when (did|is|was)|how (much|many)|reddit|youtube)\b/i;

/**
 * Returns true if the request should be forced to Sonnet because tool use
 * is expected — either via the explicit flag or by keyword heuristics on the
 * prompt, or because a previous assistant turn invoked tools.
 */
export function requiresToolUse(
  prompt:               string,
  explicitFlag:         boolean = false,
  prevAssistantUsedTools: boolean = false,
): boolean {
  return explicitFlag || prevAssistantUsedTools || TOOL_USE_KW_RE.test(prompt);
}

const GREETING_RE     = /^(hey|hello|hi|axon|what'?s up|you there|morning|evening)\b\.?$/i;
const CONFIRM_RE      = /^(yes|no|ok|okay|sure|yep|nope|nah|sounds good|do it|go ahead|got it|perfect|thanks|thank you|cool|great|nice|done|fine)\b\.?$/i;
const STATUS_RE       = /^(what time is it|what am i doing|how long have i been|what'?s the time|what day is it|what are you doing)\b/i;
const COMPLEX_KW_RE   = /\b(plan|strategy|build|creat|implement|design|analy[sz]|write|review|explain|help me|(how|what|why) (do|can|should|is|are|did)|goal|project|business|decision|should i|think about|advice|cod(e|ing)|debug|fix|optim|architect|structur|strateg|priorit|reflect|weekly|monthly)\b/i;

// ── Tool-intent classifier ─────────────────────────────────────────────────────
// If Isaac is asking Axon to DO something that requires a tool — always Sonnet.
// Haiku and free tiers don't reliably execute tools autonomously.

const TOOL_INTENT_PATTERNS = [
  /add (to|it to|that to|this to)/i,
  /put (it|that|this) (in|on|into)/i,
  /schedule|calendar|remind|block out|lock in/i,
  /search for|find me|look up|research/i,
  /create|write|draft|build|make me/i,
  /open|close|play|pause|stop/i,
  /lock me out|soft lock|gym time/i,
];

function hasToolIntent(text: string): boolean {
  return TOOL_INTENT_PATTERNS.some(p => p.test(text));
}

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

  // Tool-intent check — always Sonnet; it's the only model that reliably executes tools
  if (hasToolIntent(trimmed)) {
    console.log('[ModelRouter] tool intent detected → complex (Sonnet)');
    return 'complex';
  }

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

// ── Tier 0: axon-personal fine-tuned model (AXON_CORE_MODE only) ──────────────

interface OllamaChatResponse {
  message?: { content?: string };
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

export async function routeAxonLocal(
  systemPrompt: string,
  userMessage:  string,
): Promise<string | null> {
  if (!AXON_CORE_MODE) return null;

  try {
    const healthCheck = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);

    if (!healthCheck?.ok) {
      console.log('[ModelRouter] Ollama not running — skipping local model');
      return null;
    }

    const models = await healthCheck.json() as OllamaTagsResponse;
    const hasAxonModel = models.models?.some(m => m.name.includes(LOCAL_MODEL_NAME));

    if (!hasAxonModel) {
      console.log('[ModelRouter] axon-personal model not found — skipping');
      return null;
    }

    const response = await fetch('http://localhost:11434/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    LOCAL_MODEL_NAME,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage },
        ],
        stream:  false,
        options: { temperature: 0.7, num_predict: 150, top_p: 0.9, repeat_penalty: 1.1 },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data   = await response.json() as OllamaChatResponse;
    const result = data.message?.content?.trim();
    if (!result || result.length < 3) return null;

    console.log('[ModelRouter] tier0 → axon-personal (local)');
    callCounts.ollama++;
    return result;
  } catch (err) {
    console.log('[ModelRouter] local model failed — falling through:', (err as Error).message.slice(0, 60));
    return null;
  }
}

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

// ── Groq (llama-3.1-8b-instant — free tier, extremely fast) ──────────────────

const GROQ_TIMEOUT = 10_000;

async function callGroq(system: string, prompt: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT);

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        messages:    [
          { role: 'system', content: system },
          { role: 'user',   content: prompt },
        ],
        max_tokens:  300,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[ModelRouter] Groq HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    console.warn('[ModelRouter] Groq unavailable:', (e as Error).message.slice(0, 60));
    return null;
  }
}

// ── Gemini Flash (Google — generous free tier) ────────────────────────────────

const GEMINI_TIMEOUT = 12_000;

async function callGeminiFlash(system: string, prompt: string): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: `${system}\n\nUser: ${prompt}` }] },
          ],
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[ModelRouter] Gemini HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || null;
  } catch (e) {
    console.warn('[ModelRouter] Gemini unavailable:', (e as Error).message.slice(0, 60));
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
 * Tier 1 (Ollama → Groq → Haiku): simple_reminder
 * Tier 2 (Groq → Haiku):          intervention, break_suggestion, pattern_analysis
 * Tier 3 (Claude Sonnet):          conversation, goal_analysis
 * Tier 4 (Sonnet → Gemini Flash):  weekly_review
 *
 * All fallbacks are silent — never crashes.
 */
export async function route(opts: RouteOptions): Promise<string> {
  const { taskType, system, prompt, maxTokens = 120, requiresToolUse: needsTools = false } = opts;
  let tier = TIER_MAP[taskType];

  // Tool-use override: Haiku and Ollama cannot invoke tools — force Sonnet.
  if ((tier === 'haiku' || tier === 'ollama') && requiresToolUse(prompt, needsTools)) {
    console.log(`[ModelRouter] ${taskType} → ${tier} → sonnet (tool-use override)`);
    callCounts.sonnet++;
    return callAnthropic(ANTHROPIC_MODELS.sonnet, system, prompt, maxTokens);
  }

  console.log(`[ModelRouter] ${taskType} → ${tier}`);

  if (tier === 'ollama') {
    const ollamaResult = await callOllama(system, prompt);
    if (ollamaResult) { callCounts.ollama++; return ollamaResult; }
    const groqResult = await callGroq(system, prompt);
    if (groqResult) { callCounts.haiku++; return groqResult; }
    console.log('[ModelRouter] Ollama/Groq → Haiku fallback');
    callCounts.haiku++;
    return callAnthropic(ANTHROPIC_MODELS.haiku, system, prompt, maxTokens);
  }

  if (tier === 'haiku') {
    // Interventions: Groq first (free, fast) → Haiku fallback
    const groqResult = await callGroq(system, prompt);
    if (groqResult) { callCounts.haiku++; return groqResult; }
    console.log(`[ModelRouter] ${taskType} → Groq unavailable, falling back to Haiku`);
    callCounts.haiku++;
    return callAnthropic(ANTHROPIC_MODELS.haiku, system, prompt, maxTokens);
  }

  if (tier === 'sonnet') {
    callCounts.sonnet++;
    return callAnthropic(ANTHROPIC_MODELS.sonnet, system, prompt, maxTokens);
  }

  // opus (weekly_review): Sonnet → Gemini Flash fallback (skip $75/M Opus)
  callCounts.sonnet++;
  try {
    return await callAnthropic(ANTHROPIC_MODELS.sonnet, system, prompt, maxTokens);
  } catch {
    console.log('[ModelRouter] weekly_review → Sonnet failed, trying Gemini Flash');
    const geminiResult = await callGeminiFlash(system, prompt);
    if (geminiResult) return geminiResult;
    throw new Error('[ModelRouter] weekly_review: all tiers failed');
  }
}

// ── Conversation turns: simple (Ollama → Groq → Haiku) ───────────────────────

/**
 * Routes a simple conversation turn.
 * Tries Ollama first (free, local), then Groq (free, fast), then Haiku.
 * Never throws.
 */
export async function routeSimple(system: string, userText: string): Promise<string> {
  // Tier 0 — local fine-tuned (AXON_CORE_MODE only)
  const local = await routeAxonLocal(system, userText);
  if (local) return local;

  // Tool-use override: skip free tiers entirely if tools are expected.
  if (requiresToolUse(userText)) {
    console.log('[ModelRouter] simple → sonnet (tool-use override)');
    callCounts.sonnet++;
    return callAnthropic(ANTHROPIC_MODELS.sonnet, system, userText, 300);
  }

  // Try Ollama
  const ollamaResult = await callOllama(system, userText);
  if (ollamaResult) { callCounts.ollama++; return ollamaResult; }

  // Fallback: Groq
  const groqResult = await callGroq(system, userText);
  if (groqResult) { callCounts.haiku++; return groqResult; }

  // Fallback: Haiku
  console.log('[ModelRouter] simple → Ollama/Groq unavailable, falling back to Haiku');
  try {
    callCounts.haiku++;
    return await callAnthropic(ANTHROPIC_MODELS.haiku, system, userText, 100);
  } catch {
    console.log('[ModelRouter] simple → Haiku failed, falling back to Sonnet');
    callCounts.sonnet++;
    return await callAnthropic(ANTHROPIC_MODELS.sonnet, system, userText, 100);
  }
}

// ── Conversation turns: moderate (Groq → Gemini Flash → Haiku) ───────────────

/**
 * Routes a moderate-complexity conversation turn.
 * Tries Groq first (free, fast), then Gemini Flash (free), then Haiku.
 * Never throws.
 */
export async function routeModerate(system: string, userText: string, maxTokens = 200): Promise<string> {
  // Tier 0 — local fine-tuned (AXON_CORE_MODE only)
  const local = await routeAxonLocal(system, userText);
  if (local) return local;

  if (requiresToolUse(userText)) {
    console.log('[ModelRouter] moderate → sonnet (tool-use override)');
    callCounts.sonnet++;
    return callAnthropic(ANTHROPIC_MODELS.sonnet, system, userText, maxTokens);
  }

  const groqResult = await callGroq(system, userText);
  if (groqResult) { callCounts.haiku++; return groqResult; }

  console.log('[ModelRouter] moderate → Groq unavailable, trying Gemini Flash');
  const geminiResult = await callGeminiFlash(system, userText);
  if (geminiResult) { callCounts.haiku++; return geminiResult; }

  console.log('[ModelRouter] moderate → Gemini unavailable, falling back to Haiku');
  callCounts.haiku++;
  return callAnthropic(ANTHROPIC_MODELS.haiku, system, userText, maxTokens);
}

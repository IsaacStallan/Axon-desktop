import { app } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

// ── Pricing (per million tokens) ──────────────────────────────────────────────

const RATES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.25,  output: 1.25  },
};

const VISION_COST_PER_IMAGE = 0.002;

// ── Persistence ───────────────────────────────────────────────────────────────

interface DailyBreakdown {
  sonnetInputTokens:  number;
  sonnetOutputTokens: number;
  haikuInputTokens:   number;
  haikuOutputTokens:  number;
  visionImages:       number;
}

interface DailyRecord {
  date:      string;
  totalCost: number;
  breakdown: DailyBreakdown;
}

interface CostStore {
  days: DailyRecord[];
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'cost_tracking.json');
}

function loadStore(): CostStore {
  try {
    return JSON.parse(readFileSync(storePath(), 'utf8')) as CostStore;
  } catch {
    return { days: [] };
  }
}

function saveStore(store: CostStore): void {
  try {
    writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.warn('[CostTracker] failed to persist cost_tracking.json:', e);
  }
}

function getOrCreateToday(store: CostStore): DailyRecord {
  const d   = todayStr();
  let   rec = store.days.find(r => r.date === d);
  if (!rec) {
    rec = {
      date:      d,
      totalCost: 0,
      breakdown: {
        sonnetInputTokens:  0,
        sonnetOutputTokens: 0,
        haikuInputTokens:   0,
        haikuOutputTokens:  0,
        visionImages:       0,
      },
    };
    store.days.push(rec);
    // Retain only the last 30 days
    if (store.days.length > 30) store.days.splice(0, store.days.length - 30);
  }
  return rec;
}

// ── Session accumulator ───────────────────────────────────────────────────────

let sessionCost = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record the cost of an Anthropic API call.
 * Call this immediately after every client.messages.create() response.
 */
export function recordTokens(
  model:        string,
  inputTokens:  number,
  outputTokens: number,
): void {
  const rate = RATES[model];
  if (!rate) {
    console.warn('[CostTracker] unknown model — skipping cost record:', model);
    return;
  }

  const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  sessionCost += cost;

  const store = loadStore();
  const rec   = getOrCreateToday(store);
  rec.totalCost += cost;

  if (model === 'claude-sonnet-4-6') {
    rec.breakdown.sonnetInputTokens  += inputTokens;
    rec.breakdown.sonnetOutputTokens += outputTokens;
  } else {
    rec.breakdown.haikuInputTokens  += inputTokens;
    rec.breakdown.haikuOutputTokens += outputTokens;
  }

  saveStore(store);

  const tier = model.includes('sonnet') ? 'Sonnet' : 'Haiku';
  console.log(
    `[Cost] +$${cost.toFixed(5)} (${tier} ${inputTokens}in / ${outputTokens}out) | ` +
    `today: $${rec.totalCost.toFixed(4)} | session: $${sessionCost.toFixed(4)}`,
  );
}

/**
 * Record the flat cost of one vision image (~$0.002).
 * Call this after every screen analysis that sends an image to the API.
 */
export function recordVision(): void {
  sessionCost += VISION_COST_PER_IMAGE;

  const store = loadStore();
  const rec   = getOrCreateToday(store);
  rec.totalCost             += VISION_COST_PER_IMAGE;
  rec.breakdown.visionImages += 1;
  saveStore(store);
}

/** Today's cumulative cost in dollars (reads from disk). */
export function getDailyTotal(): number {
  const store = loadStore();
  return store.days.find(r => r.date === todayStr())?.totalCost ?? 0;
}

/** Cost accumulated since the process started (in-memory only). */
export function getSessionTotal(): number {
  return sessionCost;
}

// ── Periodic log (every 30 minutes) ──────────────────────────────────────────

setInterval(() => {
  const daily   = getDailyTotal();
  const session = getSessionTotal();
  console.log(`[Cost] today: $${daily.toFixed(4)} | this session: $${session.toFixed(4)}`);
}, 30 * 60_000);

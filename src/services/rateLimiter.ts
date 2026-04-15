import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// ── Tier definitions ───────────────────────────────────────────────────────────

export type UserTier = 'free' | 'starter' | 'pro' | 'enterprise';

interface TierLimits {
  dailyConversationMinutes:   number;
  monthlyAPIBudgetUSD:        number;
  interventionFrequencyMins:  number;   // minimum gap between interventions
  maxDevices:                 number;
  screenAwarenessEnabled:     boolean;
  subAgentsEnabled:           boolean;
}

const TIER_LIMITS: Record<UserTier, TierLimits> = {
  free: {
    dailyConversationMinutes:  10,
    monthlyAPIBudgetUSD:        2,
    interventionFrequencyMins: 60,
    maxDevices:                 1,
    screenAwarenessEnabled:  false,
    subAgentsEnabled:        false,
  },
  starter: {
    dailyConversationMinutes:  30,
    monthlyAPIBudgetUSD:        8,
    interventionFrequencyMins: 30,
    maxDevices:                 1,
    screenAwarenessEnabled:  true,
    subAgentsEnabled:        false,
  },
  pro: {
    dailyConversationMinutes:  120,
    monthlyAPIBudgetUSD:       25,
    interventionFrequencyMins: 15,
    maxDevices:                 2,
    screenAwarenessEnabled:  true,
    subAgentsEnabled:        true,
  },
  enterprise: {
    dailyConversationMinutes:  999,
    monthlyAPIBudgetUSD:       999,
    interventionFrequencyMins:   5,
    maxDevices:                 10,
    screenAwarenessEnabled:  true,
    subAgentsEnabled:        true,
  },
};

// ── Current tier (from .env — later replaced by Supabase + Stripe) ─────────────

function getCurrentTier(): UserTier {
  const t = process.env.AXON_USER_TIER ?? 'enterprise';
  if (t === 'free' || t === 'starter' || t === 'pro' || t === 'enterprise') return t;
  return 'enterprise';
}

export function getTierLimits(): TierLimits {
  return TIER_LIMITS[getCurrentTier()];
}

// ── Usage storage ──────────────────────────────────────────────────────────────
// Mirrors the Supabase axon_usage table schema for local storage.
/*
  Supabase schema (reference):
  create table axon_usage (
    user_id               text,
    date                  date,
    conversation_minutes  float default 0,
    api_cost_usd          float default 0,
    intervention_count    int   default 0,
    primary key (user_id, date)
  );
*/

interface DailyUsage {
  date:                 string;   // YYYY-MM-DD
  conversationMinutes:  number;
  apiCostUSD:           number;
  interventionCount:    number;
  lastInterventionAt:   number;   // epoch ms
}

function usagePath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'rate_usage.json');
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadUsage(): DailyUsage[] {
  try {
    return JSON.parse(readFileSync(usagePath(), 'utf8')) as DailyUsage[];
  } catch {
    return [];
  }
}

function saveUsage(records: DailyUsage[]): void {
  try {
    writeFileSync(usagePath(), JSON.stringify(records, null, 2), 'utf8');
  } catch (e) {
    console.warn('[RateLimiter] failed to persist usage:', e);
  }
}

function getOrCreateToday(records: DailyUsage[]): DailyUsage {
  const d   = todayStr();
  let   rec = records.find(r => r.date === d);
  if (!rec) {
    rec = { date: d, conversationMinutes: 0, apiCostUSD: 0, interventionCount: 0, lastInterventionAt: 0 };
    records.push(rec);
    if (records.length > 30) records.splice(0, records.length - 30);
  }
  return rec;
}

function getMonthlyAPISpend(records: DailyUsage[]): number {
  const monthStart = new Date().toISOString().slice(0, 7); // YYYY-MM
  return records
    .filter(r => r.date.startsWith(monthStart))
    .reduce((s, r) => s + r.apiCostUSD, 0);
}

// ── Session conversation-time accumulator ──────────────────────────────────────

let conversationStartMs = 0;

export function startConversationTimer(): void {
  conversationStartMs = Date.now();
}

export function stopConversationTimer(): void {
  if (!conversationStartMs) return;
  const elapsedMins = (Date.now() - conversationStartMs) / 60_000;
  conversationStartMs = 0;

  const records = loadUsage();
  const rec     = getOrCreateToday(records);
  rec.conversationMinutes += elapsedMins;
  saveUsage(records);
}

// ── Public: rate limit checks ──────────────────────────────────────────────────

export interface LimitResult {
  allowed:  boolean;
  reason?:  string;
}

export async function checkConversationLimit(): Promise<LimitResult> {
  const limits  = getTierLimits();
  if (limits.dailyConversationMinutes >= 999) return { allowed: true };

  const records = loadUsage();
  const rec     = getOrCreateToday(records);

  if (rec.conversationMinutes >= limits.dailyConversationMinutes) {
    const tier    = getCurrentTier();
    const nextTier: Record<UserTier, string> = {
      free:       'Starter',
      starter:    'Pro',
      pro:        'Enterprise',
      enterprise: 'Enterprise',
    };
    return {
      allowed: false,
      reason:  `You've used your daily conversation limit. Upgrade to ${nextTier[tier]} for more.`,
    };
  }

  return { allowed: true };
}

export async function checkAPIBudget(estimatedCostUSD: number): Promise<LimitResult> {
  const limits  = getTierLimits();
  if (limits.monthlyAPIBudgetUSD >= 999) return { allowed: true };

  const records      = loadUsage();
  const monthlySpend = getMonthlyAPISpend(records);

  if (monthlySpend + estimatedCostUSD > limits.monthlyAPIBudgetUSD) {
    const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
      .toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    return {
      allowed: false,
      reason:  `Monthly budget reached. Your limit resets on ${resetDate}.`,
    };
  }

  return { allowed: true };
}

export async function checkInterventionLimit(): Promise<LimitResult> {
  const limits  = getTierLimits();
  const records = loadUsage();
  const rec     = getOrCreateToday(records);

  const minsSinceLast = (Date.now() - rec.lastInterventionAt) / 60_000;
  if (minsSinceLast < limits.interventionFrequencyMins) {
    return { allowed: false };
  }

  return { allowed: true };
}

export async function checkFeatureAccess(
  feature: 'screenAwareness' | 'subAgents',
): Promise<boolean> {
  const limits = getTierLimits();
  if (feature === 'screenAwareness') return limits.screenAwarenessEnabled;
  if (feature === 'subAgents')       return limits.subAgentsEnabled;
  return false;
}

// ── Public: usage recording ────────────────────────────────────────────────────

/**
 * Record the USD cost of an API call.
 * Called from costTracker.recordTokens() after every API response.
 */
export function recordAPIUsage(costUSD: number): void {
  const records = loadUsage();
  const rec     = getOrCreateToday(records);
  rec.apiCostUSD += costUSD;
  saveUsage(records);
}

/**
 * Record that an intervention fired.
 * Called from interventionDecider after successfully speaking an intervention.
 */
export function recordInterventionFired(): void {
  const records = loadUsage();
  const rec     = getOrCreateToday(records);
  rec.interventionCount++;
  rec.lastInterventionAt = Date.now();
  saveUsage(records);
}

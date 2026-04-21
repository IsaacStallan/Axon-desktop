import { getCurrentApp, getProductivityScore, getSessionLog } from './windowMonitor';
import { analyzeCurrentState }            from './patternEngine';
import { startWeeklyReviewScheduler }     from './weeklyReview';
import { getSoftLockState, activateSoftLock } from './softLockService';
import { getWeeklyPlanForToday }          from './planningService';
import {
  evaluate            as evaluateIntervention,
  setConversationTrigger,
  checkPendingOutcome,
} from './interventionDecider';
import {
  logAppSession,
  logFlowSession,
  updateTodayPattern,
  seedDefaultProfileIfMissing,
  getRecentInterventions,
  resetSessionOnStartup,
  getLastActivityTime,
} from './behaviourModel';
import { initCloudSync }    from './cloudSync';
import { startHeartbeat }  from './deviceCoordinator';
import { syncToObsidian }  from './obsidianSync';
import { getCurrentScreenSummary } from './screenAwareness';

// ── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS     = 5 * 60_000;   // 5-minute pattern-engine tick
const PATTERN_UPDATE_EVERY = 2;            // update today's pattern every 2 polls (10 min)

// ── Morning briefing trigger ───────────────────────────────────────────────────

let lastBriefingDate: string | null = null;

async function checkMorningBriefingTrigger(): Promise<void> {
  const today = new Date().toDateString();
  if (lastBriefingDate === today) return;

  const hour = new Date().getHours();
  if (hour < 5 || hour > 12) return;

  const lastActivityMs  = getLastActivityTime();
  const inactiveMs      = Date.now() - lastActivityMs;
  const inactiveHours   = inactiveMs / (1000 * 60 * 60);

  // First active period after 4+ hours of inactivity = morning startup
  if (lastActivityMs === 0 || inactiveHours >= 4) {
    lastBriefingDate = today;
    console.log('[DecisionEngine] morning startup detected — triggering briefing');
    try {
      const { triggerMorningBriefing } = require('./planningService');
      await triggerMorningBriefing();
    } catch (e) {
      console.warn('[DecisionEngine] morning briefing failed:', e);
    }
  }
}

// ── Snooze state ───────────────────────────────────────────────────────────────

let snoozeUntilMs = 0;

// ── Weekly plan fire-once guards ───────────────────────────────────────────────

let windDownWarningFiredDate  = '';  // YYYY-MM-DD
let softLockAutoFiredDate     = '';  // YYYY-MM-DD

/**
 * Silence all interventions until the given number of minutes have elapsed.
 * Pass 999 to snooze for the rest of the day.
 */
export function snoozeInterventions(minutes: number): void {
  const ms = minutes >= 999
    ? new Date().setHours(23, 59, 59, 999) - Date.now()
    : minutes * 60_000;
  snoozeUntilMs = Date.now() + ms;
  const label   = minutes >= 999 ? 'rest of day' : `${minutes}min`;
  console.log(`[DecisionEngine] interventions snoozed for ${label}`);
}

export function isSnoozed(): boolean {
  return Date.now() < snoozeUntilMs;
}

// ── In-memory session tracking ─────────────────────────────────────────────────

let sessionLogSnapshot    = 0;   // length of getSessionLog() last time we persisted
let focusStreakStartMs: number | null = null;
let focusStreakLogged      = false;
let pollCount              = 0;

// ── Persist newly completed app sessions ──────────────────────────────────────

function persistNewAppSessions(): void {
  const log = getSessionLog();
  if (log.length <= sessionLogSnapshot) return;

  const newEntries = log.slice(sessionLogSnapshot);
  sessionLogSnapshot = log.length;

  const score = getProductivityScore();
  for (const entry of newEntries) {
    logAppSession({
      app:               entry.name,
      startTime:         new Date(entry.startedAt).toISOString(),
      endTime:           new Date(entry.startedAt + entry.durationMs).toISOString(),
      productivityScore: score,
      wasDistraction:    entry.label === 'negative',
    });
  }
}

// ── Detect and log flow sessions ───────────────────────────────────────────────
// A flow session is defined as productivity score staying above 70% for
// 30+ continuous minutes — we approximate this with positive-app streak tracking.

function trackFlowSession(): void {
  const curr = getCurrentApp();

  if (curr.label === 'positive' && getProductivityScore() >= 70) {
    if (!focusStreakStartMs) {
      focusStreakStartMs = Date.now();
      focusStreakLogged  = false;
    }

    const streakMins = (Date.now() - focusStreakStartMs) / 60_000;

    if (streakMins >= 30 && !focusStreakLogged) {
      logFlowSession({
        startTime:       new Date(focusStreakStartMs).toISOString(),
        durationMinutes: Math.round(streakMins),
        triggerApp:      curr.name,
      });
      focusStreakLogged = true;
      console.log(`[DecisionEngine] flow session: ${Math.round(streakMins)}min on ${curr.name}`);
    }
  } else {
    // Streak broken — reset for next positive block
    if (focusStreakStartMs && !focusStreakLogged) {
      // Short streak, not worth logging
    }
    focusStreakStartMs = null;
    focusStreakLogged  = false;
  }
}

// ── Update today's session pattern ────────────────────────────────────────────

function refreshTodayPattern(): void {
  const log = getSessionLog();
  let focusMs = 0, driftMs = 0, longestFocusMs = 0;
  let currentFocusMs = 0;

  for (const entry of log) {
    if (entry.label === 'positive') {
      focusMs       += entry.durationMs;
      currentFocusMs += entry.durationMs;
      longestFocusMs  = Math.max(longestFocusMs, currentFocusMs);
    } else {
      currentFocusMs = 0;
      if (entry.label === 'negative') driftMs += entry.durationMs;
    }
  }

  // Include still-running current session
  const curr = getCurrentApp();
  if (curr.label === 'positive') {
    const currMs   = curr.durationMins * 60_000;
    focusMs       += currMs;
    currentFocusMs += currMs;
    longestFocusMs  = Math.max(longestFocusMs, currentFocusMs);
  } else if (curr.label === 'negative') {
    driftMs += curr.durationMins * 60_000;
  }

  // Intervention count for today
  const todayStr    = new Date().toISOString().slice(0, 10);
  const todayIntervs = getRecentInterventions(1)
    .filter(r => r.timestamp.startsWith(todayStr));

  updateTodayPattern({
    totalFocusMinutes: Math.round(focusMs / 60_000),
    totalDriftMinutes: Math.round(driftMs / 60_000),
    longestFocusBlock: Math.round(longestFocusMs / 60_000),
    interventionCount: todayIntervs.length,
  });
}

// ── Weekly plan timing checks ──────────────────────────────────────────────────
// Runs each poll. Fires wind-down warning and auto soft-lock once per day.

async function checkWeeklyPlanTiming(): Promise<void> {
  // Don't interfere if a soft lock is already active
  if (getSoftLockState()?.active) return;

  const plan = getWeeklyPlanForToday();
  if (!plan) return;

  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date();

  // Parse a "HH:MM" time string into today's Date
  function todayAt(hhmm: string): Date | null {
    const [h, m] = hhmm.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  // ── Wind-down warning ──────────────────────────────────────────────────────
  if (plan.laptopWindDownTime && windDownWarningFiredDate !== today) {
    const windDown = todayAt(plan.laptopWindDownTime);
    if (windDown) {
      const diffMs = windDown.getTime() - now.getTime();
      // Warn once when within 10 minutes of wind-down time
      if (diffMs >= 0 && diffMs <= 10 * 60_000) {
        windDownWarningFiredDate = today;
        console.log(`[DecisionEngine] wind-down warning — ${plan.laptopWindDownTime}`);
        // Import speak lazily to avoid circular deps
        try {
          const { speak } = require('./elevenLabsService');
          await speak(`Wind-down time in ${Math.ceil(diffMs / 60_000)} minutes. Start wrapping up.`);
        } catch (e) {
          console.warn('[DecisionEngine] wind-down speak failed:', e);
        }
      }
    }
  }

  // ── Auto soft lock ────────────────────────────────────────────────────────
  if (plan.softLockStart && softLockAutoFiredDate !== today) {
    const lockStart = todayAt(plan.softLockStart);
    if (lockStart) {
      const diffMs = lockStart.getTime() - now.getTime();
      // Warn 30 minutes before
      if (diffMs > 0 && diffMs <= 30 * 60_000 && softLockAutoFiredDate !== `${today}-warn`) {
        softLockAutoFiredDate = `${today}-warn`;
        const diffMins = Math.ceil(diffMs / 60_000);
        console.log(`[DecisionEngine] soft lock warning — ${diffMins}min until ${plan.softLockStart}`);
        try {
          const { speak } = require('./elevenLabsService');
          await speak(`${diffMins} minutes until gym time. Start getting ready.`);
        } catch (e) {
          console.warn('[DecisionEngine] soft lock warn speak failed:', e);
        }
      }
      // Auto-activate at soft lock start time (±5 min window)
      if (Math.abs(diffMs) <= 5 * 60_000) {
        softLockAutoFiredDate = today;
        const end    = plan.softLockEnd ? todayAt(plan.softLockEnd) : null;
        const durMs  = end ? end.getTime() - now.getTime() : 90 * 60_000;
        const durMin = Math.max(1, Math.round(durMs / 60_000));
        console.log(`[DecisionEngine] auto soft lock: gym time — ${durMin}min`);
        await activateSoftLock('Gym time', durMin);
      }
    }
  }
}

// ── Main poll ──────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  pollCount++;

  // 1. Persist any newly completed app entries from the window monitor
  persistNewAppSessions();

  // 2. Track focus streaks / flow sessions
  trackFlowSession();

  // 3. Refresh today's aggregate pattern every other poll
  if (pollCount % PATTERN_UPDATE_EVERY === 0) {
    refreshTodayPattern();
  }

  // 4. Run pattern engine to get current risk assessment
  const pattern = analyzeCurrentState();

  const screenCtx = getCurrentScreenSummary();
  console.log(
    `[DecisionEngine] poll #${pollCount} — drift: ${pattern.driftProbability}% ` +
    `(${pattern.tier}) | focus: ${Math.round(pattern.continuousFocusMins)}min | ` +
    `break: ${pattern.breakRecommended} | ${pattern.reason}` +
    (screenCtx ? ` | screen: ${screenCtx}` : ''),
  );

  // 5. Check today's weekly life plan for wind-down and soft lock timing
  await checkWeeklyPlanTiming();

  // 5a. Morning briefing trigger (first active period of the day)
  void checkMorningBriefingTrigger();

  // 6. Pass to intervention decider — skip if snoozed
  if (isSnoozed()) {
    const remMins = Math.ceil((snoozeUntilMs - Date.now()) / 60_000);
    console.log(`[DecisionEngine] snoozed — skipping intervention (${remMins}min remaining)`);
    return;
  }
  await evaluateIntervention(pattern);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Starts the decision loop.
 * onTrigger is called after an intervention speaks so the listening window opens
 * automatically — same UX as a wake-word trigger.
 */
export function startDecisionLoop(onTrigger: () => void): void {
  // Seed Isaac's known profile if this is the first launch
  seedDefaultProfileIfMissing();

  // Reset session boundary — any pre-restart in-memory state shouldn't carry over
  resetSessionOnStartup();

  // Pull cross-device data from Supabase in the background (best-effort)
  void initCloudSync();

  // Start 30-second device heartbeat
  startHeartbeat();

  // Register callback in the intervention decider
  setConversationTrigger(onTrigger);

  // Start the weekly review scheduler (Sunday 6pm automatic)
  startWeeklyReviewScheduler();

  console.log('[DecisionEngine] starting — 5-minute tick');

  // First poll on next tick (gives window monitor time to get a first sample)
  setTimeout(() => { void poll(); }, 10_000);

  // Then every 5 minutes
  setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

  // Sync to Obsidian every 30 minutes (fire-and-forget)
  setInterval(() => { void syncToObsidian(); }, 30 * 60_000);
}

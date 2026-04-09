import { getCurrentApp, getProductivityScore, getSessionLog } from './windowMonitor';
import { analyzeCurrentState }            from './patternEngine';
import { startWeeklyReviewScheduler }     from './weeklyReview';
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
} from './behaviourModel';
import { initCloudSync }  from './cloudSync';
import { startHeartbeat } from './deviceCoordinator';
import { getCurrentScreenSummary } from './screenAwareness';

// ── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS     = 5 * 60_000;   // 5-minute pattern-engine tick
const PATTERN_UPDATE_EVERY = 2;            // update today's pattern every 2 polls (10 min)

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

  // 5. Pass to intervention decider — it owns all firing logic and cooldowns
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
}

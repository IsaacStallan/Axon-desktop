import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import { app } from 'electron';
import fs   from 'fs';
import path from 'path';
import { getCurrentApp, getSessionLog } from './windowMonitor';
import { analyzeCurrentState }           from './patternEngine';
import { getRecentContext }              from './screenAwareness';
import { getLastChangeScore }           from './screenObserver';
import { getTodayEvents }               from './calendarService';
import { getActiveGoals }               from './goalService';
import { getLearnedFacts, storeSessionContext } from './memoryService';
import { getWeeklyPlanForToday }        from './planningService';
import { getEmotionPromptFragment }     from './emotionEngine';
import { isSnoozed, checkWeeklyPlanTiming, checkMorningBriefingTrigger } from './decisionEngine';
import { getSoftLockState, activateSoftLock } from './softLockService';
import { getOpenCommitments }           from './commitmentTracker';
import {
  getRecentInterventions,
  getRecentBreaks,
  getCognitiveStats,
  logIntervention,
  getSystemScreenTimeToday,
} from './behaviourModel';
import { speak, isSpeaking }            from './elevenLabsService';
import { isConversationActive }         from './conversationService';
import { acquireSpeakerLock, releaseSpeakerLock } from './deviceCoordinator';
import { setLastProactiveMessage }      from './proactiveContext';
import { recordInterventionFired }      from './rateLimiter';
import { runSilentTask }                from './subAgentOrchestrator';
import { recordTokens }                 from './costTracker';
import * as phoneMonitor                from './phoneMonitor';
import { ARETICA_VISION }              from './areticaVision';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 3 });

// ── Types ──────────────────────────────────────────────────────────────────────

interface DayPlan {
  date?:               string;
  deepWorkWindow?:     string;
  gymOrRunTime?:       string;
  laptopWindDownTime?: string;
  softLockStart?:      string;
  softLockEnd?:        string;
  notes?:              string;
}

interface ObservationState {
  activeApp:                      string;
  activeAppMinutes:               number;
  previousApp:                    string;
  previousAppMinutes:             number;
  currentHour:                    number;
  currentMinute:                  number;
  dayOfWeek:                      string;
  timeOfDay:                      'early_morning' | 'morning' | 'afternoon' | 'evening' | 'night';
  nextEventMinutes:               number | null;
  nextEventTitle:                 string | null;
  currentEventTitle:              string | null;
  isInMeeting:                    boolean;
  driftScore:                     number;
  driftTier:                      0 | 1 | 2 | 3;
  sessionFocusMinutes:            number;
  lastBreakMinutes:               number;
  lastMovementMinutes:            number;
  interventionsToday:             number;
  lastInterventionMinutes:        number;
  lastInterventionWorked:         boolean;
  consecutiveFailedInterventions: number;
  openCommitments:                number;
  todayPriority:                  string | null;
  weeklyPlanToday:                DayPlan | null;
  relevantFacts:                  string[];
  screenSummary:                  string;
  screenChanged:                  boolean;
  screenChangeSignificance:       number;
  screenProductivitySignal:       'productive' | 'neutral' | 'distraction';
  readingDetected:                boolean;
  readingMinutes:                 number;
  macIdleMinutes:                 number;
  phoneUsageInferred:             boolean;
  phoneConfirmedDistraction:      boolean;
  phoneDistractionApp:            string | null;
  phoneDistractionMinutesAgo:     number | null;
  phoneSummary:                   string;
  unreadUrgentEmails:             number;
  recentEmailSummary:             string | null;
  cognitiveCapacity:              number;
  emotionState:                   string;
  energyLevel:                    'high' | 'medium' | 'low';
  lastSpokenToAxonMinutes:        number;
  axonSnoozed:                    boolean;
  softLockActive:                 boolean;
}

interface CognitiveDecision {
  action:               'speak' | 'act_silently' | 'block' | 'watch' | 'update_model';
  priority:             'critical' | 'high' | 'medium' | 'low';
  reason:               string;
  interventionTier?:    1 | 2 | 3;
  silentTask?:          string;
  modelTier:            'groq' | 'haiku' | 'sonnet';
  shouldSpeak:          boolean;
  confidence:           number;
  suppressUntilMinutes?: number;
}

// ── Module state ───────────────────────────────────────────────────────────────

let cognitiveLoopRunning    = false;
let onTrigger: (() => void) | null = null;
let lastConversationEndedAt = Date.now();
let lastScreenHash          = 0;

// First-week hourly speak cap
let speaksThisHour  = 0;
let speakHourBucket = -1;
let lastSpeakDateStr = '';

// Fix 1 — Global 8-minute speak cooldown
let lastProactiveSpeakAt       = 0;
const GLOBAL_SPEAK_COOLDOWN_MS = 8 * 60_000;

// Fix 6 — Daily speak budget
const dailySpeakBudget = { date: '', count: 0, maxPerDay: 25 };

function canSpeak(tier?: number): boolean {
  if (tier === 3) return true; // tier 3 always bypasses cooldown
  return (Date.now() - lastProactiveSpeakAt) >= GLOBAL_SPEAK_COOLDOWN_MS;
}

function checkDailyBudget(): boolean {
  const today = new Date().toDateString();
  if (dailySpeakBudget.date !== today) {
    dailySpeakBudget.date  = today;
    dailySpeakBudget.count = 0;
  }
  return dailySpeakBudget.count < dailySpeakBudget.maxPerDay;
}

export function setLastConversationTime(): void {
  lastConversationEndedAt = Date.now();
}

// ── First-week detection ───────────────────────────────────────────────────────

function isFirstWeek(): boolean {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'onboarding-complete.json'), 'utf8'),
    ) as { completedAt: string };
    const daysSince = (Date.now() - new Date(data.completedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince <= 7;
  } catch {
    return false;
  }
}

// ── Mac idle time (sync, uses ioreg) ──────────────────────────────────────────

function getMacIdleMinutes(): number {
  if (process.platform !== 'darwin') return 0;
  try {
    const output = execSync(
      `ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'`,
      { encoding: 'utf8', timeout: 2_000 },
    ).trim();
    const secs = parseFloat(output);
    return isNaN(secs) ? 0 : Math.round(secs / 60);
  } catch {
    return 0;
  }
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(s.length, 200); i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

// ── Observation collector ──────────────────────────────────────────────────────

async function collectObservations(): Promise<ObservationState> {
  const now  = new Date();
  const hour = now.getHours();

  const timeOfDay: ObservationState['timeOfDay'] =
    hour < 6  ? 'early_morning' :
    hour < 12 ? 'morning' :
    hour < 17 ? 'afternoon' :
    hour < 21 ? 'evening' : 'night';

  const curr    = getCurrentApp();
  const log     = getSessionLog();
  const pattern = analyzeCurrentState();

  const prevEntry          = log.length >= 2 ? log[log.length - 2] : null;
  const previousApp        = prevEntry?.name ?? 'none';
  const previousAppMinutes = prevEntry ? Math.round(prevEntry.durationMs / 60_000) : 0;

  const driftTier: ObservationState['driftTier'] =
    pattern.driftProbability < 60 ? 0 :
    pattern.tier === 'predictive' ? 1 :
    pattern.tier === 'early'      ? 2 : 3;

  // Calendar
  let events: Awaited<ReturnType<typeof getTodayEvents>> = [];
  try { events = await getTodayEvents(1); } catch { /* offline */ }

  const nowMs        = Date.now();
  const futureEvents = events.filter(e => e.startMs > nowMs);
  const nextEvent    = futureEvents[0] ?? null;
  const nextEventMinutes = nextEvent ? Math.round((nextEvent.startMs - nowMs) / 60_000) : null;
  const currentEvent = events.find(e => e.startMs <= nowMs && (e.startMs + 60 * 60_000) >= nowMs) ?? null;

  const MEETING_KW  = ['meeting', 'call', 'standup', 'sync', 'interview', 'zoom', 'teams'];
  const isInMeeting = currentEvent
    ? MEETING_KW.some(k => currentEvent.title.toLowerCase().includes(k))
    : false;

  // Interventions
  const todayStr           = now.toISOString().slice(0, 10);
  const allInterventions   = getRecentInterventions(1);
  const todayInterventions = allInterventions.filter(r => r.timestamp.startsWith(todayStr));
  const lastIntervention   = todayInterventions[todayInterventions.length - 1] ?? null;
  const lastInterventionMinutes = lastIntervention
    ? Math.round((nowMs - new Date(lastIntervention.timestamp).getTime()) / 60_000)
    : 999;
  const lastInterventionWorked = lastIntervention?.courseCorrected === true;

  const recentSorted = [...allInterventions].reverse();
  let consecutiveFailedInterventions = 0;
  for (const r of recentSorted) {
    if (r.courseCorrected === false) consecutiveFailedInterventions++;
    else break;
  }

  // Breaks
  const allBreaks   = getRecentBreaks(1);
  const todayBreaks = allBreaks.filter(b => b.timestamp.startsWith(todayStr));
  const lastBreak   = todayBreaks[todayBreaks.length - 1] ?? null;
  const lastBreakMinutes = lastBreak
    ? Math.round((nowMs - new Date(lastBreak.timestamp).getTime()) / 60_000)
    : 999;

  // Capacity
  const screenTimeMins      = getSystemScreenTimeToday();
  const cogStats            = getCognitiveStats(screenTimeMins);
  const sessionFocusMinutes = Math.round(pattern.continuousFocusMins);

  const goals      = getActiveGoals();
  const weeklyPlan = getWeeklyPlanForToday() as DayPlan | null;
  const relevantFacts = getLearnedFacts().slice(-5);

  // Screen
  const screenContexts = getRecentContext();
  const screenCtx      = screenContexts[screenContexts.length - 1] ?? null;
  const screenSummary  = screenCtx
    ? `${screenCtx.activeApp} — ${screenCtx.activity}${screenCtx.notes ? ` (${screenCtx.notes})` : ''}`
    : '';
  const screenSignalRaw = screenCtx?.productivitySignal ?? 'idle';
  const screenProductivitySignal: ObservationState['screenProductivitySignal'] =
    screenSignalRaw === 'productive' ? 'productive' :
    screenSignalRaw === 'distracted' ? 'distraction' : 'neutral';
  const currentHash = simpleHash(screenSummary);
  const screenChanged = currentHash !== lastScreenHash;
  if (screenChanged) lastScreenHash = currentHash;
  const screenChangeSignificance = screenChanged ? getLastChangeScore() : 0;

  // Mac idle (sync) — Fix 4: threshold raised from 8 to 15 minutes
  const macIdleMinutes      = getMacIdleMinutes();
  const phoneUsageInferred  = macIdleMinutes > 15 &&
    (timeOfDay === 'morning' || timeOfDay === 'afternoon');

  // Phone — run concurrently
  const [phoneCheck, phoneSummary] = await Promise.all([
    phoneMonitor.isOnPhoneDistraction(),
    phoneMonitor.getPhoneSessionSummary(),
  ]);

  // Energy / capacity
  const energyLevel: ObservationState['energyLevel'] =
    cogStats.cognitiveCapacity >= 70 ? 'high' :
    cogStats.cognitiveCapacity >= 40 ? 'medium' : 'low';

  const lastSpokenToAxonMinutes = Math.round((nowMs - lastConversationEndedAt) / 60_000);
  const openCommitments         = getOpenCommitments().length;
  const todayPriority           = weeklyPlan?.notes ?? (goals[0]?.text ?? null);
  const emotionState            = getEmotionPromptFragment().split('\n')[0] ?? 'neutral';

  return {
    activeApp:                      curr.name,
    activeAppMinutes:               Math.round(curr.durationMins),
    previousApp,
    previousAppMinutes,
    currentHour:                    hour,
    currentMinute:                  now.getMinutes(),
    dayOfWeek:                      now.toLocaleDateString('en-AU', { weekday: 'long' }),
    timeOfDay,
    nextEventMinutes,
    nextEventTitle:                 nextEvent?.title ?? null,
    currentEventTitle:              currentEvent?.title ?? null,
    isInMeeting,
    driftScore:                     pattern.driftProbability,
    driftTier,
    sessionFocusMinutes,
    lastBreakMinutes,
    lastMovementMinutes:            macIdleMinutes,
    interventionsToday:             todayInterventions.length,
    lastInterventionMinutes,
    lastInterventionWorked,
    consecutiveFailedInterventions,
    openCommitments,
    todayPriority,
    weeklyPlanToday:                weeklyPlan,
    relevantFacts,
    screenSummary,
    screenChanged,
    screenChangeSignificance,
    screenProductivitySignal,
    readingDetected:                false,
    readingMinutes:                 0,
    macIdleMinutes,
    phoneUsageInferred,
    phoneConfirmedDistraction:      phoneCheck.confirmed,
    phoneDistractionApp:            phoneCheck.app,
    phoneDistractionMinutesAgo:     phoneCheck.minutesAgo,
    phoneSummary,
    unreadUrgentEmails:             0,
    recentEmailSummary:             null,
    cognitiveCapacity:              cogStats.cognitiveCapacity,
    emotionState,
    energyLevel,
    lastSpokenToAxonMinutes,
    axonSnoozed:                    isSnoozed(),
    softLockActive:                 getSoftLockState()?.active ?? false,
  };
}

// ── Decision helpers ───────────────────────────────────────────────────────────

function speakDecision(
  priority: CognitiveDecision['priority'],
  tier: 1 | 2 | 3,
  model: CognitiveDecision['modelTier'],
  reason: string,
): CognitiveDecision {
  console.log(`[CognitiveEngine] 🔊 SPEAK: ${reason} (tier ${tier})`);
  return { action: 'speak', priority, reason, interventionTier: tier, modelTier: model, shouldSpeak: true, confidence: 80 };
}

function watchDecision(reason: string, confidence: number): CognitiveDecision {
  console.log(`[CognitiveEngine] 🔇 WATCH: ${reason} (confidence: ${confidence}%)`);
  return { action: 'watch', priority: 'low', reason, modelTier: 'groq', shouldSpeak: false, confidence };
}

function blockDecision(reason: string): CognitiveDecision {
  console.log(`[CognitiveEngine] 🚫 BLOCK: ${reason}`);
  return { action: 'block', priority: 'critical', reason, modelTier: 'groq', shouldSpeak: true, confidence: 100 };
}

function actSilentlyDecision(task: string, model: CognitiveDecision['modelTier']): CognitiveDecision {
  console.log(`[CognitiveEngine] 🤫 SILENT: ${task}`);
  return { action: 'act_silently', priority: 'low', reason: task, silentTask: task, modelTier: model, shouldSpeak: false, confidence: 70 };
}

// ── Decision tree ──────────────────────────────────────────────────────────────

function evaluateDecision(obs: ObservationState): CognitiveDecision {

  // ── Gate 1: Hard blocks (never bypassed) ──────────────────────────────────
  if (obs.softLockActive)     return watchDecision('Soft lock active', 0);
  if (obs.axonSnoozed)        return watchDecision('Axon snoozed by user', 0);
  if (obs.isInMeeting)        return watchDecision('User is in a meeting — never interrupt', 0);
  if (isConversationActive()) return watchDecision('Conversation already active', 0);
  if (isSpeaking)             return watchDecision('Already speaking', 0);

  // ── First-week hourly cap ──────────────────────────────────────────────────
  const firstWeek = isFirstWeek();
  if (firstWeek) {
    const nowHour = new Date().getHours();
    if (nowHour !== speakHourBucket) { speaksThisHour = 0; speakHourBucket = nowHour; }
    if (speaksThisHour >= 2) {
      return watchDecision('First week — hourly speak cap reached (2/hr)', 50);
    }
  }

  // ── Gate 2: Critical — bypass global cooldown ──────────────────────────────
  if (obs.sessionFocusMinutes > 300 && obs.lastBreakMinutes > 120) {
    if (firstWeek) return speakDecision('high', 2, 'haiku', 'Over 5h focus — first week tier 2');
    return speakDecision('critical', 3, 'sonnet', 'Over 5h focus, no break in 2h — health risk');
  }
  if (obs.nextEventMinutes !== null && obs.nextEventMinutes <= 5 && obs.nextEventMinutes > 0) {
    return speakDecision('high', 1, 'haiku',
      `${obs.nextEventTitle} starts in ${obs.nextEventMinutes} minutes`);
  }
  if (obs.weeklyPlanToday?.softLockStart && !obs.softLockActive) {
    const [h, m]   = (obs.weeklyPlanToday.softLockStart).split(':').map(Number);
    const lockTime = new Date();
    lockTime.setHours(h, m, 0, 0);
    if (!isNaN(h) && new Date() >= lockTime) {
      return blockDecision('Scheduled soft lock time reached');
    }
  }

  // ── Tier 3 drift — bypasses global cooldown ────────────────────────────────
  if (obs.driftTier === 3) {
    if (firstWeek) return speakDecision('high', 2, 'haiku', 'Tier 3 drift — downgraded to tier 2 (first week)');
    return speakDecision('critical', 3, 'sonnet', 'Tier 3 drift — recovery needed');
  }

  // ── Fix 1: Global 8-minute speak cooldown ─────────────────────────────────
  if (!canSpeak()) {
    const minsSince = Math.round((Date.now() - lastProactiveSpeakAt) / 60_000);
    return watchDecision(`Global cooldown — spoke ${minsSince}m ago (need 8m)`, 100);
  }

  // ── Fix 6: Daily speak budget ──────────────────────────────────────────────
  if (!checkDailyBudget()) {
    return watchDecision(`Daily budget reached (${dailySpeakBudget.count}/${dailySpeakBudget.maxPerDay})`, 100);
  }

  // ── Gate 3: Flow state protection ─────────────────────────────────────────
  const inDeepWork =
    obs.screenProductivitySignal === 'productive' &&
    obs.driftScore < 30 &&
    obs.sessionFocusMinutes > 20 &&
    obs.lastSpokenToAxonMinutes > 15;

  if (inDeepWork) {
    if (obs.nextEventMinutes !== null && obs.nextEventMinutes <= 30) {
      return actSilentlyDecision('Prepare context for upcoming meeting', 'haiku');
    }
    return watchDecision('User in deep work flow — protecting it', 95);
  }

  // ── Gate 4: Drift detection (tier 1 & 2 only — tier 3 handled above) ──────
  if (obs.consecutiveFailedInterventions >= 3) {
    return watchDecision('3 consecutive failed interventions — backing off', 20);
  }
  const minGapMins = obs.lastInterventionWorked ? 15 : 25;
  if (obs.lastInterventionMinutes < minGapMins) {
    return watchDecision(
      `Too soon since last intervention (${obs.lastInterventionMinutes}m < ${minGapMins}m)`, 10,
    );
  }
  if (obs.driftTier === 2) return speakDecision('high',   2, 'haiku', 'Tier 2 drift — early intervention');
  if (obs.driftTier === 1 && obs.energyLevel !== 'low') {
    return speakDecision('medium', 1, 'haiku', 'Tier 1 drift — predictive nudge');
  }

  // ── Gate 5: Phone monitoring ───────────────────────────────────────────────
  // Fix 4: confirmed threshold — macIdle > 15 (was 12)
  if (obs.phoneConfirmedDistraction && obs.macIdleMinutes > 15) {
    return speakDecision('high', 2, 'haiku',
      `Confirmed: ${obs.phoneDistractionApp} opened on iPhone ${obs.phoneDistractionMinutesAgo}min ago while Mac idle`);
  }
  // Fix 4: inference threshold — macIdle > 20 (was 12), and phoneUsageInferred already requires > 15
  if (obs.phoneUsageInferred && obs.macIdleMinutes > 20 &&
      (obs.timeOfDay === 'morning' || obs.timeOfDay === 'afternoon')) {
    return speakDecision('medium', 1, 'haiku',
      `Mac idle ${obs.macIdleMinutes}min during work hours — phone use likely`);
  }

  // ── Gate 6: Proactive intelligence ────────────────────────────────────────
  if (obs.sessionFocusMinutes > 90 && obs.lastBreakMinutes > 90) {
    return speakDecision('medium', 1, 'haiku', 'No break in 90+ minutes of focus');
  }

  // Fix 3: reading threshold 20 → 35 minutes
  if (obs.readingDetected && obs.readingMinutes >= 10 && obs.lastSpokenToAxonMinutes > 35) {
    return speakDecision('low', 1, 'haiku', `Reading detected for ${obs.readingMinutes}min — comprehension check`);
  }

  // Fix 2 & Fix 3: screen change — significance > 60 threshold + 30 → 45 min silence
  if (obs.screenChanged &&
      obs.screenChangeSignificance > 60 &&
      obs.screenProductivitySignal === 'productive' &&
      obs.lastSpokenToAxonMinutes > 45) {
    return speakDecision('low', 1, 'haiku',
      `Significant productive screen change (score ${obs.screenChangeSignificance}) — proactive comment opportunity`);
  }

  // Fix 3: open commitments morning check 60 → 90 minutes
  if (obs.timeOfDay === 'morning' && obs.openCommitments > 0 && obs.lastSpokenToAxonMinutes > 90) {
    return speakDecision('low', 1, 'haiku', `${obs.openCommitments} open commitments — morning check-in`);
  }

  if (obs.nextEventMinutes !== null && obs.nextEventMinutes <= 30 && obs.nextEventMinutes > 15) {
    return actSilentlyDecision(`Prepare context for: ${obs.nextEventTitle}`, 'haiku');
  }

  // Fix 3: weekly plan deviation 45 → 60 minutes
  if (obs.weeklyPlanToday && obs.todayPriority &&
      obs.screenProductivitySignal !== 'productive' &&
      obs.timeOfDay === 'morning' && obs.lastSpokenToAxonMinutes > 60) {
    return speakDecision('low', 1, 'haiku', 'Morning hours — not aligned with today priority');
  }

  if (obs.energyLevel === 'low' && obs.screenProductivitySignal === 'distraction' &&
      obs.lastInterventionMinutes > 30) {
    return speakDecision('medium', 2, 'haiku', 'Low energy + distraction — vulnerable window');
  }

  if (obs.screenProductivitySignal === 'productive' &&
      obs.nextEventMinutes !== null && obs.nextEventMinutes <= 45) {
    return actSilentlyDecision('Research/prep for upcoming calendar event', 'haiku');
  }

  return watchDecision('No action needed — observing', 100);
}

// ── Model routing ──────────────────────────────────────────────────────────────

async function routeByTier(tier: CognitiveDecision['modelTier'], prompt: string): Promise<string> {
  const model = tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 150,
      messages:   [{ role: 'user', content: prompt }],
    });
    recordTokens(model, resp.usage.input_tokens, resp.usage.output_tokens);
    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    return block?.text.trim() ?? '';
  } catch (e) {
    console.warn('[CognitiveEngine] routeByTier error:', e);
    return '';
  }
}

// ── Execute speak ──────────────────────────────────────────────────────────────

async function executeSpeak(obs: ObservationState, decision: CognitiveDecision): Promise<void> {
  if (isSpeaking || isConversationActive()) return;

  // Track hourly speak count
  speaksThisHour++;

  // First-week: prepend learning note on first speak of each day
  const todayStr         = new Date().toISOString().slice(0, 10);
  const firstSpeakToday  = isFirstWeek() && lastSpeakDateStr !== todayStr;
  if (firstSpeakToday) lastSpeakDateStr = todayStr;

  const hasPhoneActivity = obs.phoneSummary &&
    !obs.phoneSummary.startsWith('No phone activity');

  const phonePart = hasPhoneActivity
    ? `\nPHONE ACTIVITY: ${obs.phoneSummary}\nIf phone drift is the reason for this intervention, reference it specifically and directly.`
    : '';

  const prompt = `${ARETICA_VISION}

CURRENT OBSERVATION STATE:
- Active app: ${obs.activeApp} (${obs.activeAppMinutes} min)
- Previous app: ${obs.previousApp}
- Time: ${obs.currentHour}:${String(obs.currentMinute).padStart(2, '0')} ${obs.dayOfWeek}
- Drift score: ${obs.driftScore}/100 (tier ${obs.driftTier})
- Session focus: ${obs.sessionFocusMinutes} minutes
- Last break: ${obs.lastBreakMinutes} minutes ago
- Energy level: ${obs.energyLevel}
- Today's priority: ${obs.todayPriority || 'not set'}
- Next event: ${obs.nextEventTitle ? `${obs.nextEventTitle} in ${obs.nextEventMinutes}min` : 'none'}
- Mac idle: ${obs.macIdleMinutes}min | Phone inferred: ${obs.phoneUsageInferred} | Confirmed: ${obs.phoneConfirmedDistraction}
- Screen: ${obs.screenSummary}
- Open commitments: ${obs.openCommitments}
- Consecutive failed interventions: ${obs.consecutiveFailedInterventions}
- Relevant facts: ${obs.relevantFacts.join(', ')}${phonePart}

DECISION REASON: ${decision.reason}
INTERVENTION TIER: ${decision.interventionTier}

Generate a single intervention. Apply the Aretica Vision — does this move Isaac closer to his fullest self?

Rules:
- Maximum 2 sentences
- Direct, accurate, no filler
- Reference specific data from the observation state — not generic advice
- Tier 1: predictive, gentle. Tier 2: direct, firm. Tier 3: confrontational, use the war statement if needed
- If phone use is confirmed or inferred, name it directly
- Do not ask questions unless tier 1
- Silence is better than a bad intervention
- No markdown, no quotes, just the spoken words
- Respond with exactly "SKIP" if silence is better right now${firstSpeakToday ? '\n- This is your first proactive message of the day during Axon\'s learning week. Begin with: "Still learning your patterns — I\'ll get more accurate over time." Then continue with the intervention.' : ''}`;

  const message = await routeByTier(decision.modelTier, prompt);
  if (!message || message.trim().toUpperCase() === 'SKIP') return;

  if (!(await acquireSpeakerLock(60_000))) {
    console.log('[CognitiveEngine] speaker lock held — skipping');
    return;
  }

  try {
    setLastProactiveMessage(message,
      decision.interventionTier === 3 ? 'recovery' :
      decision.interventionTier === 2 ? 'early'    : 'predictive',
    );

    await speak(message);
    recordInterventionFired();

    // Fix 1 & Fix 6: update cooldown timestamp and daily budget
    lastProactiveSpeakAt = Date.now();
    dailySpeakBudget.count++;
    console.log(`[CognitiveEngine] daily speaks: ${dailySpeakBudget.count}/${dailySpeakBudget.maxPerDay}`);

    logIntervention({
      timestamp:     new Date().toISOString(),
      type:          decision.interventionTier === 3 ? 'recovery' :
                     decision.interventionTier === 2 ? 'early'    : 'predictive',
      message,
      appContext:    obs.activeApp,
      driftMinutes:  obs.activeAppMinutes,
      userResponded: false,
    });

    if (onTrigger && !isConversationActive()) {
      onTrigger();
    }
  } finally {
    await releaseSpeakerLock();
  }
}

// ── Execute silent task ────────────────────────────────────────────────────────

async function executeSilentTask(obs: ObservationState, decision: CognitiveDecision): Promise<void> {
  if (!decision.silentTask) return;
  console.log(`[CognitiveEngine] running silent task: ${decision.silentTask}`);

  runSilentTask({
    task:    decision.silentTask,
    context: `Isaac has ${obs.nextEventTitle ?? 'an event'} in ${obs.nextEventMinutes ?? '?'} minutes. Screen: ${obs.screenSummary}`,
    model:   decision.modelTier,
    onComplete: (result) => {
      console.log(`[CognitiveEngine] silent task complete: ${result.slice(0, 100)}`);
      storeSessionContext('last_silent_task', result);
    },
  });
}

// ── Execute block (soft lock) ──────────────────────────────────────────────────

async function executeSoftLock(obs: ObservationState): Promise<void> {
  if (!obs.weeklyPlanToday?.softLockStart) return;

  const plan  = obs.weeklyPlanToday;
  const nowDt = new Date();
  const durMs = plan.softLockEnd
    ? (() => {
        const [h, m] = (plan.softLockEnd).split(':').map(Number);
        const end = new Date();
        end.setHours(h, m, 0, 0);
        return Math.max(1, end.getTime() - nowDt.getTime());
      })()
    : 90 * 60_000;

  const durMin = Math.max(1, Math.round(durMs / 60_000));
  console.log(`[CognitiveEngine] activating scheduled soft lock (${durMin}min)`);
  await activateSoftLock(plan.notes || 'Scheduled session', durMin);
}

// ── Main loop ──────────────────────────────────────────────────────────────────

export async function startCognitiveLoop(onTriggerFn?: () => void): Promise<void> {
  if (cognitiveLoopRunning) return;
  cognitiveLoopRunning = true;
  if (onTriggerFn) onTrigger = onTriggerFn;
  console.log('[CognitiveEngine] starting 60-second cognitive loop');

  while (cognitiveLoopRunning) {
    try {
      const obs      = await collectObservations();
      const decision = evaluateDecision(obs);

      console.log(
        `[CognitiveEngine] Mac idle: ${obs.macIdleMinutes}min | ` +
        `Phone distraction: ${obs.phoneConfirmedDistraction} | ` +
        `action: ${decision.action} | reason: ${decision.reason} | confidence: ${decision.confidence}%`,
      );

      await checkWeeklyPlanTiming().catch(() => {});
      void checkMorningBriefingTrigger().catch(() => {});

      switch (decision.action) {
        case 'speak':
          await executeSpeak(obs, decision);
          break;
        case 'act_silently':
          await executeSilentTask(obs, decision);
          break;
        case 'block':
          await executeSoftLock(obs);
          break;
        case 'watch':
        case 'update_model':
          break;
      }
    } catch (err) {
      console.error('[CognitiveEngine] loop error:', err);
    }

    await new Promise(r => setTimeout(r, 60_000));
  }
}

export function stopCognitiveLoop(): void {
  cognitiveLoopRunning = false;
}

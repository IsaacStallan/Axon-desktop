import Anthropic                            from '@anthropic-ai/sdk';
import { speak, isSpeaking }                from './elevenLabsService';
import { getCurrentApp, getProductivityScore } from './windowMonitor';
import { getGoalsText }                    from './goalService';
import { getOpenCommitmentsText }          from './commitmentTracker';
import { isConversationActive }            from './conversationService';
import {
  getUserProfile,
  logIntervention,
  logOverride,
  updateInterventionOutcome,
  getRecentInterventions,
  type InterventionRecord,
} from './behaviourModel';
import { executeEnvironmentalAction }      from './environmentalControl';
import {
  acquireSpeakerLock,
  releaseSpeakerLock,
  getCrossDeviceContext,
} from './deviceCoordinator';
import { route, type TaskType }            from './modelRouter';
import { buildFraming }                    from './psychologyLayer';
import { setLastProactiveMessage }         from './proactiveContext';
import { getRecentContext }                from './screenAwareness';
import { getTodayEvents, type CalendarEvent } from './calendarService';
import { AXON_CAPABILITIES }               from './axonCapabilities';
import type { PatternResult }              from './patternEngine';
import type { ScreenContext }              from './screenAwareness';

// ── Types ──────────────────────────────────────────────────────────────────────

type ActivityMode =
  | 'deep_work'      // coding, building, creating
  | 'studying'       // reading, notes, research
  | 'communication'  // email, Slack, messages
  | 'planning'       // calendar, todo, Notion
  | 'distraction'    // social, video, games
  | 'idle';          // nothing productive visible

// ── Constants (mutable — weeklyReview can adjust via setInterventionGap) ──────

let INTERVENTION_GAP_MS   = 25 * 60_000;      // 25 min between drift interventions
const BREAK_GAP_MS        = 2 * 60 * 60_000;  // 2 hours between break suggestions
const OUTCOME_DELAY_MS    = 10 * 60_000;       // check course-correction after 10 min
const CONTENT_CHECK_MS    = 2 * 60_000;        // content quality check every 2 min
const CONTENT_COOLDOWN_MS = 10 * 60_000;       // 10 min between content feedback

export function setInterventionGap(ms: number): void {
  INTERVENTION_GAP_MS = ms;
  console.log(`[InterventionDecider] gap adjusted to ${Math.round(ms / 60_000)}min`);
}

export function getInterventionGap(): number {
  return INTERVENTION_GAP_MS;
}

// ── State ──────────────────────────────────────────────────────────────────────

let lastInterventionTime = 0;
let lastBreakTime        = 0;
let onTrigger: (() => void) | null = null;

let pendingOutcome: {
  id:            string;
  scoreAtFiring: number;
  checkAt:       number;
} | null = null;

// Mode 1: content quality
const client              = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
let contentCheckTimer: NodeJS.Timeout | undefined;
let lastContentHash       = 0;
let lastContentFeedbackTime = 0;

// Mode 3: activity mode tracking
let studyModeStartTime: number | null       = null;
let communicationModeStartTime: number | null = null;
let comprehensionOfferFired = false;
let communicationFlagFired  = false;

// Mode 4: calendar timing
let calendarEvents: CalendarEvent[] = [];
let calendarLoadedDate              = '';
const firedCalendarWarnings         = new Set<string>();
let firedWindowWarnings             = new Set<string>();
let lastWindowWarningDate           = '';

// ── Public: register conversation trigger ─────────────────────────────────────

export function setConversationTrigger(fn: () => void): void {
  onTrigger = fn;
}

// ── Outcome tracking ───────────────────────────────────────────────────────────

export function checkPendingOutcome(): void {
  if (!pendingOutcome || Date.now() < pendingOutcome.checkAt) return;

  const currentScore = getProductivityScore();
  const improved     = currentScore > pendingOutcome.scoreAtFiring + 10;

  updateInterventionOutcome(pendingOutcome.id, improved);
  console.log(
    `[InterventionDecider] outcome: ${pendingOutcome.scoreAtFiring}% → ${currentScore}% — ` +
    (improved ? 'corrected ✓' : 'no change'),
  );
  pendingOutcome = null;
}

// ── Map intervention type → model tier ───────────────────────────────────────

function toTaskType(type: InterventionRecord['type']): TaskType {
  if (type === 'break')      return 'break_suggestion';
  if (type === 'recovery')   return 'goal_analysis';    // Tier 3 — Sonnet
  if (type === 'early')      return 'intervention';     // Tier 2 — Haiku
  return 'simple_reminder';                             // Tier 1 — Ollama
}

// ── Mode 3: Activity mode detection ───────────────────────────────────────────

function detectActivityMode(): ActivityMode {
  const contexts = getRecentContext();
  if (contexts.length === 0) return 'idle';
  const ctx = contexts[contexts.length - 1];

  if (ctx.productivitySignal === 'idle') return 'idle';

  const app  = ctx.activeApp.toLowerCase();
  const act  = ctx.activity.toLowerCase();
  const cont = ctx.visibleContent.toLowerCase();

  // Distracted signal — but research/reading in a browser isn't distraction
  if (ctx.productivitySignal === 'distracted') {
    if ((act.includes('read') || act.includes('research')) && !cont.includes('youtube')) {
      return 'studying';
    }
    return 'distraction';
  }

  if (
    act.includes('cod') || act.includes('devel') || act.includes('build') ||
    act.includes('creat') || act.includes('program') ||
    app.includes('vs code') || app.includes('xcode') || app.includes('warp') ||
    app.includes('terminal') || app.includes('cursor') || app.includes('intellij')
  ) return 'deep_work';

  if (
    act.includes('read') || act.includes('study') || act.includes('research') ||
    act.includes('notes') || act.includes('learn') ||
    app.includes('notion') || app.includes('obsidian') || app.includes('bear') ||
    app.includes('roam')
  ) return 'studying';

  if (
    app.includes('mail') || app.includes('outlook') || app.includes('slack') ||
    app.includes('messages') || app.includes('teams') || app.includes('discord') ||
    act.includes('email') || act.includes('messag') || act.includes('chat')
  ) return 'communication';

  if (
    app.includes('calendar') ||
    act.includes('plan') || act.includes('schedul') || act.includes('todo')
  ) return 'planning';

  return 'deep_work'; // productive but unclassified — treat as deep work
}

// ── Mode 1: Content quality helpers ───────────────────────────────────────────

function isWritingContext(ctx: ScreenContext): boolean {
  const act = ctx.activity.toLowerCase();
  const app = ctx.activeApp.toLowerCase();
  return (
    act.includes('writ') || act.includes('typ') || act.includes('compos') ||
    act.includes('draft') || act.includes('edit') || act.includes('cod') ||
    app.includes('mail') || app.includes('word') || app.includes('notion') ||
    app.includes('vs code') || app.includes('docs') || app.includes('pages') ||
    app.includes('cursor')
  );
}

function hashContent(s: string): number {
  let h = 0;
  const slice = s.slice(0, 300);
  for (let i = 0; i < slice.length; i++) {
    h = ((h << 5) - h) + slice.charCodeAt(i);
    h |= 0;
  }
  return h;
}

// ── Mode 1: Content quality check (runs on 2-min timer) ───────────────────────

async function checkContentQuality(): Promise<void> {
  if (isConversationActive() || isSpeaking) return;
  const now = Date.now();
  if (now - lastContentFeedbackTime < CONTENT_COOLDOWN_MS) return;

  const contexts = getRecentContext();
  if (contexts.length === 0) return;
  const ctx = contexts[contexts.length - 1];

  if (!isWritingContext(ctx) || !ctx.visibleContent.trim()) return;

  const hash = hashContent(ctx.visibleContent);
  if (hash === lastContentHash) return;

  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{
        role:    'user',
        content:
          'The user is writing the following content. Evaluate it briefly:\n' +
          '- Is there a clear error, weak argument, or obvious improvement?\n' +
          '- Is the code buggy, inefficient, or poorly structured?\n' +
          '- Is the writing unclear, defensive, or missing the point?\n' +
          'If yes to any — provide ONE specific, actionable suggestion in 1-2 sentences.\n' +
          'If the content looks fine — respond with exactly "OK".\n' +
          'Only intervene if there\'s something genuinely worth saying.\n\n' +
          `Content:\n${ctx.visibleContent.slice(0, 800)}`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const text  = block?.text.trim() ?? 'OK';

    lastContentHash = hash;
    if (text.toUpperCase() === 'OK') return;

    lastContentFeedbackTime = now;
    if (isSpeaking || isConversationActive()) return;

    console.log(`[InterventionDecider] content quality: "${text.slice(0, 80)}"`);
    setLastProactiveMessage(text, 'predictive');

    if (await acquireSpeakerLock(30_000)) {
      try {
        await speak(text);
      } finally {
        await releaseSpeakerLock();
      }
    }
    if (onTrigger && !isConversationActive()) onTrigger();
  } catch (e) {
    console.warn('[InterventionDecider] content quality check error:', e);
  }
}

// ── Pre-written intervention fire (Modes 3 + 4) ───────────────────────────────

async function firePrewritten(message: string, type: InterventionRecord['type']): Promise<void> {
  if (isSpeaking || isConversationActive()) return;
  const curr = getCurrentApp();

  const record = logIntervention({
    timestamp:     new Date().toISOString(),
    type,
    message,
    appContext:    curr.name,
    driftMinutes:  curr.durationMins,
    userResponded: false,
  });

  setLastProactiveMessage(message, type);
  console.log(`[InterventionDecider] ${type} prewritten: "${message.slice(0, 80)}"`);

  if (!(await acquireSpeakerLock(60_000))) return;
  try {
    await speak(message);
    pendingOutcome = {
      id:            record.id,
      scoreAtFiring: getProductivityScore(),
      checkAt:       Date.now() + OUTCOME_DELAY_MS,
    };
    if (onTrigger && !isConversationActive()) onTrigger();
  } finally {
    await releaseSpeakerLock();
  }
}

// ── Mode 4: Calendar timing checks ────────────────────────────────────────────

async function loadCalendarIfNeeded(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (calendarLoadedDate === today) return;

  calendarLoadedDate = today;
  firedCalendarWarnings.clear();

  if (lastWindowWarningDate !== today) {
    firedWindowWarnings   = new Set<string>();
    lastWindowWarningDate = today;
  }

  try {
    calendarEvents = await getTodayEvents(1);
    console.log(`[InterventionDecider] loaded ${calendarEvents.length} calendar events`);
  } catch {
    calendarEvents = [];
  }
}

async function checkCalendarTimings(): Promise<boolean> {
  if (isConversationActive() || isSpeaking) return false;
  if (Date.now() - lastInterventionTime < INTERVENTION_GAP_MS) return false;

  await loadCalendarIfNeeded();

  const now  = Date.now();
  const hour = new Date().getHours();
  const min  = new Date().getMinutes();

  // Per-event warnings at 45 min and 20 min
  for (const event of calendarEvents) {
    const minsUntil = (event.startMs - now) / 60_000;

    if (minsUntil > 44 && minsUntil <= 46) {
      const key = `${event.title}_45`;
      if (!firedCalendarWarnings.has(key)) {
        firedCalendarWarnings.add(key);
        lastInterventionTime = now;
        await firePrewritten(
          `You've got ${event.title} in 45 minutes. Worth wrapping up what you're doing.`,
          'predictive',
        );
        return true;
      }
    }

    if (minsUntil > 19 && minsUntil <= 21) {
      const key = `${event.title}_20`;
      if (!firedCalendarWarnings.has(key)) {
        firedCalendarWarnings.add(key);
        lastInterventionTime = now;
        const activityMode = detectActivityMode();
        const msg = activityMode === 'deep_work'
          ? `${event.title} in 20 minutes — you're still deep in it. Time to find a stopping point.`
          : `${event.title} in 20 minutes. Time to wrap up.`;
        await firePrewritten(msg, 'early');
        return true;
      }
    }
  }

  // End-of-productive-window warnings (1pm and 5:30pm)
  if (hour === 12 && min >= 45 && !firedWindowWarnings.has('1pm')) {
    firedWindowWarnings.add('1pm');
    lastInterventionTime = now;
    await firePrewritten(
      'Your focus window closes in 15 minutes. What are you finishing before then?',
      'predictive',
    );
    return true;
  }

  if (hour === 17 && min >= 15 && min < 30 && !firedWindowWarnings.has('530pm')) {
    firedWindowWarnings.add('530pm');
    lastInterventionTime = now;
    await firePrewritten(
      'Your focus window closes in 15 minutes. What are you finishing before then?',
      'predictive',
    );
    return true;
  }

  return false;
}

// ── Message generation (Mode 2: screen-informed) ──────────────────────────────

async function generateMessage(
  pattern: PatternResult,
  type:    InterventionRecord['type'],
): Promise<string> {
  const curr    = getCurrentApp();
  const hour    = new Date().getHours();
  const goals   = getGoalsText();
  const commits = getOpenCommitmentsText();
  const profile = getUserProfile();

  const today      = new Date().toISOString().slice(0, 10);
  const todayCount = getRecentInterventions(1)
    .filter(r => r.timestamp.startsWith(today) && r.type !== 'break').length;

  const framing        = buildFraming({ pattern, type, interventionCount: todayCount });
  const crossDevice    = await getCrossDeviceContext().catch(() => ({ formattedSummary: '' }));
  const crossDeviceCtx = crossDevice.formattedSummary
    ? `\nCross-device context: ${crossDevice.formattedSummary}`
    : '';

  // Mode 2: enrich message with actual screen content
  const contexts  = getRecentContext();
  const screenCtx = contexts.length > 0 ? contexts[contexts.length - 1] : null;
  let screenDetail = '';

  if (screenCtx) {
    const app     = screenCtx.activeApp.toLowerCase();
    const visible = screenCtx.visibleContent;

    if (app.includes('youtube') && visible) {
      screenDetail = `\nScreen: Isaac is watching "${visible.slice(0, 80)}" on YouTube.`;
    } else if (
      (app.includes('safari') || app.includes('chrome') || app.includes('firefox') || app.includes('arc')) &&
      visible
    ) {
      screenDetail = `\nScreen: ${screenCtx.activity}${screenCtx.notes ? ` — ${screenCtx.notes}` : ''}.`;
    } else if (
      (app.includes('vs code') || app.includes('cursor') || app.includes('warp')) &&
      screenCtx.productivitySignal === 'productive' &&
      !screenCtx.activity.toLowerCase().includes('edit') &&
      curr.durationMins > 10
    ) {
      screenDetail = `\nScreen: VS Code is open but appears idle for ~${Math.round(curr.durationMins)} minutes.`;
    }
  }

  const isBreak = type === 'break';

  const system = isBreak
    ? `You are Axon — Isaac's AI. He has been heads-down and genuinely needs a break.
Write ONE warm, specific spoken suggestion — 1–2 sentences.
Tone: generous and supportive, NOT critical. Acknowledge the work done, recommend the rest.
Be specific about duration. No markdown. No quotes. Just the spoken words.

${framing.instruction}

${AXON_CAPABILITIES}`
    : `You are Axon — an AI built specifically for Isaac.
Isaac is 20. Building House Stallan — financial freedom, empire, legacy. Biggest weakness: dopamine distraction.
${type === 'recovery' ? `\nIsaac's war statement:\n"${profile.recoveryMessage}"` : ''}
Generate ONE spoken intervention — 1–3 tight sentences.
Rules:
- Name the app and how long he has been on it
- ${type === 'recovery' ? 'Tier-3 mission-level: use the war statement. Cut to the core.' : 'Reference a goal or open commitment if relevant'}
- If screen detail is provided, use it: reference the video title, site, or what he is actually doing
- If cross-device context is provided, weave it in for maximum impact
- No markdown, no quotes, no filler. Just the spoken line.

${framing.instruction}

${AXON_CAPABILITIES}`;

  const user = isBreak
    ? `Isaac has been focused for ${Math.round(pattern.continuousFocusMins)} minutes straight.
Current app: ${curr.name}
Time: ${hour}:00
Write the break suggestion.`
    : `Isaac is on ${curr.name} for ${Math.round(curr.durationMins)} minutes.
Drift probability: ${pattern.driftProbability}% — ${pattern.reason}
Time: ${hour}:00
Goals:\n${goals || '(none set)'}
${commits ? `Open commitments:\n${commits}` : ''}${crossDeviceCtx}${screenDetail}
Write the intervention.`;

  console.log(`[InterventionDecider] techniques: ${framing.techniques.join(', ')}`);

  try {
    return await route({
      taskType:  toTaskType(type),
      system,
      prompt:    user,
      maxTokens: 120,
    });
  } catch (e) {
    console.warn('[InterventionDecider] message generation failed:', e);
    return '';
  }
}

// ── Fire ───────────────────────────────────────────────────────────────────────

async function fire(pattern: PatternResult, type: InterventionRecord['type']): Promise<void> {
  const curr    = getCurrentApp();
  const message = await generateMessage(pattern, type);
  if (!message) return;

  const record = logIntervention({
    timestamp:     new Date().toISOString(),
    type,
    message,
    appContext:    curr.name,
    driftMinutes:  curr.durationMins,
    userResponded: false,
  });

  if (isSpeaking) {
    console.log('[InterventionDecider] already speaking — dropping intervention');
    return;
  }

  setLastProactiveMessage(message, type);
  console.log(`[InterventionDecider] ${type}: "${message.slice(0, 80)}"`);
  await speak(message);

  // ── Tier 2 / 3: Environmental action (mac-only) ────────────────────────────
  if (process.platform === 'darwin' && (type === 'early' || type === 'recovery')) {
    const warnSecs = type === 'recovery' ? 15 : 30;
    const { overridden, question } = await executeEnvironmentalAction(
      curr.name,
      warnSecs,
      speak,
      (appName) => {
        logOverride({
          timestamp: new Date().toISOString(),
          appName,
          hour: new Date().getHours(),
        });
      },
    );

    if (!overridden && !isSpeaking) {
      setLastProactiveMessage(question, 'env_question');
      await speak(question);
    }
  }

  pendingOutcome = {
    id:            record.id,
    scoreAtFiring: getProductivityScore(),
    checkAt:       Date.now() + OUTCOME_DELAY_MS,
  };

  if (onTrigger && !isConversationActive()) {
    onTrigger();
  }
}

// ── Speaker-lock-wrapped fire ──────────────────────────────────────────────────

async function fireWithLock(pattern: PatternResult, type: InterventionRecord['type']): Promise<void> {
  if (!(await acquireSpeakerLock(60_000))) {
    console.log('[InterventionDecider] speaker lock held by another device — skipping');
    return;
  }
  try {
    await fire(pattern, type);
  } finally {
    await releaseSpeakerLock();
  }
}

// ── Decision tree ──────────────────────────────────────────────────────────────

export async function evaluate(pattern: PatternResult): Promise<void> {
  checkPendingOutcome();

  if (isConversationActive()) return;
  if (isSpeaking) return;

  // Start content quality checker on first evaluate (Mode 1)
  if (!contentCheckTimer) {
    contentCheckTimer = setInterval(() => { void checkContentQuality(); }, CONTENT_CHECK_MS);
    console.log('[InterventionDecider] content quality checker started (2-min tick)');
  }

  const now          = Date.now();
  const activityMode = detectActivityMode();

  // ── Mode 4: Calendar timing (independent of drift threshold) ────────────────
  const calendarFired = await checkCalendarTimings();
  if (calendarFired) return;

  // ── Mode 3: Studying — offer comprehension check after 45 min ───────────────
  if (activityMode === 'studying') {
    if (!studyModeStartTime) { studyModeStartTime = now; comprehensionOfferFired = false; }
    const studyMins = (now - studyModeStartTime) / 60_000;
    if (studyMins >= 45 && !comprehensionOfferFired && now - lastInterventionTime > INTERVENTION_GAP_MS) {
      comprehensionOfferFired = true;
      lastInterventionTime    = now;
      await firePrewritten(
        `You've been reading for ${Math.round(studyMins)} minutes. Want me to ask you 3 questions to lock in what you've covered?`,
        'break',
      );
      return;
    }
  } else {
    studyModeStartTime      = null;
    comprehensionOfferFired = false;
  }

  // ── Mode 3: Communication — flag if spending too long (20+ min) ─────────────
  if (activityMode === 'communication') {
    if (!communicationModeStartTime) { communicationModeStartTime = now; communicationFlagFired = false; }
    const commMins = (now - communicationModeStartTime) / 60_000;
    const curr     = getCurrentApp();
    if (commMins >= 20 && !communicationFlagFired && now - lastInterventionTime > INTERVENTION_GAP_MS) {
      communicationFlagFired = true;
      lastInterventionTime   = now;
      await firePrewritten(
        `You've been in ${curr.name} for ${Math.round(commMins)} minutes. Is this the highest value use of this time?`,
        'predictive',
      );
      return;
    }
  } else {
    communicationModeStartTime = null;
    communicationFlagFired     = false;
  }

  // ── Ignored intervention streak ────────────────────────────────────────────
  if (pattern.ignoredInterventionStreak >= 3 && now - lastInterventionTime > INTERVENTION_GAP_MS) {
    lastInterventionTime = now;
    await fireWithLock(pattern, 'early');
    return;
  }

  // ── Break suggestion (independent cooldown) ────────────────────────────────
  if (pattern.breakRecommended && now - lastBreakTime > BREAK_GAP_MS) {
    lastBreakTime = now;
    await fireWithLock(pattern, 'break');
    return;
  }

  // ── Drift interventions ────────────────────────────────────────────────────
  if (now - lastInterventionTime < INTERVENTION_GAP_MS) return;

  const { driftProbability, tier, isCompoundVulnerable } = pattern;

  // Mode 3: deep_work protection — raise all thresholds to 85%
  const protected85 = activityMode === 'deep_work';

  const shouldFire =
    isCompoundVulnerable ||
    (tier === 'recovery'   && driftProbability >= 85) ||
    (tier === 'early'      && driftProbability >= (protected85 ? 85 : 70)) ||
    (tier === 'predictive' && driftProbability >= (protected85 ? 85 : 60));

  if (!shouldFire) return;

  lastInterventionTime = now;
  await fireWithLock(pattern, tier);
}

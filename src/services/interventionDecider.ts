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
  updateInterventionUserResponded,
  getRecentInterventions,
  getPatternForCurrentContext,
  type InterventionRecord,
} from './behaviourModel';
import { executeEnvironmentalAction }      from './environmentalControl';
import {
  acquireSpeakerLock,
  releaseSpeakerLock,
  getCrossDeviceContext,
} from './deviceCoordinator';
import { route, type TaskType }            from './modelRouter';
import { recordInterventionFired }         from './rateLimiter';
import { buildFraming }                    from './psychologyLayer';
import { setLastProactiveMessage }         from './proactiveContext';
import {
  getEmotionPromptFragment,
  updateEmotionState,
}                                          from './emotionEngine';
import { getRecentContext }                from './screenAwareness';
import { getTodayEvents, type CalendarEvent } from './calendarService';
import { AXON_CAPABILITIES }               from './axonCapabilities';
import { ARETICA_VISION }                  from './areticaVision';
import type { PatternResult }              from './patternEngine';
import type { ScreenContext }              from './screenAwareness';
import { contributeInterventionOutcome, getDaysSinceOnboarding } from './collectiveIntelligence';

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
  id:             string;
  scoreAtFiring:  number;
  firedAt:        number;
  respondCheckAt: number;   // T+2min — voice response window
  earlyCheckAt:   number;   // T+5min — first productivity check
  checkAt:        number;   // T+10min — definitive outcome
  respondChecked: boolean;
  earlyChecked:   boolean;
  earlyPositive:  boolean;
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
  if (!pendingOutcome) return;
  const now = Date.now();
  const o   = pendingOutcome;

  // Phase 1 — T+2min: check if user responded with voice
  if (!o.respondChecked && now >= o.respondCheckAt) {
    o.respondChecked = true;
    if (isConversationActive()) {
      updateInterventionUserResponded(o.id);
      console.log('[InterventionDecider] outcome phase 1: user responded within 2 minutes');
    }
  }

  // Phase 2 — T+5min: early productivity signal
  if (!o.earlyChecked && now >= o.earlyCheckAt) {
    o.earlyChecked = true;
    const curr         = getCurrentApp();
    const currentScore = getProductivityScore();
    const scoreUp      = currentScore >= o.scoreAtFiring + 15;
    const inProdApp    = curr.label === 'positive';
    o.earlyPositive    = scoreUp || inProdApp;
    console.log(
      `[InterventionDecider] outcome phase 2 (5min): score ${o.scoreAtFiring}% → ${currentScore}%` +
      `, productive app: ${inProdApp}, early positive: ${o.earlyPositive}`,
    );
  }

  // Phase 3 — T+10min: definitive outcome
  if (now >= o.checkAt) {
    const curr            = getCurrentApp();
    const currentScore    = getProductivityScore();
    const scoreUp         = currentScore >= o.scoreAtFiring + 15;
    const inProdApp       = curr.label === 'positive';
    const courseCorrected = scoreUp || inProdApp || o.earlyPositive;

    updateInterventionOutcome(o.id, courseCorrected);
    console.log(
      `[InterventionDecider] outcome phase 3 (10min): ${o.scoreAtFiring}% → ${currentScore}%` +
      `, productive app: ${inProdApp}, early signal: ${o.earlyPositive}` +
      ` — ${courseCorrected ? 'corrected ✓' : 'no change ✗'}`,
    );
    if (!courseCorrected) updateEmotionState('intervention_ignored');

    // Contribute anonymised outcome to collective intelligence (fire-and-forget)
    try {
      const record = getRecentInterventions(7).find(r => r.id === o.id);
      if (record) {
        const firedDate = new Date(o.firedAt);
        const firedHour = firedDate.getHours();
        const timeOfDay =
          firedHour < 6  ? 'early_morning' :
          firedHour < 12 ? 'morning' :
          firedHour < 17 ? 'afternoon' :
          firedHour < 21 ? 'evening' : 'night';
        void contributeInterventionOutcome({
          interventionType:    record.type,
          tier:                record.type === 'recovery' ? 3 : record.type === 'early' ? 2 : 1,
          appContext:           record.appContext,
          timeOfDay,
          dayOfWeek:           firedDate.toLocaleDateString('en-AU', { weekday: 'long' }),
          energyLevel:         'unknown',
          driftScore:          o.scoreAtFiring,
          daysSinceOnboarding: getDaysSinceOnboarding(),
          messageLength:       record.message.length,
          courseCorrection:    courseCorrected,
          responseTimeSeconds: 0,
        });
      }
    } catch { /* non-blocking */ }

    pendingOutcome = null;
  }
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
    recordInterventionFired();
    const firedAt2 = Date.now();
    pendingOutcome = {
      id:             record.id,
      scoreAtFiring:  getProductivityScore(),
      firedAt:        firedAt2,
      respondCheckAt: firedAt2 + 2 * 60_000,
      earlyCheckAt:   firedAt2 + 5 * 60_000,
      checkAt:        firedAt2 + OUTCOME_DELAY_MS,
      respondChecked: false,
      earlyChecked:   false,
      earlyPositive:  false,
    };
    if (onTrigger && !isConversationActive()) onTrigger();
  } finally {
    await releaseSpeakerLock();
  }
}

// ── Mode 4: Calendar classification + blocking ─────────────────────────────────

type CalendarEventType =
  | 'work_block'   // deep work, study, coding sessions
  | 'meeting'      // calls, standups, interviews
  | 'personal'     // gym, meals, church, social
  | 'travel'       // flights, drives, commutes
  | 'free'         // breaks, rest, holidays
  | 'unknown';     // anything else

/** Assume 1-hour duration when CalendarEvent has no endMs. */
const DEFAULT_EVENT_DURATION_MS = 60 * 60_000;

const WORK_BLOCK_KW  = ['study', 'assignment', 'uni', 'work', 'deep work', 'focus', 'axon', 'grantforge', 'crest', 'coding', 'writing', 'research', 'homework'];
const MEETING_KW     = ['meeting', 'call', 'standup', 'interview', 'sync', '1:1', 'zoom', 'teams', 'catch up', 'chat'];
const PERSONAL_KW    = ['gym', 'lunch', 'dinner', 'breakfast', 'church', 'futsal', 'sport', 'house stallan', 'family', 'friends', 'social', 'party', 'date'];
const TRAVEL_KW      = ['flight', 'drive', 'commute', 'travel', 'uber', 'train', 'bus'];
const FREE_KW        = ['free', 'break', 'rest', 'holiday', 'off', 'personal time'];

/** In-memory cache: title → type, persists for the process lifetime. */
const eventTypeCache = new Map<string, CalendarEventType>();

function classifyByKeyword(title: string): CalendarEventType | null {
  const t = title.toLowerCase();
  if (WORK_BLOCK_KW.some(k => t.includes(k)))  return 'work_block';
  if (MEETING_KW.some(k => t.includes(k)))      return 'meeting';
  if (PERSONAL_KW.some(k => t.includes(k)))     return 'personal';
  if (TRAVEL_KW.some(k => t.includes(k)))       return 'travel';
  if (FREE_KW.some(k => t.includes(k)))         return 'free';
  return null;
}

async function classifyCalendarEvent(title: string): Promise<CalendarEventType> {
  if (eventTypeCache.has(title)) return eventTypeCache.get(title)!;

  // Pass 1 — keyword matching (no API call)
  const kwResult = classifyByKeyword(title);
  if (kwResult) {
    eventTypeCache.set(title, kwResult);
    return kwResult;
  }

  // Pass 2 — Haiku classification
  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages:   [{
        role:    'user',
        content:
          `Classify this calendar event title into one of: work_block, meeting, personal, travel, free, unknown.\n` +
          `Title: "${title}"\n` +
          `Respond with only the category word.`,
      }],
    });
    const block  = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const raw    = block?.text.trim().toLowerCase() ?? '';
    const valid: CalendarEventType[] = ['work_block', 'meeting', 'personal', 'travel', 'free', 'unknown'];
    const result: CalendarEventType  = valid.includes(raw as CalendarEventType)
      ? (raw as CalendarEventType)
      : 'unknown';
    eventTypeCache.set(title, result);
    return result;
  } catch {
    eventTypeCache.set(title, 'unknown');
    return 'unknown';
  }
}

interface CalendarBlockStatus {
  eventType:    CalendarEventType;
  eventName:    string;
  active:       boolean;   // currently inside an event window
  driftBlocked: boolean;   // event starts within 10 minutes (wrap-up window)
}

async function getCalendarBlockStatus(): Promise<CalendarBlockStatus> {
  const now = Date.now();
  const none: CalendarBlockStatus = { eventType: 'unknown', eventName: '', active: false, driftBlocked: false };

  // Check if currently inside an event
  for (const event of calendarEvents) {
    const endMs = event.startMs + DEFAULT_EVENT_DURATION_MS;
    if (now >= event.startMs && now < endMs) {
      const eventType = await classifyCalendarEvent(event.title);
      return { eventType, eventName: event.title, active: true, driftBlocked: true };
    }
  }

  // Check 10-minute wrap-up window
  for (const event of calendarEvents) {
    const minsUntil = (event.startMs - now) / 60_000;
    if (minsUntil > 0 && minsUntil <= 10) {
      const eventType = await classifyCalendarEvent(event.title);
      return { eventType, eventName: event.title, active: false, driftBlocked: true };
    }
  }

  return none;
}

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
  pattern:   PatternResult,
  type:      InterventionRecord['type'],
  eventType?: CalendarEventType,
  eventName?: string,
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

  const isBreak     = type === 'break';
  const emotionFrag = getEmotionPromptFragment();

  // Calendar context hint for the model
  const calendarHint = eventType && eventType !== 'unknown' && eventName
    ? eventType === 'work_block'
      ? `\nCalendar context: Isaac has "${eventName}" scheduled right now — this is a work block. ` +
        `If he is distracted, call it out directly: "You've got a work block scheduled right now and you're on ${curr.name} — that's exactly backwards."`
      : eventType === 'personal'
        ? `\nCalendar context: Isaac has "${eventName}" (personal block) on the calendar. Keep the tone light — this is a gentle check-in, not a hard push.`
        : ''
    : '';

  const areticaInstruction = `Before generating this intervention, apply the three Aretica principles. Would this intervention move Isaac closer to his fullest self? Is it accurate rather than comfortable? Generate accordingly.`;

  const system = isBreak
    ? `You are Axon — Isaac's AI. He has been heads-down and genuinely needs a break.
Write ONE warm, specific spoken suggestion — 1–2 sentences.
Tone: generous and supportive, NOT critical. Acknowledge the work done, recommend the rest.
Be specific about duration. No markdown. No quotes. Just the spoken words.

${ARETICA_VISION}

${areticaInstruction}

${emotionFrag}

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
- If calendar context is provided, reference it — it makes the intervention sharper
- No markdown, no quotes, no filler. Just the spoken line.

${ARETICA_VISION}

${areticaInstruction}

${emotionFrag}

${framing.instruction}

${AXON_CAPABILITIES}`;

  const behaviourPattern = getPatternForCurrentContext();
  const patternCtx = !isBreak
    ? `\nBehavioural pattern context:\n` +
      `- Isaac has opened ${behaviourPattern.currentApp} ${behaviourPattern.occurrenceCount} times in similar conditions\n` +
      `- Last ${Math.max(0, behaviourPattern.occurrenceCount - 1)} times this happened at this time of day, he stayed in this app for an average of ${behaviourPattern.avgDriftMinutes} minutes\n` +
      `- The app he was in before this was ${behaviourPattern.previousApp} for ${behaviourPattern.previousAppMinutes} minutes\n` +
      `- This pattern occurs most on ${behaviourPattern.commonDays}\n` +
      `Reference this specific pattern in your intervention. Not generically — specifically. "You opened ${behaviourPattern.currentApp} ${behaviourPattern.previousAppMinutes} minutes after closing ${behaviourPattern.previousApp}. That's happened ${behaviourPattern.occurrenceCount} times this week." That level of accuracy.`
    : '';

  const user = isBreak
    ? `Isaac has been focused for ${Math.round(pattern.continuousFocusMins)} minutes straight.
Current app: ${curr.name}
Time: ${hour}:00
Write the break suggestion.`
    : `Isaac is on ${curr.name} for ${Math.round(curr.durationMins)} minutes.
Drift probability: ${pattern.driftProbability}% — ${pattern.reason}
Time: ${hour}:00
Goals:\n${goals || '(none set)'}
${commits ? `Open commitments:\n${commits}` : ''}${crossDeviceCtx}${screenDetail}${calendarHint}${patternCtx}
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

async function fire(
  pattern:    PatternResult,
  type:       InterventionRecord['type'],
  eventType?: CalendarEventType,
  eventName?: string,
): Promise<void> {
  const curr    = getCurrentApp();
  const message = await generateMessage(pattern, type, eventType, eventName);
  if (!message) return;

  console.log(`[InterventionDecider] logging ${type} intervention to behaviourModel (app: ${curr.name})`);
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
  recordInterventionFired();

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

  const firedAt = Date.now();
  pendingOutcome = {
    id:             record.id,
    scoreAtFiring:  getProductivityScore(),
    firedAt,
    respondCheckAt: firedAt + 2 * 60_000,
    earlyCheckAt:   firedAt + 5 * 60_000,
    checkAt:        firedAt + OUTCOME_DELAY_MS,
    respondChecked: false,
    earlyChecked:   false,
    earlyPositive:  false,
  };

  if (onTrigger && !isConversationActive()) {
    onTrigger();
  }
}

// ── Speaker-lock-wrapped fire ──────────────────────────────────────────────────

async function fireWithLock(
  pattern:    PatternResult,
  type:       InterventionRecord['type'],
  eventType?: CalendarEventType,
  eventName?: string,
): Promise<void> {
  if (!(await acquireSpeakerLock(60_000))) {
    console.log('[InterventionDecider] speaker lock held by another device — skipping');
    return;
  }
  try {
    await fire(pattern, type, eventType, eventName);
  } finally {
    await releaseSpeakerLock();
  }
}

// ── Screen observer hooks ──────────────────────────────────────────────────────

/**
 * Called by screenObserver when a writing context is detected on screen change.
 * Triggers an immediate content quality check rather than waiting for the 2-min tick.
 */
export function triggerContentQualityCheck(): void {
  void checkContentQuality();
}

/**
 * Called by screenObserver when a distraction context is detected on screen change.
 * Scales the gap reduction based on confidence: higher confidence fires sooner.
 * confidence >= 80 → 2 min, >= 60 → 3 min, >= 50 → 5 min.
 */
export function flagDistractionContext(confidence: number): void {
  const minsTillFire = confidence >= 80 ? 2 : confidence >= 60 ? 3 : 5;
  const target = Date.now() - INTERVENTION_GAP_MS + minsTillFire * 60_000;
  if (lastInterventionTime > target) {
    lastInterventionTime = target;
    console.log(
      `[InterventionDecider] distraction flagged (confidence ${confidence}) — gap reduced to ${minsTillFire} min`,
    );
  }
  updateEmotionState('drift_detected');
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

  // Ensure today's calendar is loaded regardless of whether timing checks fire
  try { await loadCalendarIfNeeded(); } catch { /* proceed without calendar */ }

  const now          = Date.now();
  const activityMode = detectActivityMode();

  // ── Mode 4: Calendar timing (independent of drift threshold) ────────────────
  const calendarFired = await checkCalendarTimings();
  if (calendarFired) return;

  // ── Calendar-aware blocking ──────────────────────────────────────────────────
  const calBlock = await getCalendarBlockStatus();

  if (calBlock.active) {
    const { eventType, eventName } = calBlock;

    if (eventType === 'meeting') {
      console.log(`[Intervention] skipped — in meeting: ${eventName}`);
      return;
    }

    if (eventType === 'travel') {
      console.log(`[Intervention] skipped — in travel block: ${eventName}`);
      return;
    }

    if (eventType === 'work_block') {
      // Full interventions active — fall through with event context injected
    }

    if (eventType === 'personal') {
      // Gentle check-in only — Tier 1, no environmental control
      if (pattern.driftProbability < 60) return; // low drift → leave it entirely
      if (now - lastInterventionTime < INTERVENTION_GAP_MS) return;
      lastInterventionTime = now;
      await fireWithLock(pattern, 'predictive', eventType, eventName);
      return;
    }

    if (eventType === 'free') {
      // Break suggestions only — no drift/distraction interventions
      if (pattern.breakRecommended && now - lastBreakTime > BREAK_GAP_MS) {
        lastBreakTime = now;
        await fireWithLock(pattern, 'break', eventType, eventName);
      }
      return;
    }

    if (eventType === 'unknown') {
      // Light touch — Tier 1 only
      if (now - lastInterventionTime < INTERVENTION_GAP_MS) return;
      lastInterventionTime = now;
      await fireWithLock(pattern, 'predictive', eventType, eventName);
      return;
    }
  }

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
    await fireWithLock(pattern, 'early', calBlock.eventType, calBlock.eventName);
    return;
  }

  // ── Break suggestion (independent cooldown) ────────────────────────────────
  if (pattern.breakRecommended && now - lastBreakTime > BREAK_GAP_MS) {
    lastBreakTime = now;
    await fireWithLock(pattern, 'break', calBlock.eventType, calBlock.eventName);
    return;
  }

  // ── Drift interventions ────────────────────────────────────────────────────
  if (now - lastInterventionTime < INTERVENTION_GAP_MS) return;

  const { driftProbability, tier, isCompoundVulnerable } = pattern;

  // Event starts within 10 min — user is wrapping up; skip drift, allow recovery
  if (calBlock.driftBlocked && !calBlock.active && tier !== 'recovery') {
    console.log(`[Intervention] skipped — event "${calBlock.eventName}" starts within 10 minutes`);
    return;
  }

  // Mode 3: deep_work protection — raise all thresholds to 85%
  const protected85 = activityMode === 'deep_work';

  const shouldFire =
    isCompoundVulnerable ||
    (tier === 'recovery'   && driftProbability >= 85) ||
    (tier === 'early'      && driftProbability >= (protected85 ? 85 : 70)) ||
    (tier === 'predictive' && driftProbability >= (protected85 ? 85 : 60));

  if (!shouldFire) return;

  lastInterventionTime = now;
  await fireWithLock(pattern, tier, calBlock.eventType, calBlock.eventName);
}

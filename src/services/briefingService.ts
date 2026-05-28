import { speak, isSpeaking }        from './elevenLabsService';
import { setLastProactiveMessage }  from './proactiveContext';
import { getTodayEvents, getUpcomingEvent, formatEventTime } from './calendarService';
import { getPendingTasksText } from './taskStore';
import { getActiveGoals, hasGoals } from './goalService';
import { getOpenCommitments, markFollowedUp } from './commitmentTracker';
import { getDailyPlan } from './planningService';
import { isConversationActive } from './conversationService';

// ── Briefing helpers ──────────────────────────────────────────────────────────

/** Split text into two halves at a sentence boundary if it exceeds 400 words. */
function splitBriefingIfNeeded(text: string): [string, string] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 400) return null;

  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  if (sentences.length < 2) return null;

  const mid   = Math.ceil(sentences.length / 2);
  const first = sentences.slice(0, mid).join(' ').trim();
  const rest  = sentences.slice(mid).join(' ').trim();
  return rest ? [first, rest] : null;
}

// ── Config ────────────────────────────────────────────────────────────────────

const BRIEFING_HOUR        = parseInt(process.env.AXON_BRIEFING_HOUR ?? '8', 10);
const BRIEFING_CUTOFF_HOUR = 12;
const REMINDER_WINDOW_MINS = 30;
const REMINDER_COOLDOWN_MS = 35 * 60_000;

// ── State ─────────────────────────────────────────────────────────────────────

let lastBriefingDate  = '';
let lastReminderTitle = '';
let lastReminderTime  = 0;
let onTrigger: (() => void) | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Speak a message, then open the listening window so Isaac can respond
 * without needing to say the wake word.
 * Skips triggering if a conversation is already active.
 */
async function speakThenListen(message: string): Promise<void> {
  if (isSpeaking) {
    console.log('[Briefing] already speaking — skipping proactive message');
    return;
  }
  setLastProactiveMessage(message, 'briefing');
  try {
    await speak(message);
  } catch (e) {
    console.warn('[Briefing] speak failed:', e);
    return;
  }

  if (onTrigger && !isConversationActive()) {
    console.log('[Briefing] opening listening window after proactive speech');
    onTrigger();
  }
}

// ── Goal elicitation ──────────────────────────────────────────────────────────

/**
 * If Isaac has no goals set, Axon introduces itself and asks what he's
 * working toward — then immediately starts listening for his answer.
 */
async function runGoalElicitation(): Promise<void> {
  if (hasGoals()) return;

  console.log('[Briefing] no goals found — eliciting');
  const message =
    `Hey ${process.env.AXON_USER_NAME || 'there'} — I don't have any of your goals saved yet, and I need them to actually be useful to you. ` +
    "What are you working toward right now? Give me the one or two things that matter most.";

  await speakThenListen(message);
}

// ── Morning briefing ──────────────────────────────────────────────────────────

async function runMorningBriefing(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastBriefingDate === today) return;
  lastBriefingDate = today;

  console.log('[Briefing] running morning briefing');

  const [events, goals, commitments, tasks] = await Promise.all([
    getTodayEvents(),
    Promise.resolve(getActiveGoals()),
    Promise.resolve(getOpenCommitments()),
    Promise.resolve(getPendingTasksText()),
  ]);

  const plan = await getDailyPlan(events, goals, commitments, tasks);

  // Mark open commitments as followed up so they don't repeat in conversation
  for (const c of commitments) markFollowedUp(c.id);

  console.log('[Briefing] plan:', plan.spoken);

  const parts = splitBriefingIfNeeded(plan.spoken);
  if (parts) {
    // Briefing exceeds 400 words — deliver in two sequential TTS calls
    console.log('[Briefing] briefing split into 2 parts for TTS delivery');
    setLastProactiveMessage(plan.spoken, 'briefing');
    if (!isSpeaking) {
      try {
        await speak(parts[0]);
        await speak(parts[1]);
      } catch (e) {
        console.warn('[Briefing] speak failed:', e);
        return;
      }
      if (onTrigger && !isConversationActive()) {
        console.log('[Briefing] opening listening window after proactive speech');
        onTrigger();
      }
    }
  } else {
    await speakThenListen(plan.spoken);
  }
}

// ── Pre-event reminder ────────────────────────────────────────────────────────
// Reminders are informational only — no conversation trigger.

async function checkUpcomingEvents(): Promise<void> {
  const events   = await getTodayEvents();
  const upcoming = getUpcomingEvent(events, REMINDER_WINDOW_MINS);
  if (!upcoming) return;

  const now = Date.now();
  if (upcoming.title === lastReminderTitle && now - lastReminderTime < REMINDER_COOLDOWN_MS) return;

  lastReminderTitle = upcoming.title;
  lastReminderTime  = now;

  const minsAway = Math.round((upcoming.startMs - now) / 60_000);
  const message  = `Heads up — ${upcoming.title} in ${minsAway} minutes, at ${formatEventTime(upcoming)}.`;

  console.log('[Briefing] event reminder:', message);
  if (isSpeaking) {
    console.log('[Briefing] already speaking — skipping event reminder');
    return;
  }
  setLastProactiveMessage(message, 'reminder');
  try { await speak(message); } catch (e) { console.warn('[Briefing] reminder speak failed:', e); }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

export function startBriefingService(conversationTrigger: () => void): void {
  onTrigger = conversationTrigger;

  if (process.platform !== 'darwin') {
    console.log('[Briefing] non-macOS — calendar integration skipped');
    // Still run goal elicitation on non-macOS
    setTimeout(() => void runGoalElicitation(), 8_000);
    return;
  }

  checkOnStartup();

  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour >= BRIEFING_HOUR && hour < BRIEFING_CUTOFF_HOUR) {
      await runMorningBriefing();
    }
    if (hour >= 6 && hour < 23) {
      await checkUpcomingEvents();
    }
  }, 60_000);
}

async function checkOnStartup(): Promise<void> {
  const hour  = new Date().getHours();
  const today = new Date().toISOString().slice(0, 10);

  const isMorningWindow = hour >= BRIEFING_HOUR && hour < BRIEFING_CUTOFF_HOUR;

  if (isMorningWindow && lastBriefingDate !== today) {
    // Morning briefing takes priority — goal elicitation is woven into it
    // via the planningService fallback text when no goals exist.
    setTimeout(() => void runMorningBriefing(), 5_000);
  } else {
    // Outside morning window: run goal elicitation if needed
    setTimeout(() => void runGoalElicitation(), 8_000);
  }

  if (hour >= 6 && hour < 23) {
    setTimeout(() => void checkUpcomingEvents(), 6_000);
  }
}

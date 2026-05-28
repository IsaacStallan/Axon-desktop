import Anthropic from '@anthropic-ai/sdk';
import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import type { CalendarEvent } from './calendarService';
import { getTodayEvents }     from './calendarService';
import type { Goal }          from './goalService';
import { getActiveGoals, getLifeGoals } from './goalService';
import type { Commitment }    from './commitmentTracker';
import { getRecentPatterns, getTypicalDriftWindows, getPatternForCurrentContext } from './behaviourModel';
import { ARETICA_VISION } from './areticaVision';

// ── Morning briefing ──────────────────────────────────────────────────────────

interface NightlyPrep {
  calendarSummary: string;
  goalsJson:       string;
  weeklyPlanDay:   string;
  patternContext:  string;
  analysis:        string;
}

export async function triggerMorningBriefing(): Promise<void> {
  console.log('[Planning] triggering morning briefing...');
  const prep     = await generateNightlyPrep();
  const briefing = prep.analysis;
  try {
    const { speak } = require('./elevenLabsService');
    await speak(briefing);
  } catch (e) {
    console.warn('[Planning] morning briefing speak failed:', e);
  }
}

async function generateNightlyPrep(): Promise<NightlyPrep> {
  // Calendar
  let calendarSummary = 'No events today.';
  try {
    const events = await getTodayEvents(1);
    if (events.length > 0) {
      calendarSummary = events.map(e => {
        const h = e.hour; const m = String(e.minute ?? 0).padStart(2, '0');
        return `${h}:${m} — ${e.title}`;
      }).join('\n');
    }
  } catch { /* proceed without calendar */ }

  // Goals
  const goals    = getActiveGoals();
  const goalsJson = JSON.stringify(goals.slice(0, 10).map(g => ({ text: g.text, impact: g.impactScore, status: g.status })));

  // Weekly plan today
  const plan        = getWeeklyPlan();
  const today       = new Date().toISOString().slice(0, 10);
  const dayPlan     = plan?.days?.find(d => d.date === today);
  const weeklyPlanDay = dayPlan ? JSON.stringify(dayPlan) : 'No structured plan for today.';

  // Behaviour patterns
  const patternContext = JSON.stringify(getPatternForCurrentContext());

  // Generate briefing
  const dateStr = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const dayName = new Date().toLocaleDateString('en-AU', { weekday: 'long' });
  const dayNum  = new Date().getDate();

  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content:
          `You are preparing ${process.env.AXON_USER_NAME || 'the user'}'s morning brief. Today is ${dateStr}.\n\n` +
          `Calendar:\n${calendarSummary}\n\n` +
          `Goals: ${goalsJson}\n\n` +
          `Weekly plan for today: ${weeklyPlanDay}\n\n` +
          `Yesterday's patterns: ${patternContext}\n\n` +
          `Generate a morning briefing that:\n` +
          `1. States the ONE thing that matters most today\n` +
          `2. Notes any scheduling risks\n` +
          `3. References one behavioural pattern from yesterday if relevant\n` +
          `4. Is 4-6 sentences maximum — 30-45 seconds when spoken\n` +
          `5. Starts with: "${dayName} the ${dayNum}. Here's what matters."\n` +
          `6. Direct, sharp, Axon voice — no filler\n` +
          `No markdown. Spoken sentences only.`,
      }],
    });
    const block    = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const analysis = block?.text.trim() ?? `${dayName}. Focus on your highest-impact goal today.`;
    return { calendarSummary, goalsJson, weeklyPlanDay, patternContext, analysis };
  } catch (e) {
    console.warn('[Planning] morning briefing generation failed:', e);
    return {
      calendarSummary, goalsJson, weeklyPlanDay, patternContext,
      analysis: `${dayName}. Focus on your highest-impact goal today.`,
    };
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyPlan {
  /** Spoken briefing text — delivered by TTS in the morning */
  spoken:     string;
  /** Raw priority list for logging / memory */
  priorities: string[];
}

export interface DayPlan {
  date:              string;                                     // YYYY-MM-DD
  deepWorkWindow:    { start: string; end: string };
  gymOrRunTime?:     { start: string; end: string; type: 'gym' | 'run' | 'walk' };
  laptopWindDownTime: string;                                    // HH:MM
  softLockStart?:    string;                                     // HH:MM
  softLockEnd?:      string;                                     // HH:MM
  notes:             string;
}

export interface WeeklyLifePlan {
  weekStarting:  string;          // YYYY-MM-DD (Monday)
  days:          DayPlan[];
  weeklyGoals:   string[];        // top 3 things that matter this week
  generatedAt:   string;          // ISO timestamp
}

function weeklyPlanPath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'weekly_plan.json');
}

/** Returns the stored WeeklyLifePlan, or null if not generated yet. */
export function getWeeklyPlan(): WeeklyLifePlan | null {
  const p = weeklyPlanPath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as WeeklyLifePlan; } catch { return null; }
}

/** Returns today's DayPlan from the stored weekly plan, or null. */
export function getWeeklyPlanForToday(): DayPlan | null {
  const plan  = getWeeklyPlan();
  if (!plan) return null;
  const today = new Date().toISOString().slice(0, 10);
  return plan.days.find(d => d.date === today) ?? null;
}

/**
 * Generates a structured weekly life plan using Claude Sonnet.
 * Called every Sunday at 6pm alongside the weekly review.
 * Returns a spoken summary string.
 */
export async function generateWeeklyLifePlan(): Promise<string> {
  console.log('[Planning] generating weekly life plan...');

  // Collect inputs
  const allGoals   = getActiveGoals();
  const lifeGoals  = getLifeGoals();
  const patterns   = getRecentPatterns(14);
  const driftHours = getTypicalDriftWindows();

  let calEvents: CalendarEvent[] = [];
  try { calEvents = await getTodayEvents(7); } catch { /* proceed without */ }

  // Build Monday date for the coming week
  const now    = new Date();
  const nextMon = new Date(now);
  nextMon.setDate(now.getDate() + (8 - now.getDay()) % 7 || 7); // next Monday
  nextMon.setHours(0, 0, 0, 0);
  const weekStarting = nextMon.toISOString().slice(0, 10);

  // Summarise life goal frequency targets
  const lifeGoalLines = lifeGoals.map(g => {
    const freq = g.frequency
      ? `${g.frequency.timesPerWeek ?? '?'}x/week` +
        (g.frequency.preferredTimes?.length ? ` at ${g.frequency.preferredTimes.join('/')}` : '') +
        (g.frequency.preferredDays?.length  ? ` on ${g.frequency.preferredDays.join(',')}` : '')
      : 'no frequency set';
    return `- ${g.text} [${g.category}] — ${freq}, completions this week: ${g.completionsThisWeek ?? 0}`;
  }).join('\n') || '(no life goals set)';

  const workGoalLines = allGoals
    .filter(g => !['health','fitness','social','sleep'].includes(g.category))
    .slice(0, 5)
    .map(g => `- [${g.impactScore}/10] ${g.text}`)
    .join('\n') || '(no work goals set)';

  const calLines = calEvents.length
    ? calEvents.map(e => `- ${e.date} ${e.hour}:${String(e.minute ?? 0).padStart(2,'0')} — ${e.title}`).join('\n')
    : '(no calendar events)';

  const avgFocus = patterns.length
    ? Math.round(patterns.reduce((s, p) => s + p.totalFocusMinutes, 0) / patterns.length)
    : 120;

  const _planUser = process.env.AXON_USER_NAME || 'the user';
  const system = `You are Axon — ${_planUser}'s AI. Generate a structured 7-day weekly plan as JSON.

${ARETICA_VISION}

This plan is built around the Aretica vision — not preferences, not comfort. Every scheduled block should move ${_planUser} closer to their fullest self. Deep work windows protect their peak output hours. Gym times honour their commitment to physical capability. Wind-down and soft lock times enforce the discipline they have already said they want.


Known patterns:
- Peak focus: 9am–1pm (Tuesday/Wednesday strongest)
- Low energy: 1pm–3pm
- Gym window: 5:30pm
- Typical drift hours: ${driftHours.map(h => `${h}:00`).join(', ') || 'none tracked'}
- Average daily focus minutes (last 2 weeks): ${avgFocus}

Output ONLY valid JSON. No markdown, no explanation. Match this exact schema:
{
  "weekStarting": "${weekStarting}",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "deepWorkWindow": { "start": "HH:MM", "end": "HH:MM" },
      "gymOrRunTime": { "start": "HH:MM", "end": "HH:MM", "type": "gym|run|walk" },
      "laptopWindDownTime": "HH:MM",
      "softLockStart": "HH:MM",
      "softLockEnd": "HH:MM",
      "notes": "one sentence reasoning"
    }
  ],
  "weeklyGoals": ["top goal 1", "top goal 2", "top goal 3"],
  "generatedAt": "${new Date().toISOString()}"
}

Include all 7 days (Mon–Sun). gymOrRunTime is optional — only include on days where it makes sense given calendar + frequency targets. softLockStart triggers a hard lock at that time.`;

  const user = `Life goals with frequency targets:\n${lifeGoalLines}\n\nWork goals:\n${workGoalLines}\n\nCalendar events next 7 days:\n${calLines}\n\nGenerate the weekly plan.`;

  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: `${system}\n\n${user}` }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const raw   = block?.text.trim() ?? '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in response');

    const plan: WeeklyLifePlan = JSON.parse(match[0]);
    fs.writeFileSync(weeklyPlanPath(), JSON.stringify(plan, null, 2), 'utf8');
    console.log('[Planning] weekly plan saved');

    // Build spoken summary
    const topGoal     = plan.weeklyGoals[0] ?? 'your top priorities';
    const gymDays     = plan.days.filter(d => d.gymOrRunTime).map(d =>
      new Date(d.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' }),
    );
    const gymSummary  = gymDays.length
      ? `Gym ${gymDays.join(' and ')} at five-thirty.`
      : 'No gym days scheduled.';
    const nextEvent   = calEvents[0];
    const eventNote   = nextEvent
      ? ` You have ${nextEvent.title} coming up on ${new Date(nextEvent.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' })}.`
      : '';

    return (
      `Here's your week. Deep work mornings Monday through Wednesday. ${gymSummary}` +
      `${eventNote} The only thing that matters this week is ${topGoal}.`
    );
  } catch (e) {
    console.warn('[Planning] weekly plan generation failed:', e);
    return 'I had trouble generating your weekly plan. Check back in a moment.';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesises goals, calendar, open commitments, and pending tasks into
 * a spoken top-3 daily priority briefing.
 */
export async function getDailyPlan(
  events:      CalendarEvent[],
  goals:       Goal[],
  commitments: Commitment[],
  pendingTasks: string,
): Promise<DailyPlan> {
  const hour       = new Date().getHours();
  const dateStr    = new Date().toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric' });

  const eventLines = events.length === 0
    ? 'No calendar events today.'
    : events.map(e => {
        const period = e.hour < 12 ? 'AM' : 'PM';
        const h      = e.hour > 12 ? e.hour - 12 : e.hour || 12;
        const m      = e.minute ? `:${String(e.minute).padStart(2, '0')}` : '';
        return `${h}${m} ${period} — ${e.title}`;
      }).join('\n');

  const goalLines = goals.length === 0
    ? 'No goals set yet.'
    : goals.map((g, i) => `${i + 1}. [impact ${g.impactScore}/10] ${g.text}`).join('\n');

  const commitmentLines = commitments.length === 0
    ? ''
    : commitments.map((c, i) => {
        const age = Math.round((Date.now() - new Date(c.madeAt).getTime()) / 86_400_000);
        const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
        return `${i + 1}. "${c.text}" (said ${when})`;
      }).join('\n');

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system:
        `You are Axon — ${process.env.AXON_USER_NAME || 'the user'}'s AI.\n\n` +
        `Generate a spoken morning briefing — 3–5 sharp sentences:\n` +
        `1. Greet them briefly (${hour < 12 ? 'morning' : 'afternoon'})\n` +
        `2. Name today's top 3 priorities — derived from their goals and calendar gaps, ` +
        `not just a list of events. Make each one specific and actionable.\n` +
        `3. If they have open commitments (things they said they'd do), call out the most overdue one.\n` +
        `Rules: no markdown, no lists, natural spoken sentences. Sharp and direct.\n` +
        `IMPORTANT: Keep the briefing under 400 words maximum — it must be completable in a single TTS call.`,
      messages: [{
        role:    'user',
        content:
          `Date: ${dateStr}\n` +
          `Time: ${hour}:00\n\n` +
          `GOALS (ranked by impact):\n${goalLines}\n\n` +
          `TODAY'S CALENDAR:\n${eventLines}\n\n` +
          (commitmentLines ? `OPEN COMMITMENTS:\n${commitmentLines}\n\n` : '') +
          (pendingTasks ? `PENDING TASKS:\n${pendingTasks}\n\n` : '') +
          `Write the briefing.`,
      }],
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const spoken = block?.text.trim() ?? '';

    // Extract the three priorities as raw strings for logging
    const priorities = goals.slice(0, 3).map(g => g.text);

    return { spoken, priorities };
  } catch (e) {
    console.warn('[Planning] generation failed:', e);
    const fallback = goals.length > 0
      ? `Good morning. Today focus on: ${goals.slice(0, 3).map(g => g.text).join(', ')}.`
      : "Good morning. No goals set yet — tell me what you're working toward.";
    return { spoken: fallback, priorities: [] };
  }
}

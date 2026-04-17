import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import { speak, isSpeaking }        from './elevenLabsService';
import { setLastProactiveMessage } from './proactiveContext';
import { route }          from './modelRouter';
import { setInterventionGap } from './interventionDecider';
import { generateWeeklyLifePlan } from './planningService';
import {
  getRecentPatterns,
  getRecentInterventions,
  getRecentFlowSessions,
  getInterventionEffectiveness,
  getCommitmentFollowThrough,
  getUserProfile,
} from './behaviourModel';
import { ARETICA_VISION } from './areticaVision';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_GAP_MS  = 25 * 60_000;
const MAX_GAP_MS      = 45 * 60_000;
const MIN_GAP_MS      = 15 * 60_000;

// ── Scheduler ─────────────────────────────────────────────────────────────────

let lastReviewDate = '';  // YYYY-MM-DD, prevents double-firing same Sunday

export function startWeeklyReviewScheduler(): void {
  // Check every 10 minutes
  setInterval(() => { void checkAndRunIfDue(); }, 10 * 60_000);
  console.log('[WeeklyReview] scheduler started');
}

async function checkAndRunIfDue(): Promise<void> {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  if (now.getDay() === 0 && now.getHours() >= 18 && today !== lastReviewDate) {
    lastReviewDate = today;
    await runWeeklyReview();
    // Generate weekly life plan alongside the review
    try {
      const planSummary = await generateWeeklyLifePlan();
      if (planSummary && !isSpeaking) {
        await speak(planSummary);
      }
    } catch (e) {
      console.warn('[WeeklyReview] life plan generation error:', e);
    }
  }
}

// ── Stats aggregation ──────────────────────────────────────────────────────────

interface WeeklyStats {
  avgFocusHoursPerDay:     number;
  mostProductiveWindow:    string;
  interventionEffRate:     number | null;
  commitmentFollowThrough: number | null;
  longestFocusBlock:       number;
  bestDay:                 string;
  worstDay:                string;
  totalInterventions:      number;
  ignoredCount:            number;
}

function computeStats(): WeeklyStats {
  const patterns      = getRecentPatterns(7);
  const interventions = getRecentInterventions(7);
  const flows         = getRecentFlowSessions(7);

  // Average focus hours/day
  const avgFocusMins = patterns.length > 0
    ? patterns.reduce((s, p) => s + p.totalFocusMinutes, 0) / patterns.length
    : 0;

  // Longest single focus block this week
  const longestFocusBlock = patterns.reduce((max, p) => Math.max(max, p.longestFocusBlock), 0);

  // Best/worst days by focus ratio
  const daysByRatio = [...patterns].sort((a, b) => {
    const total = (p: typeof a) => Math.max(1, p.totalFocusMinutes + p.totalDriftMinutes);
    return (b.totalFocusMinutes / total(b)) - (a.totalFocusMinutes / total(a));
  });

  const fmtDay = (date: string) =>
    new Date(date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long' });

  const bestDay  = daysByRatio.length > 0 ? fmtDay(daysByRatio[0].date)                     : 'no data';
  const worstDay = daysByRatio.length > 1 ? fmtDay(daysByRatio[daysByRatio.length - 1].date) : 'no data';

  // Most productive window — hour with most flow session starts
  const hourBuckets = new Array(24).fill(0) as number[];
  for (const f of flows) {
    hourBuckets[new Date(f.startTime).getHours()]++;
  }
  const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));
  const mostProductiveWindow = (peakHour >= 0 && hourBuckets[peakHour] > 0)
    ? `${peakHour}:00–${peakHour + 2}:00`
    : getUserProfile().peakHours.map(h => `${h}:00`).slice(0, 2).join('–');

  // Intervention stats
  const nonBreak     = interventions.filter(r => r.type !== 'break');
  const ignoredCount = nonBreak.filter(r => r.courseCorrected === false).length;

  return {
    avgFocusHoursPerDay:     Math.round((avgFocusMins / 60) * 10) / 10,
    mostProductiveWindow,
    interventionEffRate:     getInterventionEffectiveness(),
    commitmentFollowThrough: getCommitmentFollowThrough(),
    longestFocusBlock,
    bestDay,
    worstDay,
    totalInterventions:      nonBreak.length,
    ignoredCount,
  };
}

// ── Threshold adjustment ───────────────────────────────────────────────────────
// After each weekly review, recalibrate intervention frequency based on data.

function adjustThresholds(stats: WeeklyStats): void {
  if (stats.totalInterventions < 3) return;  // not enough data

  const ignoredRate = stats.ignoredCount / stats.totalInterventions;

  if (ignoredRate > 0.6) {
    // Too many ignored — backing off reduces resentment
    const newGap = Math.min(MAX_GAP_MS, Math.round(DEFAULT_GAP_MS * 1.4));
    setInterventionGap(newGap);
    console.log(
      `[WeeklyReview] sensitivity ↓ (${Math.round(ignoredRate * 100)}% ignored) → ` +
      `gap ${Math.round(newGap / 60_000)}min`,
    );
  } else if (ignoredRate < 0.2) {
    // Very responsive — can tighten up
    const newGap = Math.max(MIN_GAP_MS, Math.round(DEFAULT_GAP_MS * 0.75));
    setInterventionGap(newGap);
    console.log(
      `[WeeklyReview] sensitivity ↑ (only ${Math.round(ignoredRate * 100)}% ignored) → ` +
      `gap ${Math.round(newGap / 60_000)}min`,
    );
  } else {
    setInterventionGap(DEFAULT_GAP_MS);
    console.log('[WeeklyReview] sensitivity restored to default');
  }
}

// ── Save to memory ─────────────────────────────────────────────────────────────

function saveReview(text: string, stats: WeeklyStats): void {
  const dir = path.join(app.getPath('userData'), 'memory', 'reviews');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const content =
    `# Weekly Review — ${new Date().toLocaleDateString('en-AU')}\n\n` +
    `${text}\n\n` +
    `## Stats\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n`;

  fs.writeFileSync(path.join(dir, `${date}.md`), content, 'utf8');
  console.log(`[WeeklyReview] saved to memory/reviews/${date}.md`);
}

// ── Public: generate and speak review ─────────────────────────────────────────

export async function runWeeklyReview(): Promise<string> {
  console.log('[WeeklyReview] generating...');

  const stats   = computeStats();
  const profile = getUserProfile();

  const system =
    `You are Axon — Isaac's personal AI delivering his weekly review aloud.\n` +
    `Isaac is 20. Building House Stallan. Obsessed with execution and legacy.\n` +
    `Tone: direct, specific, honest. Lead with the real win, then the hard truth, ` +
    `then one clear focus point for next week. 4–6 sentences max.\n` +
    `This is TTS — no markdown, no bullet points, no lists. Speak like a trusted advisor.\n\n` +
    `${ARETICA_VISION}\n\n` +
    `Evaluate this week against growth, not just productivity metrics. ` +
    `Did Isaac move closer to his fullest self? Where did he fall short of his own standard? ` +
    `Be accurate. Not comfortable.`;

  const prompt =
    `Weekly performance data:\n` +
    `- Average focus per day: ${stats.avgFocusHoursPerDay} hours\n` +
    `- Most productive window: ${stats.mostProductiveWindow}\n` +
    `- Longest single focus block: ${stats.longestFocusBlock} minutes\n` +
    `- Best day: ${stats.bestDay}  |  Worst day: ${stats.worstDay}\n` +
    `- Intervention effectiveness: ${stats.interventionEffRate !== null ? stats.interventionEffRate + '%' : 'not enough data yet'}\n` +
    `- Commitment follow-through: ${stats.commitmentFollowThrough !== null ? stats.commitmentFollowThrough + '%' : 'not enough data yet'}\n` +
    `- Interventions fired: ${stats.totalInterventions}  (${stats.ignoredCount} ignored)\n` +
    `- 90-day goal: ${profile.goals90Day}\n\n` +
    `Write the weekly review. Be specific about the numbers. Be honest. End with one sharp focus for next week.`;

  try {
    const review = await route({
      taskType:  'weekly_review',
      system,
      prompt,
      maxTokens: 350,
    });

    if (isSpeaking) {
      console.log('[WeeklyReview] already speaking — will retry next poll');
      return 'Weekly review generated but deferred (Axon was speaking).';
    }
    setLastProactiveMessage(review, 'weekly_review');
    await speak(review);
    saveReview(review, stats);
    adjustThresholds(stats);

    return review;
  } catch (e) {
    console.warn('[WeeklyReview] failed:', e);
    return 'Weekly review unavailable — check logs.';
  }
}

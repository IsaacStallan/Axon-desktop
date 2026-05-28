import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
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
import { adjustThresholds as adjustPatternThresholds } from './patternEngine';
import { ARETICA_VISION } from './areticaVision';

const reviewClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

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

// ── Intervention learning loop ─────────────────────────────────────────────────

interface InterventionLearning {
  bestHours:                       number[];
  responsiveApps:                  string[];
  unresponsiveApps:                string[];
  effectiveStyle:                  'short' | 'direct' | 'explanatory' | 'question';
  keyInsight:                      string;
  recommendedThresholdAdjustment:  number;
}

function saveLearning(learning: InterventionLearning): void {
  try {
    const dir = path.join(app.getPath('userData'), 'memory');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'intervention_learning.json'),
      JSON.stringify({ ...learning, savedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    console.log('[Learning] saved to intervention_learning.json');
  } catch (e) {
    console.warn('[Learning] save failed:', e);
  }
}

export async function runInterventionLearning(): Promise<void> {
  const allInterventions = getRecentInterventions(14);
  if (allInterventions.length < 5) {
    console.log('[Learning] not enough intervention data yet');
    return;
  }

  const recent  = allInterventions.slice(-50);
  const worked  = recent.filter(i => i.courseCorrected === true);
  const failed  = recent.filter(i => i.courseCorrected === false && i.userResponded);

  const prompt =
    `Analyse these intervention outcomes for ${process.env.AXON_USER_NAME || 'the user'}:\n\n` +
    `WORKED (${worked.length} that course corrected):\n` +
    worked.map(i =>
      `- Type: ${i.type}, App: ${i.appContext}, Hour: ${new Date(i.timestamp).getHours()}:00, ` +
      `Message: "${i.message.slice(0, 80)}"`
    ).join('\n') + '\n\n' +
    `FAILED (${failed.length} that did not course correct):\n` +
    failed.map(i =>
      `- Type: ${i.type}, App: ${i.appContext}, Hour: ${new Date(i.timestamp).getHours()}:00, ` +
      `Message: "${i.message.slice(0, 80)}"`
    ).join('\n') + '\n\n' +
    `Return ONLY valid JSON:\n` +
    `{\n` +
    `  "bestHours": [number],\n` +
    `  "responsiveApps": [string],\n` +
    `  "unresponsiveApps": [string],\n` +
    `  "effectiveStyle": "short"|"direct"|"explanatory"|"question",\n` +
    `  "keyInsight": "one sentence",\n` +
    `  "recommendedThresholdAdjustment": number between -10 and 10\n` +
    `}`;

  try {
    const resp = await reviewClient.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const raw   = block?.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim() ?? '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[Learning] no JSON in response'); return; }

    const learning: InterventionLearning = JSON.parse(match[0]);
    saveLearning(learning);

    if (learning.recommendedThresholdAdjustment !== 0) {
      adjustPatternThresholds(learning.recommendedThresholdAdjustment);
      console.log(`[Learning] adjusted drift thresholds by ${learning.recommendedThresholdAdjustment}`);
    }

    const dir = learning.recommendedThresholdAdjustment > 0 ? 'raised' : 'lowered';
    const abs = Math.abs(learning.recommendedThresholdAdjustment);
    const summary = `Weekly learning complete. ${learning.keyInsight}${abs > 0 ? ` Thresholds ${dir} by ${abs} points.` : ''}`;
    if (!isSpeaking) await speak(summary);

  } catch (e) {
    console.warn('[Learning] intervention learning failed:', e);
  }
}

// ── Public: generate and speak review ─────────────────────────────────────────

export async function runWeeklyReview(): Promise<string> {
  console.log('[WeeklyReview] generating...');

  const stats   = computeStats();
  const profile = getUserProfile();

  const system =
    `You are Axon — ${process.env.AXON_USER_NAME || 'the user'}'s personal AI delivering their weekly review aloud.\n` +
    `Tone: direct, specific, honest. Lead with the real win, then the hard truth, ` +
    `then one clear focus point for next week. 4–6 sentences max.\n` +
    `This is TTS — no markdown, no bullet points, no lists. Speak like a trusted advisor.\n\n` +
    `${ARETICA_VISION}\n\n` +
    `Evaluate this week against growth, not just productivity metrics. ` +
    `Did ${process.env.AXON_USER_NAME || 'the user'} move closer to their fullest self? Where did they fall short of their own standard? ` +
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

    // Run intervention learning loop (fire-and-forget after review)
    void runInterventionLearning();

    return review;
  } catch (e) {
    console.warn('[WeeklyReview] failed:', e);
    return 'Weekly review unavailable — check logs.';
  }
}

import { getCurrentApp, getProductivityScore, getSessionLog } from './windowMonitor';
import { getOpenCommitments }                                   from './commitmentTracker';
import {
  getUserProfile,
  getTypicalDriftWindows,
  getAverageFocusSessionLength,
  getDriftVectors,
  getBreakEffectiveness,
  getRecentBreaks,
  getRecentInterventions,
  getCommitmentFollowThrough,
} from './behaviourModel';
import { isInGracePeriod } from './environmentalControl';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PatternResult {
  driftProbability:          number;   // 0–100
  breakRecommended:          boolean;
  reason:                    string;
  tier:                      'predictive' | 'early' | 'recovery';
  continuousFocusMins:       number;
  ignoredInterventionStreak: number;   // consecutive non-corrected interventions
  isCompoundVulnerable:      boolean;  // all four risk vectors aligned
  momentumScore:             number;   // 0–100, higher = better momentum today
}

// ── Session helpers ────────────────────────────────────────────────────────────

/**
 * Minutes of unbroken productive-app usage trailing the current session log.
 */
export function getContinuousFocusMinutes(): number {
  const log  = getSessionLog();
  const curr = getCurrentApp();
  let msAccum = 0;

  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].label === 'positive') {
      msAccum += log[i].durationMs;
    } else {
      break;
    }
  }

  if (curr.label === 'positive') {
    msAccum += curr.durationMins * 60_000;
  }

  return msAccum / 60_000;
}

function minsSinceLastProductive(): number {
  const curr = getCurrentApp();
  if (curr.label === 'positive') return 0;

  const log = getSessionLog();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].label === 'positive') {
      return (Date.now() - (log[i].startedAt + log[i].durationMs)) / 60_000;
    }
  }

  return 999;
}

// ── Energy decay (time-of-day productivity weighting) ─────────────────────────
// Same raw productivity score means different things at different hours.
// Returns a 0.7–1.0 multiplier reflecting typical energy levels.

function getEnergyDecay(): number {
  const h = new Date().getHours();
  if (h >= 6  && h < 9)  return 0.85;  // early morning ramp-up
  if (h >= 9  && h < 12) return 1.0;   // morning peak
  if (h >= 12 && h < 14) return 0.9;   // post-lunch onset
  if (h >= 14 && h < 16) return 0.8;   // afternoon slump (Isaac's known 1–3pm drift)
  if (h >= 16 && h < 18) return 0.85;  // partial afternoon recovery
  if (h >= 18 && h < 20) return 0.75;  // evening fatigue (5:30–6:30pm drift window)
  return 0.7;                           // night
}

// ── Ignored intervention streak ────────────────────────────────────────────────

function getIgnoredStreak(): number {
  const resolved = getRecentInterventions(7)
    .filter(r => r.type !== 'break' && r.courseCorrected !== null)
    .reverse(); // most recent first

  let streak = 0;
  for (const r of resolved) {
    if (r.courseCorrected === false) streak++;
    else break;
  }
  return streak;
}

// ── Momentum score (0–100, higher = better) ───────────────────────────────────

function computeMomentum(): number {
  const followThrough = getCommitmentFollowThrough();  // null = insufficient data
  if (followThrough === null) return 50;               // assume neutral
  return followThrough; // already 0–100
}

// ── Core analysis ──────────────────────────────────────────────────────────────

export function analyzeCurrentState(): PatternResult {
  const curr    = getCurrentApp();
  const hour    = new Date().getHours();
  const dow     = new Date().getDay();
  const reasons: string[] = [];
  let score = 0;

  // ── Factor 1: Time of day vs known drift windows (0–30 pts) ───────────────
  const driftHours = getTypicalDriftWindows();
  if (driftHours.includes(hour)) {
    score += 25;
    reasons.push(`drift window (${hour}:00)`);
  } else if (driftHours.includes(hour - 1) || driftHours.includes(hour + 1)) {
    score += 10;
    reasons.push('approaching drift window');
  }

  // ── Factor 2: Current app vs known drift vectors (0–35 pts) ───────────────
  const profile       = getUserProfile();
  const vectors       = getDriftVectors();
  const appLower      = curr.name.toLowerCase();
  const isKnownVector = [...vectors, ...profile.driftVectors]
    .some(v => appLower.includes(v.toLowerCase()));

  if (curr.label === 'negative') {
    if (isKnownVector) {
      score += 35;
      reasons.push(`known drift app (${curr.name})`);
    } else {
      score += 20;
      reasons.push(`distraction app (${curr.name})`);
    }
  } else if (curr.label === 'neutral' && curr.durationMins > 20) {
    score += 8; // prolonged neutral is a pre-drift signal
  }

  // ── Factor 3: Time since last productive activity (0–20 pts) ──────────────
  const minsUnproductive = minsSinceLastProductive();
  if (minsUnproductive >= 60) {
    score += 20;
    reasons.push(`${Math.round(minsUnproductive)}min since any productive work`);
  } else if (minsUnproductive >= 30) {
    score += 12;
    reasons.push(`${Math.round(minsUnproductive)}min since productive work`);
  } else if (minsUnproductive >= 15) {
    score += 5;
  }

  // ── Factor 4: Session length vs average flow duration (0–10 pts) ──────────
  const focusMins = getContinuousFocusMinutes();
  const avgFlow   = getAverageFocusSessionLength();
  const flowRatio = avgFlow > 0 ? focusMins / avgFlow : 0;
  if (flowRatio > 1.5) {
    score += 10;
    reasons.push(`${Math.round(focusMins)}min — beyond typical flow length`);
  } else if (flowRatio > 1.2) {
    score += 5;
  }

  // ── Factor 5: Day of week (0–5 pts) ───────────────────────────────────────
  if (dow === 0 || dow === 6) score += 5;

  // ── Factor 6: Unmet commitments made today (0–10 pts) ─────────────────────
  const today  = new Date().toISOString().slice(0, 10);
  const todayC = getOpenCommitments().filter(c => c.madeAt.startsWith(today));
  if (todayC.length > 0) {
    score += Math.min(10, todayC.length * 5);
    reasons.push(`${todayC.length} unmet commitment(s) today`);
  }

  // ── Factor 7: Momentum / commitment follow-through (0–10 pts) ─────────────
  const momentumScore = computeMomentum();
  if (momentumScore < 30) {
    score += 10;
    reasons.push(`low momentum (${momentumScore}% follow-through)`);
  } else if (momentumScore < 60) {
    score += 5;
  }

  // ── Factor 8: Ignored intervention streak (0–20 pts) ──────────────────────
  const ignoredStreak = getIgnoredStreak();
  if (ignoredStreak >= 3) {
    score += 20;
    reasons.push(`${ignoredStreak} consecutive ignored interventions`);
  } else if (ignoredStreak >= 1) {
    score += 8;
  }

  // ── Factor 9: Avoidance signature (0–10 pts) ──────────────────────────────
  // Morning + no productive activity yet = avoidance pattern
  const log                = getSessionLog();
  const hasHadProductiveTime = log.some(e => e.label === 'positive') || curr.label === 'positive';
  if (hour < 12 && !hasHadProductiveTime && minsUnproductive >= 30) {
    score += 10;
    reasons.push('avoidance signature (no productive work yet this morning)');
  }

  // ── Factor 10: Energy decay (0–8 pts bonus when low-energy + low output) ──
  const decay             = getEnergyDecay();
  const rawProductivity   = getProductivityScore();
  const adjustedProductivity = Math.round(rawProductivity * decay);
  if (decay < 0.85 && rawProductivity < 50) {
    const decayPts = Math.round((0.85 - decay) * 40); // 0–6 pts
    score += decayPts;
    reasons.push(`energy decay ×${decay} (adjusted score: ${adjustedProductivity}%)`);
  }

  // ── Grace period: user explicitly overrode an environmental intervention ─────
  // Reduces score for 20 minutes, gives benefit of the doubt.
  if (isInGracePeriod(curr.name)) {
    score = Math.max(0, score - 20);
    reasons.push(`grace period active for ${curr.name}`);
  }

  const driftProbability = Math.min(100, Math.round(score));

  // ── Compound vulnerability: all four core risk vectors aligned ─────────────
  const isCompoundVulnerable = (
    driftHours.includes(hour) &&
    curr.label === 'negative' &&
    isKnownVector &&
    todayC.length > 0 &&
    ignoredStreak >= 2
  );

  // Compound vulnerability overrides individual thresholds
  const finalDrift = isCompoundVulnerable ? Math.max(driftProbability, 90) : driftProbability;
  if (isCompoundVulnerable) {
    reasons.push('compound vulnerability: all risk factors aligned');
  }

  // ── Tier ──────────────────────────────────────────────────────────────────
  const tier: PatternResult['tier'] =
    finalDrift >= 85 ? 'recovery'   :
    finalDrift >= 70 ? 'early'      :
                       'predictive';

  // ── Break recommendation ───────────────────────────────────────────────────
  const continuousFocusMins = getContinuousFocusMinutes();
  const breakEff            = getBreakEffectiveness();
  const recentBreaks        = getRecentBreaks(1);
  const lastBreakMinsAgo    = recentBreaks.length > 0
    ? (Date.now() - new Date(recentBreaks[recentBreaks.length - 1].timestamp).getTime()) / 60_000
    : 999;

  const breakRecommended = (
    (continuousFocusMins >= 90 && lastBreakMinsAgo > 60) ||
    (driftHours.includes(hour) && lastBreakMinsAgo > 90 && (breakEff === null || breakEff >= 50))
  );

  const reason = reasons.length > 0 ? reasons.join(', ') : 'nominal';

  return {
    driftProbability:          finalDrift,
    breakRecommended,
    reason,
    tier,
    continuousFocusMins,
    ignoredInterventionStreak: ignoredStreak,
    isCompoundVulnerable,
    momentumScore,
  };
}

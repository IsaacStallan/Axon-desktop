import { execSync }  from 'child_process';
import { getCurrentApp, getSessionLog } from './windowMonitor';
import { getOpenCommitments }           from './commitmentTracker';
import { getDriftVectors, getRecentInterventions } from './behaviourModel';
import { isInGracePeriod }              from './environmentalControl';
import { getRecentContext }             from './screenAwareness';

// ── App drift profiles ─────────────────────────────────────────────────────────

export interface AppDriftProfile {
  nameFragment:         string;    // lowercase fragment matched against app name
  baseDistraction:      number;    // 0–100: raw distraction weight
  sessionThresholdMins: number;    // session must exceed this before decay kicks in
  productiveKeywords:   string[];  // screen content that reduces drift score
  distractionKeywords:  string[];  // screen content that amplifies drift score
  goalRelevant:         boolean;   // can this app contribute to work goals?
}

const APP_DRIFT_PROFILES: AppDriftProfile[] = [
  {
    nameFragment: 'youtube', baseDistraction: 85, sessionThresholdMins: 5,
    productiveKeywords:   ['tutorial', 'course', 'lecture', 'conference', 'talk', 'how to'],
    distractionKeywords:  ['shorts', 'vlog', 'reaction', 'funny', 'gaming', 'trending'],
    goalRelevant: false,
  },
  {
    nameFragment: 'claude', baseDistraction: 5, sessionThresholdMins: 120,
    productiveKeywords:   ['code', 'build', 'debug', 'review', 'implement', 'design'],
    distractionKeywords:  ['tell me a story', 'roleplay', 'joke', 'entertain'],
    goalRelevant: true,
  },
  {
    nameFragment: 'instagram', baseDistraction: 90, sessionThresholdMins: 3,
    productiveKeywords:   [],
    distractionKeywords:  ['reel', 'story', 'feed', 'explore', 'like', 'follow'],
    goalRelevant: false,
  },
  {
    nameFragment: 'terminal', baseDistraction: 10, sessionThresholdMins: 60,
    productiveKeywords:   ['git', 'npm', 'build', 'test', 'deploy', 'ssh', 'python', 'node'],
    distractionKeywords:  [],
    goalRelevant: true,
  },
  {
    nameFragment: 'code', baseDistraction: 5, sessionThresholdMins: 120,
    productiveKeywords:   ['function', 'class', 'import', 'const', 'export', 'def', 'return'],
    distractionKeywords:  [],
    goalRelevant: true,
  },
  {
    nameFragment: 'notion', baseDistraction: 15, sessionThresholdMins: 60,
    productiveKeywords:   ['plan', 'strategy', 'notes', 'document', 'project'],
    distractionKeywords:  ['template gallery', 'explore'],
    goalRelevant: true,
  },
  {
    nameFragment: 'safari', baseDistraction: 50, sessionThresholdMins: 20,
    productiveKeywords:   ['github', 'stackoverflow', 'docs', 'documentation', 'api', 'linear'],
    distractionKeywords:  ['youtube', 'instagram', 'tiktok', 'reddit', 'twitter', 'news'],
    goalRelevant: false,
  },
  {
    nameFragment: 'chrome', baseDistraction: 45, sessionThresholdMins: 20,
    productiveKeywords:   ['github', 'stackoverflow', 'docs', 'documentation', 'api', 'figma'],
    distractionKeywords:  ['youtube', 'instagram', 'tiktok', 'reddit', 'twitter', 'news'],
    goalRelevant: false,
  },
  {
    nameFragment: 'spotify', baseDistraction: 20, sessionThresholdMins: 999,
    productiveKeywords:   ['focus', 'study', 'lofi', 'instrumental', 'concentration'],
    distractionKeywords:  [],
    goalRelevant: false,
  },
  {
    nameFragment: 'messages', baseDistraction: 40, sessionThresholdMins: 10,
    productiveKeywords:   ['standup', 'meeting', 'deadline', 'ship', 'deploy', 'client'],
    distractionKeywords:  ['lol', 'haha', 'meme', 'bro', 'dude'],
    goalRelevant: false,
  },
  {
    nameFragment: 'tiktok', baseDistraction: 95, sessionThresholdMins: 2,
    productiveKeywords:   [],
    distractionKeywords:  ['for you', 'fyp', 'trending', 'viral'],
    goalRelevant: false,
  },
  {
    nameFragment: 'calendar', baseDistraction: 5, sessionThresholdMins: 30,
    productiveKeywords:   ['schedule', 'event', 'meeting', 'plan'],
    distractionKeywords:  [],
    goalRelevant: true,
  },
  {
    nameFragment: 'finder', baseDistraction: 25, sessionThresholdMins: 15,
    productiveKeywords:   ['project', 'src', 'code', 'workspace'],
    distractionKeywords:  ['downloads', 'movies', 'games'],
    goalRelevant: false,
  },
];

const DEFAULT_PROFILE: AppDriftProfile = {
  nameFragment:         '__default__',
  baseDistraction:      35,
  sessionThresholdMins: 30,
  productiveKeywords:   [],
  distractionKeywords:  [],
  goalRelevant:         false,
};

function getAppProfile(appName: string): AppDriftProfile {
  const lower = appName.toLowerCase();
  return APP_DRIFT_PROFILES.find(p => lower.includes(p.nameFragment)) ?? DEFAULT_PROFILE;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DriftAnalysis {
  score:                  number;        // 0–100
  tier:                   0 | 1 | 2 | 3;
  confidence:             number;        // 0–100
  factors:                string[];
  dominantFactor:         string;
  isConfirmedDrift:       boolean;
  continuousFocusMins:    number;
  consecutiveNeutralApps: number;
  recentCommitActivity:   boolean;
  lastProductiveAppMins:  number;
  appProfile:             AppDriftProfile;
}

// ── Backwards-compatibility shim (decisionEngine / interventionDecider / psychologyLayer) ──

export interface PatternResult {
  driftProbability:          number;
  breakRecommended:          boolean;
  reason:                    string;
  tier:                      'predictive' | 'early' | 'recovery';
  continuousFocusMins:       number;
  ignoredInterventionStreak: number;
  isCompoundVulnerable:      boolean;
  momentumScore:             number;
}

export function analyzeCurrentState(): PatternResult {
  const drift = calculateDrift();
  const tierStr: PatternResult['tier'] =
    drift.tier === 3 ? 'recovery' :
    drift.tier === 2 ? 'early'    : 'predictive';

  const recent = getRecentInterventions(7)
    .filter(r => r.type !== 'break' && r.courseCorrected !== null)
    .reverse();
  let ignoredStreak = 0;
  for (const r of recent) {
    if (r.courseCorrected === false) ignoredStreak++;
    else break;
  }

  return {
    driftProbability:          drift.score,
    breakRecommended:          drift.continuousFocusMins >= 90,
    reason:                    drift.factors.join(', ') || 'nominal',
    tier:                      tierStr,
    continuousFocusMins:       drift.continuousFocusMins,
    ignoredInterventionStreak: ignoredStreak,
    isCompoundVulnerable:      drift.isConfirmedDrift && drift.score >= 80,
    momentumScore:             50,
  };
}

// ── Adjustable tier thresholds ─────────────────────────────────────────────────

let SCORE_TIER_1 = 40;
let SCORE_TIER_2 = 60;
let SCORE_TIER_3 = 80;

export function adjustThresholds(adjustment: number): void {
  SCORE_TIER_1 = Math.max(30, Math.min(55, SCORE_TIER_1 + adjustment));
  SCORE_TIER_2 = Math.max(50, Math.min(70, SCORE_TIER_2 + adjustment));
  SCORE_TIER_3 = Math.max(70, Math.min(90, SCORE_TIER_3 + adjustment));
  console.log(`[PatternEngine] thresholds — tier1:${SCORE_TIER_1} tier2:${SCORE_TIER_2} tier3:${SCORE_TIER_3}`);
}

// ── Session helpers ────────────────────────────────────────────────────────────

export function getContinuousFocusMinutes(): number {
  const log  = getSessionLog();
  const curr = getCurrentApp();
  let msAccum = 0;

  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].label === 'positive') msAccum += log[i].durationMs;
    else break;
  }

  if (curr.label === 'positive') msAccum += curr.durationMins * 60_000;
  return msAccum / 60_000;
}

function getLastProductiveAppMins(): number {
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

function getConsecutiveNeutralOrDistraction(): number {
  const log = getSessionLog();
  let count = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].label !== 'positive') count++;
    else break;
  }
  return count;
}

// ── Recent productive output (macOS Spotlight) ─────────────────────────────────

export function checkRecentProductiveOutput(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const home = process.env.HOME ?? '';
    const out  = execSync(
      `mdfind "kMDItemFSContentChangeDate > $time.now(-1800) && kMDItemContentTypeTree = 'public.source-code'" -onlyin '${home}' 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 3_000 },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// ── Time-of-day vulnerability ──────────────────────────────────────────────────

function getTimeVulnerability(hour: number): { pts: number; label: string } {
  if (hour >= 13 && hour < 16) return { pts: 15, label: 'afternoon slump (1–4pm)' };
  if (hour >= 18 && hour < 21) return { pts: 12, label: 'evening drift (6–9pm)' };
  if (hour >= 23 || hour < 6)  return { pts: 10, label: 'late night' };
  if (hour >= 6  && hour < 9)  return { pts: 3,  label: 'morning ramp-up' };
  return { pts: 0, label: '' };
}

// ── Screen content signal ──────────────────────────────────────────────────────

function getScreenContentSignal(profile: AppDriftProfile): { pts: number; label: string } {
  const contexts = getRecentContext();
  const last     = contexts[contexts.length - 1];
  if (!last) return { pts: 0, label: '' };

  const screen = `${last.activity} ${last.visibleContent ?? ''} ${last.notes ?? ''}`.toLowerCase();

  const distractionMatch = profile.distractionKeywords.find(kw => screen.includes(kw));
  if (distractionMatch) {
    return { pts: 25, label: `screen shows distraction content (${distractionMatch})` };
  }

  const productiveMatch = profile.productiveKeywords.find(kw => screen.includes(kw));
  if (productiveMatch) return { pts: -20, label: '' };

  if (last.productivitySignal === 'productive') return { pts: -10, label: '' };
  if (last.productivitySignal === 'distracted') return { pts: 15,  label: 'screen signal: distracted' };

  return { pts: 0, label: '' };
}

// ── Core drift calculation ─────────────────────────────────────────────────────

export function calculateDrift(): DriftAnalysis {
  const curr    = getCurrentApp();
  const profile = getAppProfile(curr.name);
  const hour    = new Date().getHours();
  const factors: string[] = [];
  let rawScore  = 0;
  let confidence = 60;

  // ── Factor 1: App baseline distraction (0–40 pts) ─────────────────────────
  const basePts = Math.round((profile.baseDistraction / 100) * 40);
  rawScore += basePts;
  confidence += 15;
  if (basePts >= 30) {
    factors.push(`${curr.name} — high-distraction app`);
  } else if (basePts >= 15) {
    factors.push(`${curr.name} — moderate distraction`);
  }

  // ── Factor 2: Screen content signals (–20 to +25 pts) ─────────────────────
  const screenSig = getScreenContentSignal(profile);
  rawScore += screenSig.pts;
  if (screenSig.pts > 0 && screenSig.label) {
    factors.push(screenSig.label);
    confidence += 15;
  } else if (screenSig.pts < 0) {
    confidence += 10;
  }

  // ── Factor 3: Session length decay vs per-app threshold (0–20 pts) ─────────
  const sessionMins = curr.durationMins;
  if (sessionMins > profile.sessionThresholdMins) {
    const overage  = sessionMins - profile.sessionThresholdMins;
    const decayPts = Math.min(20, Math.round((overage / profile.sessionThresholdMins) * 15));
    rawScore += decayPts;
    if (decayPts >= 8) {
      factors.push(`${Math.round(sessionMins)}min in ${curr.name} (threshold: ${profile.sessionThresholdMins}min)`);
      confidence += 10;
    }
  }

  // ── Factor 4: Goal alignment (–10 to +12 pts) ─────────────────────────────
  const today          = new Date().toISOString().slice(0, 10);
  const openToday      = getOpenCommitments().filter(c => c.madeAt?.startsWith(today));
  const hasGoalToday   = openToday.length > 0;
  if (hasGoalToday && !profile.goalRelevant) {
    rawScore += 12;
    factors.push('not working toward today\'s commitments');
    confidence += 10;
  } else if (hasGoalToday && profile.goalRelevant) {
    rawScore -= 10;
    confidence += 5;
  }

  // ── Factor 5: Recent productive output (–15 pts if active) ────────────────
  const recentCommitActivity = checkRecentProductiveOutput();
  if (recentCommitActivity) {
    rawScore -= 15;
    confidence += 10;
  }

  // ── Factor 6: Behavioral sequence — consecutive off-task apps (0–15 pts) ───
  const consecutiveNeutralApps = getConsecutiveNeutralOrDistraction();
  if (consecutiveNeutralApps >= 4) {
    const seqPts = Math.min(15, consecutiveNeutralApps * 3);
    rawScore += seqPts;
    factors.push(`${consecutiveNeutralApps} consecutive off-task apps`);
    confidence += 8;
  } else if (consecutiveNeutralApps >= 2) {
    rawScore += 6;
  }

  // ── Factor 7: Time-of-day vulnerability (0–15 pts) ────────────────────────
  const timeVuln = getTimeVulnerability(hour);
  if (timeVuln.pts > 0) {
    rawScore += timeVuln.pts;
    if (timeVuln.pts >= 10) factors.push(timeVuln.label);
  }

  // ── Grace period: user overrode an environmental intervention (–20 pts) ────
  if (isInGracePeriod(curr.name)) {
    rawScore -= 20;
    factors.push(`grace period active for ${curr.name}`);
    confidence = Math.max(30, confidence - 15);
  }

  // ── Known personal drift trigger from behaviour model (+10 pts) ───────────
  const driftVectors  = getDriftVectors();
  const isKnownVector = driftVectors.some(v => curr.name.toLowerCase().includes(v.toLowerCase()));
  if (isKnownVector && profile.baseDistraction > 40) {
    rawScore += 10;
    factors.push('known personal drift trigger');
    confidence += 10;
  }

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const tier: DriftAnalysis['tier'] =
    score >= SCORE_TIER_3 ? 3 :
    score >= SCORE_TIER_2 ? 2 :
    score >= SCORE_TIER_1 ? 1 : 0;

  const isConfirmedDrift = (
    score >= SCORE_TIER_2 &&
    sessionMins > 15 &&
    (profile.baseDistraction > 70 || screenSig.pts > 0)
  );

  const dominantFactor     = factors.length > 0 ? factors[0] : 'nominal';
  const lastProductiveAppMins = getLastProductiveAppMins();

  console.log(
    `[PatternEngine] ${curr.name} — score: ${score}/100, tier: ${tier}, ` +
    `confirmed: ${isConfirmedDrift}, confidence: ${Math.min(100, confidence)}%, ` +
    `factors: [${factors.join(' | ')}]`,
  );

  return {
    score,
    tier,
    confidence:             Math.min(100, Math.max(0, confidence)),
    factors,
    dominantFactor,
    isConfirmedDrift,
    continuousFocusMins:    getContinuousFocusMinutes(),
    consecutiveNeutralApps,
    recentCommitActivity,
    lastProductiveAppMins,
    appProfile:             profile,
  };
}

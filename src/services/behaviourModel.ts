import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import { execSync } from 'child_process';
import * as cloudSync from './cloudSync';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AppSession {
  id:                string;
  app:               string;
  startTime:         string;   // ISO
  endTime:           string;   // ISO
  productivityScore: number;   // 0–100 at session end
  wasDistraction:    boolean;
}

export interface InterventionRecord {
  id:              string;
  timestamp:       string;   // ISO
  type:            'predictive' | 'early' | 'recovery' | 'break';
  message:         string;
  appContext:       string;
  driftMinutes:    number;
  userResponded:   boolean;
  courseCorrected: boolean | null;  // null until outcome check runs
}

export interface SessionPattern {
  date:               string;   // YYYY-MM-DD
  totalFocusMinutes:  number;
  totalDriftMinutes:  number;
  longestFocusBlock:  number;
  breaksTaken:        number;
  interventionCount:  number;
}

export interface FlowSession {
  id:              string;
  startTime:       string;   // ISO
  durationMinutes: number;
  triggerApp:      string;
}

export interface BreakRecord {
  id:              string;
  timestamp:       string;   // ISO
  durationMinutes: number;
  wasProductive:   boolean;  // productivity improved after the break
}

export interface UserProfile {
  wakeTime:        string;
  peakHours:       number[];
  driftWindows:    Array<{ start: number; end: number }>;
  driftVectors:    string[];
  workStyle:       'blocks' | 'sprints' | 'unknown';
  nonNegotiables:  string[];
  avoidanceTasks:  string[];
  goals90Day:      string;
  recoveryMessage: string;
}

// ── Isaac's known profile (seed data) ─────────────────────────────────────────

const ISAAC_DEFAULT_PROFILE: UserProfile = {
  wakeTime:  '07:00',
  peakHours: [9, 10, 11],
  driftWindows: [
    { start: 13, end: 15 },  // 1–3 pm
    { start: 17, end: 19 },  // 5:30–6:30 pm
  ],
  driftVectors:   ['YouTube', 'Crunchyroll', 'Safari', 'YouTube Music'],
  workStyle:      'blocks',
  nonNegotiables: ['work on GrantForge', 'exercise', 'daily review'],
  avoidanceTasks: ['working on Axon', 'exercising', 'cold outreach'],
  goals90Day:
    'Get GrantForge to $5k MRR, establish House Stallan as a real operating entity, ' +
    'achieve first taste of financial independence',
  recoveryMessage:
    'You are at war with the unconscious life. Every hour you spend on YouTube, ' +
    'every afternoon you drift to Crunchyroll, every time you open a tab instead ' +
    'of your editor — you are choosing the small life. You are capable of building ' +
    'House Stallan. You know it. The question is whether you will. Most people never ' +
    'find out what they\'re capable of because they never stop sedating themselves ' +
    'long enough to build. You have one life. This is it. Get back to work.',
};

// ── Storage paths ──────────────────────────────────────────────────────────────

function behaviourDir(): string {
  const dir = path.join(app.getPath('userData'), 'memory', 'behaviour');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fp(name: string): string {
  return path.join(behaviourDir(), name);
}

// ── Generic read/write helpers ─────────────────────────────────────────────────

function readArr<T>(name: string): T[] {
  const p = fp(name);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeArr<T>(name: string, data: T[], cap: number): void {
  fs.writeFileSync(fp(name), JSON.stringify(data.slice(-cap), null, 2), 'utf8');
}

function readObj<T>(name: string, fallback: T): T {
  const p = fp(name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeObj<T>(name: string, data: T): void {
  fs.writeFileSync(fp(name), JSON.stringify(data, null, 2), 'utf8');
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── App Sessions ───────────────────────────────────────────────────────────────

export function logAppSession(session: Omit<AppSession, 'id'>): void {
  const all = readArr<AppSession>('app_sessions.json');
  all.push({ id: makeId(), ...session });
  writeArr('app_sessions.json', all, 1000);
  cloudSync.pushAppSession(session);
}

export function getRecentAppSessions(days = 7): AppSession[] {
  const cutoff = Date.now() - days * 86_400_000;
  return readArr<AppSession>('app_sessions.json')
    .filter(s => new Date(s.startTime).getTime() > cutoff);
}

// ── Intervention Log ───────────────────────────────────────────────────────────

export function logIntervention(
  record: Omit<InterventionRecord, 'id' | 'courseCorrected'>,
): InterventionRecord {
  const all   = readArr<InterventionRecord>('intervention_log.json');
  const entry: InterventionRecord = { id: makeId(), courseCorrected: null, ...record };
  all.push(entry);
  writeArr('intervention_log.json', all, 500);
  console.log(`[BehaviourModel] intervention logged: ${entry.type} (${entry.appContext})`);
  cloudSync.pushIntervention(record);
  return entry;
}

export function updateInterventionOutcome(id: string, courseCorrected: boolean): void {
  const all   = readArr<InterventionRecord>('intervention_log.json');
  const entry = all.find(r => r.id === id);
  if (!entry) return;
  entry.courseCorrected = courseCorrected;
  writeArr('intervention_log.json', all, 500);
}

export function getRecentInterventions(days = 30): InterventionRecord[] {
  const cutoff = Date.now() - days * 86_400_000;
  return readArr<InterventionRecord>('intervention_log.json')
    .filter(r => new Date(r.timestamp).getTime() > cutoff);
}

// ── Session Patterns ───────────────────────────────────────────────────────────

export function updateTodayPattern(patch: Partial<Omit<SessionPattern, 'date'>>): void {
  const all   = readArr<SessionPattern>('session_patterns.json');
  const today = new Date().toISOString().slice(0, 10);
  const idx   = all.findIndex(p => p.date === today);

  let record: SessionPattern;
  if (idx === -1) {
    record = {
      date:               today,
      totalFocusMinutes:  0,
      totalDriftMinutes:  0,
      longestFocusBlock:  0,
      breaksTaken:        0,
      interventionCount:  0,
      ...patch,
    };
    all.push(record);
  } else {
    Object.assign(all[idx], patch);
    record = all[idx];
  }

  writeArr('session_patterns.json', all, 365);
  cloudSync.upsertSessionPattern(record);
}

export function getRecentPatterns(days = 30): SessionPattern[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return readArr<SessionPattern>('session_patterns.json').filter(p => p.date >= cutoffStr);
}

// ── Flow Sessions ──────────────────────────────────────────────────────────────

export function logFlowSession(session: Omit<FlowSession, 'id'>): void {
  const all = readArr<FlowSession>('flow_sessions.json');
  all.push({ id: makeId(), ...session });
  writeArr('flow_sessions.json', all, 200);
  console.log(`[BehaviourModel] flow: ${session.durationMinutes}min on ${session.triggerApp}`);
  cloudSync.pushFlowSession(session);
}

export function getRecentFlowSessions(days = 30): FlowSession[] {
  const cutoff = Date.now() - days * 86_400_000;
  return readArr<FlowSession>('flow_sessions.json')
    .filter(s => new Date(s.startTime).getTime() > cutoff);
}

// ── Override Log ──────────────────────────────────────────────────────────────

export interface OverrideRecord {
  id:        string;
  timestamp: string;  // ISO
  appName:   string;
  hour:      number;
}

export function logOverride(record: Omit<OverrideRecord, 'id'>): void {
  const all = readArr<OverrideRecord>('override_log.json');
  all.push({ id: makeId(), ...record });
  writeArr('override_log.json', all, 200);
  console.log(`[BehaviourModel] override logged: ${record.appName} at ${record.hour}:00`);
}

export function getRecentOverrides(days = 30): OverrideRecord[] {
  const cutoff = Date.now() - days * 86_400_000;
  return readArr<OverrideRecord>('override_log.json')
    .filter(r => new Date(r.timestamp).getTime() > cutoff);
}

// ── Break Log ──────────────────────────────────────────────────────────────────

export function logBreak(record: Omit<BreakRecord, 'id'>): void {
  const all = readArr<BreakRecord>('break_log.json');
  all.push({ id: makeId(), ...record });
  writeArr('break_log.json', all, 200);
}

export function getRecentBreaks(days = 30): BreakRecord[] {
  const cutoff = Date.now() - days * 86_400_000;
  return readArr<BreakRecord>('break_log.json')
    .filter(b => new Date(b.timestamp).getTime() > cutoff);
}

// ── User Profile ───────────────────────────────────────────────────────────────

export function getUserProfile(): UserProfile {
  return readObj<UserProfile>('user_profile.json', ISAAC_DEFAULT_PROFILE);
}

export function saveUserProfile(profile: UserProfile): void {
  writeObj('user_profile.json', profile);
  console.log('[BehaviourModel] user profile saved');
  cloudSync.upsertUserProfile(profile);
}

export function seedDefaultProfileIfMissing(): void {
  if (!fs.existsSync(fp('user_profile.json'))) {
    saveUserProfile(ISAAC_DEFAULT_PROFILE);
    console.log('[BehaviourModel] seeded Isaac\'s default profile');
  }
}

// ── System screen time ────────────────────────────────────────────────────────

/**
 * Returns approximate screen time today in minutes using system boot time.
 * Caps at 16 hours (960 min) as a sanity ceiling.
 * macOS-only; returns 0 on other platforms.
 */
export function getSystemScreenTimeToday(): number {
  if (process.platform !== 'darwin') return 0;
  try {
    const out   = execSync('sysctl -n kern.boottime', { encoding: 'utf8' });
    const match = out.match(/sec = (\d+)/);
    if (!match) return 0;
    const bootMs   = parseInt(match[1]) * 1000;
    const uptimeMs = Date.now() - bootMs;
    return Math.min(Math.round(uptimeMs / 60_000), 16 * 60);
  } catch {
    return 0;
  }
}

// ── Query Functions ────────────────────────────────────────────────────────────

/**
 * Hours of day (0–23) where drift historically peaks.
 * Falls back to profile drift windows when data is thin (<10 interventions).
 */
export function getTypicalDriftWindows(): number[] {
  const interventions = getRecentInterventions(60);

  if (interventions.length < 10) {
    // Fall back to seeded/learned profile
    const profile = getUserProfile();
    const hours: number[] = [];
    for (const w of profile.driftWindows) {
      for (let h = w.start; h < w.end; h++) hours.push(h);
    }
    return hours;
  }

  // Count interventions by hour
  const counts = new Array(24).fill(0) as number[];
  for (const r of interventions) {
    counts[new Date(r.timestamp).getHours()]++;
  }

  const mean = interventions.length / 24;
  return counts
    .map((count, hour) => ({ hour, count }))
    .filter(({ count }) => count > mean * 1.5)
    .map(({ hour }) => hour);
}

/**
 * Median focus block length in minutes across recent session patterns.
 * Falls back to 90 minutes (Isaac's typical flow window) when data is thin.
 */
export function getAverageFocusSessionLength(): number {
  const blocks = getRecentPatterns(30)
    .map(p => p.longestFocusBlock)
    .filter(b => b > 0)
    .sort((a, b) => a - b);

  return blocks.length >= 5 ? blocks[Math.floor(blocks.length / 2)] : 90;
}

/**
 * Apps ranked by how frequently they appear immediately before a drift session.
 * Falls back to profile-seeded drift vectors when data is thin.
 */
export function getDriftVectors(): string[] {
  const sessions = getRecentAppSessions(30);
  const counts   = new Map<string, number>();

  for (let i = 0; i < sessions.length - 1; i++) {
    if (sessions[i + 1].wasDistraction) {
      const a = sessions[i].app;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return getUserProfile().driftVectors;

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([appName]) => appName);
}

// ── Live performance / capacity stats ─────────────────────────────────────────

export interface PerformanceStats {
  peakFocusMins:  number;
  flowStateCount: number;
  deepWorkPct:    number;
  streakDays:     number;
}

export interface CognitiveStats {
  cognitiveCapacity: number;   // 0-100
  lastBreakMins:     number;
  screenTimeMins:    number;
  followThrough:     number | null;
}

export function getPerformanceStats(): PerformanceStats {
  const today    = new Date().toISOString().slice(0, 10);
  const patterns = getRecentPatterns(30);
  const todayP   = patterns.find(p => p.date === today);

  const flowToday = getRecentFlowSessions(1)
    .filter(s => s.startTime.startsWith(today));

  // Consecutive days with >= 60 min focus (newest first)
  const sorted = [...patterns].sort((a, b) => b.date.localeCompare(a.date));
  let streakDays = 0;
  for (const p of sorted) {
    if (p.totalFocusMinutes >= 60) streakDays++;
    else break;
  }

  const focusMins = todayP?.totalFocusMinutes ?? 0;
  const driftMins = todayP?.totalDriftMinutes ?? 0;
  const totalMins = focusMins + driftMins;

  return {
    peakFocusMins:  todayP?.longestFocusBlock ?? 0,
    flowStateCount: flowToday.length,
    deepWorkPct:    totalMins > 0 ? Math.round((focusMins / totalMins) * 100) : 0,
    streakDays,
  };
}

/**
 * Cognitive capacity: starts at 100%, -2% per 30 mins of screen time,
 * +20% per break taken today, floor 20%.
 * screenTimeMins should be supplied by the caller (from windowMonitor).
 */
export function getCognitiveStats(screenTimeMins: number): CognitiveStats {
  const today  = new Date().toISOString().slice(0, 10);
  const breaks = getRecentBreaks(1).filter(b => b.timestamp.startsWith(today));

  let capacity = 100;
  capacity -= Math.floor(screenTimeMins / 30) * 2;
  capacity += breaks.length * 20;
  capacity  = Math.max(20, Math.min(100, capacity));

  const lastBreak = breaks.length > 0
    ? breaks.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
    : null;
  const lastBreakMins = lastBreak
    ? Math.round((Date.now() - new Date(lastBreak.timestamp).getTime()) / 60_000)
    : screenTimeMins;

  return {
    cognitiveCapacity: capacity,
    lastBreakMins,
    screenTimeMins,
    followThrough: getCommitmentFollowThrough(),
  };
}

/**
 * % of non-break interventions that led to course correction.
 * Returns null when fewer than 5 resolved records exist.
 */
export function getInterventionEffectiveness(): number | null {
  const resolved = getRecentInterventions(60)
    .filter(r => r.type !== 'break' && r.courseCorrected !== null);

  if (resolved.length < 5) return null;
  const corrected = resolved.filter(r => r.courseCorrected === true).length;
  return Math.round((corrected / resolved.length) * 100);
}

/**
 * % of suggested breaks that resulted in improved post-break productivity.
 * Returns null when fewer than 5 break records exist.
 */
export function getBreakEffectiveness(): number | null {
  const breaks = getRecentBreaks(30);
  if (breaks.length < 5) return null;
  return Math.round((breaks.filter(b => b.wasProductive).length / breaks.length) * 100);
}

/**
 * % of commitments (made in the last 30 days) that were completed.
 * Reads commitments.json directly. Returns null when data is insufficient.
 */
export function getCommitmentFollowThrough(): number | null {
  const p = path.join(app.getPath('userData'), 'memory', 'commitments.json');
  if (!fs.existsSync(p)) return null;

  let all: Array<{ completedAt: string | null; madeAt: string }>;
  try {
    all = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }

  const cutoff = Date.now() - 30 * 86_400_000;
  const recent = all.filter(c => new Date(c.madeAt).getTime() > cutoff);
  if (recent.length < 3) return null;

  return Math.round((recent.filter(c => c.completedAt !== null).length / recent.length) * 100);
}

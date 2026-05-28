import { exec }      from 'child_process';
import { promisify }  from 'util';
import { randomUUID } from 'crypto';
import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { getRecentInterventions } from './behaviourModel';
import { executeEnvironmentalAction, checkAppCloseRateLimit } from './environmentalControl';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FutureCommitment {
  id:              string;
  condition:       string;   // natural language: "if I open YouTube during work hours"
  consequence:     string;   // natural language: "block my Mac for 30 minutes"
  capturedAt:      string;
  executedAt:      string | null;
  calendarEventId: string | null;
}

interface StreakData {
  currentStreak:      number;
  longestStreak:      number;
  lastDriftFreeDay:   string;  // YYYY-MM-DD
  totalDriftFreeDays: number;
  lastDriftDay:       string | null;
}

// ── Module state ───────────────────────────────────────────────────────────────

let accountabilityContact: string | null = null;
let confirmedDriftStartAt: number | null = null;
let lastTier1At             = 0;
let lastTier2At             = 0;
let tier2FiredToday         = false;
let tier2ResetDateStr       = '';
let lastCommitmentsCheckAt  = 0;

// ── Persistence ────────────────────────────────────────────────────────────────

function dataDir(): string {
  return path.join(app.getPath('userData'), 'memory');
}

function ensureDataDir(): void {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadCommitments(): FutureCommitment[] {
  try {
    const p = path.join(dataDir(), 'future_commitments.json');
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as FutureCommitment[];
  } catch { return []; }
}

function saveCommitments(list: FutureCommitment[]): void {
  try {
    ensureDataDir();
    fs.writeFileSync(path.join(dataDir(), 'future_commitments.json'), JSON.stringify(list, null, 2));
  } catch (e) { console.warn('[ConsequenceEngine] save commitments failed:', e); }
}

function loadStreak(): StreakData {
  try {
    const p = path.join(dataDir(), 'streak.json');
    if (!fs.existsSync(p)) return { currentStreak: 0, longestStreak: 0, lastDriftFreeDay: '', totalDriftFreeDays: 0, lastDriftDay: null };
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StreakData;
  } catch {
    return { currentStreak: 0, longestStreak: 0, lastDriftFreeDay: '', totalDriftFreeDays: 0, lastDriftDay: null };
  }
}

function saveStreak(s: StreakData): void {
  try {
    ensureDataDir();
    fs.writeFileSync(path.join(dataDir(), 'streak.json'), JSON.stringify(s, null, 2));
  } catch (e) { console.warn('[ConsequenceEngine] save streak failed:', e); }
}

function loadContact(): string | null {
  try {
    const p = path.join(dataDir(), 'accountability_contact.json');
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8')) as { contact: string };
    return d.contact ?? null;
  } catch { return null; }
}

function saveContact(contact: string): void {
  try {
    ensureDataDir();
    fs.writeFileSync(path.join(dataDir(), 'accountability_contact.json'), JSON.stringify({ contact }, null, 2));
  } catch (e) { console.warn('[ConsequenceEngine] save contact failed:', e); }
}

// ── Init ───────────────────────────────────────────────────────────────────────

export function initConsequenceEngine(): void {
  accountabilityContact = loadContact();
  console.log(`[ConsequenceEngine] init — contact: ${accountabilityContact ?? 'not set'}`);
}

// ── Ignored intervention streak ────────────────────────────────────────────────

function getIgnoredStreak(): number {
  const recent = getRecentInterventions(7)
    .filter(r => r.type !== 'break' && r.courseCorrected !== null)
    .reverse();
  let streak = 0;
  for (const r of recent) {
    if (r.courseCorrected === false) streak++;
    else break;
  }
  return streak;
}

// ── Tier 1: Environmental consequence ─────────────────────────────────────────

export async function fireTier1Consequence(
  appName: string,
  speakFn: (text: string) => Promise<void>,
): Promise<boolean> {
  if (getIgnoredStreak() < 2)                           return false;
  if (Date.now() - lastTier1At < 30 * 60_000)          return false;
  if (!checkAppCloseRateLimit().allowed)                return false;

  console.log(`[ConsequenceEngine] Tier 1 — closing ${appName} after ${getIgnoredStreak()} ignored interventions`);

  const result = await executeEnvironmentalAction(appName, 10, speakFn);

  if (!result.overridden) {
    lastTier1At = Date.now();
    await speakFn(result.question);
    console.log('[ConsequenceEngine] Tier 1 executed');
  }

  return !result.overridden;
}

// ── Tier 2: Social accountability (8 accuracy gates) ──────────────────────────

function checkTier2Gates(p: {
  ignoredCount:       number;
  driftMinutes:       number;
  isConfirmedDrift:   boolean;
  driftScore:         number;
  timeOfDay:          string;
  hasWorkCommitments: boolean;
  activeApp:          string;
  recentActivityOk:   boolean;
}): boolean {
  const gates = [
    { name: 'min 3 ignored interventions',  pass: p.ignoredCount >= 3 },
    { name: 'min 45 min confirmed drift',   pass: p.driftMinutes >= 45 },
    { name: 'confirmed drift signal',       pass: p.isConfirmedDrift },
    { name: 'drift score >= 65',            pass: p.driftScore >= 65 },
    { name: 'work hours only',              pass: p.timeOfDay === 'morning' || p.timeOfDay === 'afternoon' },
    { name: 'active commitments today',     pass: p.hasWorkCommitments },
    { name: 'clear distraction app',        pass: !['vs code', 'terminal', 'xcode', 'notion', 'cursor'].some(a => p.activeApp.toLowerCase().includes(a)) },
    { name: 'no recent productive activity',pass: !p.recentActivityOk },
  ];

  const failed = gates.filter(g => !g.pass);
  if (failed.length > 0) {
    console.log(`[ConsequenceEngine] Tier 2 gates failed: ${failed.map(f => f.name).join(', ')}`);
    return false;
  }
  console.log('[ConsequenceEngine] Tier 2: all 8 accuracy gates passed');
  return true;
}

export async function fireTier2Consequence(params: {
  ignoredCount:       number;
  driftMinutes:       number;
  isConfirmedDrift:   boolean;
  driftScore:         number;
  timeOfDay:          string;
  hasWorkCommitments: boolean;
  activeApp:          string;
  recentActivityOk:   boolean;
  speakFn:            (text: string) => Promise<void>;
}): Promise<boolean> {
  const contact = accountabilityContact ?? loadContact();
  if (!contact) {
    console.log('[ConsequenceEngine] Tier 2 skipped — no accountability contact set');
    return false;
  }

  // Daily and 6-hour rate limits
  const today = new Date().toDateString();
  if (tier2ResetDateStr !== today) { tier2ResetDateStr = today; tier2FiredToday = false; }
  if (tier2FiredToday)                                 return false;
  if (Date.now() - lastTier2At < 6 * 60 * 60_000)    return false;
  if (process.platform !== 'darwin')                   return false;

  if (!checkTier2Gates(params)) return false;

  const mins = Math.round(params.driftMinutes);
  const userName = process.env.AXON_USER_NAME || 'the user';
  const msg  = `Hey — just a heads up, ${userName} is supposed to be working right now but has been off task for ${mins} minutes. They set this accountability message up themselves.`;

  try {
    const safe   = msg.replace(/"/g, '\\"');
    const script = [
      'tell application "Messages"',
      '  set targetService to first service whose service type = iMessage',
      `  set targetBuddy to buddy "${contact}" of targetService`,
      `  send "${safe}" to targetBuddy`,
      'end tell',
    ].join('\n');
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15_000 });
    lastTier2At    = Date.now();
    tier2FiredToday = true;
    await params.speakFn(`I just messaged ${contact}. ${mins} minutes off task is too long.`);
    console.log(`[ConsequenceEngine] Tier 2: iMessage sent to ${contact}`);
    return true;
  } catch (e) {
    console.error('[ConsequenceEngine] Tier 2 iMessage failed:', e);
    return false;
  }
}

// ── Tier 3: Commitment capture ────────────────────────────────────────────────

export function captureCommitment(condition: string, consequence: string): FutureCommitment {
  const commitment: FutureCommitment = {
    id:              randomUUID(),
    condition,
    consequence,
    capturedAt:      new Date().toISOString(),
    executedAt:      null,
    calendarEventId: null,
  };
  const all = loadCommitments();
  all.push(commitment);
  saveCommitments(all);
  console.log(`[ConsequenceEngine] commitment captured: "${condition}" → "${consequence}"`);
  return commitment;
}

export function getOpenFutureCommitments(): FutureCommitment[] {
  return loadCommitments().filter(c => c.executedAt === null);
}

// Called every cognitive loop tick — rate limited to once per 5 min
export async function checkCommitments(params: {
  activeApp:  string;
  driftScore: number;
  timeOfDay:  string;
  driftTier:  number;
  speakFn:    (text: string) => Promise<void>;
}): Promise<void> {
  if (Date.now() - lastCommitmentsCheckAt < 5 * 60_000) return;
  lastCommitmentsCheckAt = Date.now();

  const open = getOpenFutureCommitments();
  if (open.length === 0) return;

  const contextStr = `App: ${params.activeApp}, drift score: ${params.driftScore}, time: ${params.timeOfDay}, drift tier: ${params.driftTier}`;
  const client     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

  for (const commitment of open) {
    try {
      const resp = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages:   [{ role: 'user', content:
          `Is this condition currently true? Answer YES or NO only.\n` +
          `Condition: "${commitment.condition}"\n` +
          `Context: ${contextStr}`,
        }],
      });
      const block  = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const answer = block?.text.trim().toUpperCase() ?? 'NO';
      if (answer.startsWith('YES')) {
        await executeConsequence(commitment, params.speakFn);
      }
    } catch (e) {
      console.warn('[ConsequenceEngine] commitment check failed:', e);
    }
  }
}

async function executeConsequence(
  commitment: FutureCommitment,
  speakFn:    (text: string) => Promise<void>,
): Promise<void> {
  console.log(`[ConsequenceEngine] executing consequence: "${commitment.consequence}"`);

  // Mark executed before firing to prevent re-entry
  const all = loadCommitments();
  const idx = all.findIndex(c => c.id === commitment.id);
  if (idx !== -1) { all[idx].executedAt = new Date().toISOString(); saveCommitments(all); }

  await speakFn(`Commitment triggered. ${commitment.consequence}`);

  const lower = commitment.consequence.toLowerCase();
  if (lower.includes('block') || lower.includes('calendar') || lower.includes('schedule')) {
    await createConsequenceCalendarEvent(commitment);
  }
}

async function createConsequenceCalendarEvent(commitment: FutureCommitment): Promise<void> {
  if (process.platform !== 'darwin') return;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
  let title    = commitment.consequence;
  let durMins  = 30;

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages:   [{ role: 'user', content:
        `Extract calendar event details from this consequence. Return JSON: {"title":"...","durationMins":30} or null.\n` +
        `Consequence: "${commitment.consequence}"`,
      }],
    });
    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (block) {
      const m = block.text.match(/\{[\s\S]*?\}/);
      if (m) {
        const d = JSON.parse(m[0]) as { title?: string; durationMins?: number };
        if (d.title)       title   = d.title;
        if (d.durationMins) durMins = d.durationMins;
      }
    }
  } catch { /* use defaults */ }

  const now    = new Date();
  const end    = new Date(now.getTime() + durMins * 60_000);
  const safeTit = title.replace(/"/g, '\\"');

  const script = [
    'tell application "Calendar"',
    '  set s to current date',
    `  set year  of s to ${now.getFullYear()}`,
    `  set month of s to ${now.getMonth() + 1}`,
    `  set day   of s to ${now.getDate()}`,
    `  set time  of s to ${now.getHours() * 3600 + now.getMinutes() * 60}`,
    '  set e to current date',
    `  set year  of e to ${end.getFullYear()}`,
    `  set month of e to ${end.getMonth() + 1}`,
    `  set day   of e to ${end.getDate()}`,
    `  set time  of e to ${end.getHours() * 3600 + end.getMinutes() * 60}`,
    '  set cal to first calendar whose writable is true',
    '  tell cal',
    `    set ev to make new event with properties {summary:"${safeTit}", start date:s, end date:e}`,
    '    return uid of ev',
    '  end tell',
    'end tell',
  ].join('\n');

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15_000 });
    const eventId = stdout.trim();
    console.log(`[ConsequenceEngine] calendar event created: ${eventId}`);
    const all = loadCommitments();
    const idx = all.findIndex(c => c.id === commitment.id);
    if (idx !== -1) { all[idx].calendarEventId = eventId; saveCommitments(all); }
  } catch (e) {
    console.warn('[ConsequenceEngine] calendar event failed:', e);
  }
}

// ── Streak tracking ───────────────────────────────────────────────────────────

export function recordDriftResolved(): void {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const streak    = loadStreak();

  if (streak.lastDriftFreeDay === today) return;

  streak.currentStreak     = streak.lastDriftFreeDay === yesterday ? streak.currentStreak + 1 : 1;
  streak.longestStreak     = Math.max(streak.longestStreak, streak.currentStreak);
  streak.lastDriftFreeDay  = today;
  streak.totalDriftFreeDays++;
  saveStreak(streak);
  console.log(`[ConsequenceEngine] drift resolved — streak: ${streak.currentStreak} days`);
}

export function recordDriftOccurred(): void {
  const today  = new Date().toISOString().slice(0, 10);
  const streak = loadStreak();
  if (streak.lastDriftDay === today) return;

  streak.lastDriftDay = today;
  if (streak.lastDriftFreeDay === today) {
    streak.lastDriftFreeDay = '';
    streak.currentStreak    = Math.max(0, streak.currentStreak - 1);
  } else {
    streak.currentStreak = 0;
  }
  saveStreak(streak);
}

export function getStreakSummary(): StreakData & { message: string } {
  const streak = loadStreak();
  let message: string;
  if (streak.currentStreak === 0) {
    message = 'No current streak. Every day is a fresh start.';
  } else if (streak.currentStreak === 1) {
    message = 'One drift-free day. Keep it going.';
  } else if (streak.currentStreak >= 7) {
    message = `${streak.currentStreak}-day streak. That's a full week of clean focus.`;
  } else {
    message = `${streak.currentStreak}-day streak. Best was ${streak.longestStreak} days.`;
  }
  return { ...streak, message };
}

// ── Accountability contact ─────────────────────────────────────────────────────

export function setAccountabilityContact(contact: string): void {
  accountabilityContact = contact;
  saveContact(contact);
  console.log(`[ConsequenceEngine] accountability contact set: ${contact}`);
}

export function getAccountabilityContact(): string | null {
  return accountabilityContact ?? loadContact();
}

// ── Confirmed drift session tracking ──────────────────────────────────────────

export function setConfirmedDriftStart(): void {
  if (confirmedDriftStartAt === null) {
    confirmedDriftStartAt = Date.now();
    console.log('[ConsequenceEngine] confirmed drift session started');
  }
}

export function clearConfirmedDrift(): void {
  confirmedDriftStartAt = null;
}

export function getConfirmedDriftMinutes(): number {
  if (confirmedDriftStartAt === null) return 0;
  return (Date.now() - confirmedDriftStartAt) / 60_000;
}

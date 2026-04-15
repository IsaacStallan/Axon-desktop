/*
 * ════════════════════════════════════════════════════════════════════════════
 * Supabase SQL Migration — run once in the Supabase SQL editor
 * ════════════════════════════════════════════════════════════════════════════
 *
 * -- Device registry
 * create table axon_devices (
 *   device_id text primary key,
 *   device_name text,
 *   last_seen timestamptz default now(),
 *   is_active boolean default false,
 *   current_app text,
 *   productivity_score int default 0,
 *   platform text  -- 'mac' | 'windows' | 'ios'
 * );
 *
 * -- Speaker lock (single-row table)
 * create table axon_speaker_lock (
 *   id int primary key default 1,
 *   held_by text,
 *   locked_at timestamptz,
 *   expires_at timestamptz
 * );
 * -- Seed the single row:
 * insert into axon_speaker_lock (id) values (1) on conflict do nothing;
 *
 * -- Shared app sessions
 * create table axon_app_sessions (
 *   id uuid default gen_random_uuid() primary key,
 *   device_id text,
 *   app text,
 *   start_time timestamptz,
 *   end_time timestamptz,
 *   productivity_score int,
 *   was_distraction boolean,
 *   created_at timestamptz default now()
 * );
 *
 * -- Shared intervention log
 * create table axon_interventions (
 *   id uuid default gen_random_uuid() primary key,
 *   device_id text,
 *   timestamp timestamptz,
 *   type text,
 *   tier text,
 *   message text,
 *   app_context text,
 *   drift_minutes int,
 *   user_responded boolean default false,
 *   course_corrected boolean default false,
 *   psych_technique text,
 *   created_at timestamptz default now()
 * );
 *
 * -- Shared flow sessions
 * create table axon_flow_sessions (
 *   id uuid default gen_random_uuid() primary key,
 *   device_id text,
 *   date date,
 *   start_time timestamptz,
 *   duration_minutes int,
 *   trigger_app text,
 *   created_at timestamptz default now()
 * );
 *
 * -- Shared memory facts
 * create table axon_memory (
 *   id uuid default gen_random_uuid() primary key,
 *   device_id text,
 *   fact text,
 *   created_at timestamptz default now(),
 *   updated_at timestamptz default now()
 * );
 *
 * -- Goals
 * create table axon_goals (
 *   id uuid default gen_random_uuid() primary key,
 *   description text,
 *   success_metric text,
 *   timeframe text,
 *   impact_score int,
 *   active boolean default true,
 *   created_at timestamptz default now()
 * );
 *
 * -- Commitments
 * create table axon_commitments (
 *   id uuid default gen_random_uuid() primary key,
 *   device_id text,
 *   text text,
 *   created_at timestamptz default now(),
 *   completed boolean default false,
 *   completed_at timestamptz,
 *   due_date date
 * );
 *
 * -- Session patterns (daily summary)
 * create table axon_session_patterns (
 *   id uuid default gen_random_uuid() primary key,
 *   date date unique,
 *   total_focus_minutes int,
 *   total_drift_minutes int,
 *   longest_focus_block int,
 *   breaks_taken int,
 *   intervention_count int,
 *   created_at timestamptz default now()
 * );
 *
 * -- Weekly reviews
 * create table axon_weekly_reviews (
 *   id uuid default gen_random_uuid() primary key,
 *   week_start date,
 *   summary text,
 *   productive_hours_avg float,
 *   intervention_effectiveness float,
 *   commitment_followthrough float,
 *   created_at timestamptz default now()
 * );
 *
 * -- User profile (single row)
 * create table axon_user_profile (
 *   id int primary key default 1,
 *   wake_time text,
 *   peak_hours int[],
 *   drift_windows int[],
 *   drift_vectors text[],
 *   work_style text,
 *   non_negotiables text[],
 *   avoidance_tasks text[],
 *   goals_90_day text,
 *   recovery_message text,
 *   war_statement text,
 *   updated_at timestamptz default now()
 * );
 * -- Seed the single row:
 * insert into axon_user_profile (id) values (1) on conflict do nothing;
 * ════════════════════════════════════════════════════════════════════════════
 */

import { createClient }         from '@supabase/supabase-js';
import type { SupabaseClient }  from '@supabase/supabase-js';
import { app }                  from 'electron';
import fs                       from 'fs';
import path                     from 'path';
import os                       from 'os';
import { randomUUID }           from 'crypto';

// ── Supabase client ────────────────────────────────────────────────────────────

let _client: SupabaseClient | null = null;
let _offline = false;

export function getClient(): SupabaseClient | null {
  if (_offline) return null;
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.log('[CloudSync] SUPABASE_URL/KEY not configured — running offline');
    _offline = true;
    return null;
  }

  _client = createClient(url, key);
  return _client;
}

// ── Device identity ────────────────────────────────────────────────────────────

let _deviceId: string | null = null;

export function getDeviceId(): string {
  if (_deviceId) return _deviceId;

  const p = path.join(app.getPath('userData'), 'device-id.json');
  if (fs.existsSync(p)) {
    try {
      _deviceId = (JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string }).id;
      return _deviceId;
    } catch { /* fall through to generation */ }
  }

  _deviceId = randomUUID();
  fs.writeFileSync(p, JSON.stringify({ id: _deviceId }), 'utf8');
  console.log(`[CloudSync] generated new device ID: ${_deviceId}`);
  return _deviceId;
}

export function getDeviceName(): string {
  return process.env.DEVICE_NAME ?? os.hostname();
}

// ── Local path helpers ─────────────────────────────────────────────────────────

function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory');
}

function behaviourDir(): string {
  return path.join(memoryDir(), 'behaviour');
}

function writeLocalFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Drift window helpers ───────────────────────────────────────────────────────

/** Convert [13, 14, 17, 18] → [{ start: 13, end: 15 }, { start: 17, end: 19 }] */
function hoursToWindows(hours: number[]): Array<{ start: number; end: number }> {
  if (!hours || hours.length === 0) return [];
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  let start = sorted[0];
  let prev  = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] > prev + 1) {
      windows.push({ start, end: prev + 1 });
      start = sorted[i];
    }
    prev = sorted[i];
  }
  windows.push({ start, end: prev + 1 });
  return windows;
}

/** Convert [{ start: 13, end: 15 }] → [13, 14] */
function windowsToHours(windows: Array<{ start: number; end: number }>): number[] {
  return windows.flatMap(w => {
    const hours: number[] = [];
    for (let h = w.start; h < w.end; h++) hours.push(h);
    return hours;
  });
}

// ── Startup sync — pull shared data to local JSON ─────────────────────────────

export async function initCloudSync(): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  console.log('[CloudSync] pulling shared data from Supabase...');

  await Promise.allSettled([
    pullUserProfile(sb),
    pullGoals(sb),
    pullCommitments(sb),
    pullFacts(sb),
    pullSessionPatterns(sb),
  ]);

  console.log('[CloudSync] startup sync complete');
}

async function pullUserProfile(sb: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await sb
      .from('axon_user_profile')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !data) return;

    const profile = {
      wakeTime:        (data as Record<string, unknown>).wake_time ?? '07:00',
      peakHours:       (data as Record<string, unknown>).peak_hours ?? [9, 10, 11],
      driftWindows:    hoursToWindows(((data as Record<string, unknown>).drift_windows as number[]) ?? [13, 14, 17, 18]),
      driftVectors:    (data as Record<string, unknown>).drift_vectors ?? [],
      workStyle:       (data as Record<string, unknown>).work_style ?? 'blocks',
      nonNegotiables:  (data as Record<string, unknown>).non_negotiables ?? [],
      avoidanceTasks:  (data as Record<string, unknown>).avoidance_tasks ?? [],
      goals90Day:      (data as Record<string, unknown>).goals_90_day ?? '',
      recoveryMessage: (data as Record<string, unknown>).recovery_message ?? '',
    };

    writeLocalFile(path.join(behaviourDir(), 'user_profile.json'), profile);
    console.log('[CloudSync] user profile pulled');
  } catch (e) {
    console.warn('[CloudSync] pullUserProfile failed:', e);
  }
}

async function pullGoals(sb: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await sb
      .from('axon_goals')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error || !data || (data as unknown[]).length === 0) return;

    const goals = (data as Record<string, unknown>[]).map(g => ({
      id:          g.id as string,
      text:        g.description as string,
      category:    'other',
      impactScore: (g.impact_score as number) ?? 5,
      timeHorizon: (g.timeframe as string) ?? 'this year',
      addedAt:     g.created_at as string,
      updatedAt:   g.created_at as string,
      status:      'active',
      notes:       '',
    }));

    writeLocalFile(path.join(memoryDir(), 'goals.json'), goals);
    console.log(`[CloudSync] ${goals.length} goals pulled`);
  } catch (e) {
    console.warn('[CloudSync] pullGoals failed:', e);
  }
}

async function pullCommitments(sb: SupabaseClient): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data, error } = await sb
      .from('axon_commitments')
      .select('*')
      .eq('completed', false)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false });

    if (error || !data || (data as unknown[]).length === 0) return;

    const commitments = (data as Record<string, unknown>[]).map(c => ({
      id:           c.id as string,
      text:         c.text as string,
      madeAt:       c.created_at as string,
      dueDate:      (c.due_date as string | null) ?? null,
      followedUpAt: null,
      completedAt:  null,
    }));

    writeLocalFile(path.join(memoryDir(), 'commitments.json'), commitments);
    console.log(`[CloudSync] ${commitments.length} commitments pulled`);
  } catch (e) {
    console.warn('[CloudSync] pullCommitments failed:', e);
  }
}

async function pullFacts(sb: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await sb
      .from('axon_memory')
      .select('fact')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error || !data || (data as unknown[]).length === 0) return;

    const facts = (data as { fact: string }[]).map(r => r.fact);
    writeLocalFile(path.join(memoryDir(), 'facts.json'), facts);
    console.log(`[CloudSync] ${facts.length} facts pulled`);
  } catch (e) {
    console.warn('[CloudSync] pullFacts failed:', e);
  }
}

async function pullSessionPatterns(sb: SupabaseClient): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from('axon_session_patterns')
      .select('*')
      .gte('date', cutoff)
      .order('date', { ascending: true });

    if (error || !data || (data as unknown[]).length === 0) return;

    const patterns = (data as Record<string, unknown>[]).map(p => ({
      date:               p.date as string,
      totalFocusMinutes:  (p.total_focus_minutes as number) ?? 0,
      totalDriftMinutes:  (p.total_drift_minutes as number) ?? 0,
      longestFocusBlock:  (p.longest_focus_block as number) ?? 0,
      breaksTaken:        (p.breaks_taken as number) ?? 0,
      interventionCount:  (p.intervention_count as number) ?? 0,
    }));

    writeLocalFile(path.join(behaviourDir(), 'session_patterns.json'), patterns);
    console.log(`[CloudSync] ${patterns.length} session patterns pulled`);
  } catch (e) {
    console.warn('[CloudSync] pullSessionPatterns failed:', e);
  }
}

// ── Push helpers — fire-and-forget, log on failure ────────────────────────────

function fireAndForget(label: string, thenable: PromiseLike<{ error: unknown }>): void {
  void Promise.resolve(thenable).then(({ error }) => {
    if (error) console.warn(`[CloudSync] ${label} failed:`, (error as { message?: string }).message ?? error);
  }).catch(e => {
    console.warn(`[CloudSync] ${label} error:`, e);
    console.warn('[CloudSync] using local fallback');
  });
}

// ── App sessions ───────────────────────────────────────────────────────────────

export function pushAppSession(session: {
  app: string; startTime: string; endTime: string;
  productivityScore: number; wasDistraction: boolean;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushAppSession', sb.from('axon_app_sessions').insert({
    device_id:          getDeviceId(),
    app:                session.app,
    start_time:         session.startTime,
    end_time:           session.endTime,
    productivity_score: session.productivityScore,
    was_distraction:    session.wasDistraction,
  }));
}

// ── Interventions ──────────────────────────────────────────────────────────────

export function pushIntervention(record: {
  timestamp: string; type: string; message: string;
  appContext: string; driftMinutes: number; userResponded: boolean;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushIntervention', sb.from('axon_interventions').insert({
    device_id:      getDeviceId(),
    timestamp:      record.timestamp,
    type:           record.type,
    tier:           record.type,
    message:        record.message,
    app_context:    record.appContext,
    drift_minutes:  record.driftMinutes,
    user_responded: record.userResponded,
  }));
}

// ── Flow sessions ──────────────────────────────────────────────────────────────

export function pushFlowSession(session: {
  startTime: string; durationMinutes: number; triggerApp: string;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushFlowSession', sb.from('axon_flow_sessions').insert({
    device_id:        getDeviceId(),
    date:             session.startTime.slice(0, 10),
    start_time:       session.startTime,
    duration_minutes: session.durationMinutes,
    trigger_app:      session.triggerApp,
  }));
}

// ── Session patterns ───────────────────────────────────────────────────────────

export function upsertSessionPattern(pattern: {
  date: string; totalFocusMinutes: number; totalDriftMinutes: number;
  longestFocusBlock: number; breaksTaken: number; interventionCount: number;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('upsertSessionPattern', sb.from('axon_session_patterns').upsert({
    date:                pattern.date,
    total_focus_minutes: pattern.totalFocusMinutes,
    total_drift_minutes: pattern.totalDriftMinutes,
    longest_focus_block: pattern.longestFocusBlock,
    breaks_taken:        pattern.breaksTaken,
    intervention_count:  pattern.interventionCount,
  }, { onConflict: 'date' }));
}

// ── User profile ───────────────────────────────────────────────────────────────

export function upsertUserProfile(profile: {
  wakeTime: string; peakHours: number[];
  driftWindows: Array<{ start: number; end: number }>;
  driftVectors: string[]; workStyle: string;
  nonNegotiables: string[]; avoidanceTasks: string[];
  goals90Day: string; recoveryMessage: string;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('upsertUserProfile', sb.from('axon_user_profile').upsert({
    id:               1,
    wake_time:        profile.wakeTime,
    peak_hours:       profile.peakHours,
    drift_windows:    windowsToHours(profile.driftWindows),
    drift_vectors:    profile.driftVectors,
    work_style:       profile.workStyle,
    non_negotiables:  profile.nonNegotiables,
    avoidance_tasks:  profile.avoidanceTasks,
    goals_90_day:     profile.goals90Day,
    recovery_message: profile.recoveryMessage,
    updated_at:       new Date().toISOString(),
  }, { onConflict: 'id' }));
}

// ── Goals ──────────────────────────────────────────────────────────────────────

export function pushGoal(goal: {
  text: string; impactScore: number; timeHorizon: string;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushGoal', sb.from('axon_goals').insert({
    description:  goal.text,
    impact_score: goal.impactScore,
    timeframe:    goal.timeHorizon,
    active:       true,
  }));
}

export function deactivateGoal(description: string): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('deactivateGoal', sb.from('axon_goals')
    .update({ active: false })
    .eq('description', description));
}

// ── Commitments ────────────────────────────────────────────────────────────────

export function pushCommitment(c: { text: string; dueDate: string | null }): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushCommitment', sb.from('axon_commitments').insert({
    device_id: getDeviceId(),
    text:      c.text,
    due_date:  c.dueDate,
    completed: false,
  }));
}

export function completeCommitment(text: string): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('completeCommitment', sb.from('axon_commitments')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .eq('text', text)
    .eq('completed', false));
}

// ── Memory facts ───────────────────────────────────────────────────────────────

export function pushFact(fact: string): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushFact', sb.from('axon_memory').insert({
    device_id: getDeviceId(),
    fact,
  }));
}

// ── Weekly reviews ─────────────────────────────────────────────────────────────

export function pushWeeklyReview(review: {
  weekStart: string; summary: string;
  productiveHoursAvg: number;
  interventionEffectiveness: number | null;
  commitmentFollowthrough: number | null;
}): void {
  const sb = getClient();
  if (!sb) return;

  fireAndForget('pushWeeklyReview', sb.from('axon_weekly_reviews').insert({
    week_start:                  review.weekStart,
    summary:                     review.summary,
    productive_hours_avg:        review.productiveHoursAvg,
    intervention_effectiveness:  review.interventionEffectiveness,
    commitment_followthrough:    review.commitmentFollowthrough,
  }));
}

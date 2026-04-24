import * as crypto from 'crypto';
import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDeviceId, getClient } from './cloudSync';

// ── Part 1 — Anonymous cohort ID ──────────────────────────────────────────────

let cohortId: string | null = null;

export function getCohortId(): string {
  if (cohortId) return cohortId;
  const deviceId = getDeviceId();
  cohortId = crypto.createHash('sha256')
    .update(deviceId + 'aretica-collective-salt-v1')
    .digest('hex')
    .slice(0, 16);
  return cohortId;
}

// ── Onboarding age helper ─────────────────────────────────────────────────────

export function getDaysSinceOnboarding(): number {
  try {
    const p    = path.join(app.getPath('userData'), 'onboarding-complete.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { completedAt: string };
    return Math.round(
      (Date.now() - new Date(data.completedAt).getTime()) / (1000 * 60 * 60 * 24),
    );
  } catch {
    return 0;
  }
}

// ── Part 2 — Contribution function ───────────────────────────────────────────

export async function contributeInterventionOutcome(data: {
  interventionType:    string;
  tier:                number;
  appContext:           string;
  timeOfDay:           string;
  dayOfWeek:           string;
  energyLevel:         string;
  driftScore:          number;
  daysSinceOnboarding: number;
  messageLength:       number;
  courseCorrection:    boolean;
  responseTimeSeconds: number;
}): Promise<void> {
  const supabase = getClient();
  if (!supabase) return; // offline — skip silently

  try {
    await supabase.from('collective_interventions').insert({
      cohort_id:             getCohortId(),
      intervention_type:     data.interventionType,
      tier:                  data.tier,
      app_context:           data.appContext,
      time_of_day:           data.timeOfDay,
      day_of_week:           data.dayOfWeek,
      energy_level:          data.energyLevel,
      drift_score:           data.driftScore,
      days_since_onboarding: data.daysSinceOnboarding,
      message_length:        data.messageLength,
      course_corrected:      data.courseCorrection,
      response_time_seconds: data.responseTimeSeconds,
    });
    console.log('[CollectiveIntelligence] intervention outcome contributed');
  } catch (err) {
    // Never block on this — fail silently
    console.error('[CollectiveIntelligence] contribution failed (non-blocking):', err);
  }
}

// ── Part 3 — Pull collective insights ────────────────────────────────────────

interface CollectiveInsight {
  insightType:    string;
  condition:      string;
  recommendation: string;
  confidence:     number;
  sampleSize:     number;
}

let cachedInsights: CollectiveInsight[] = [];
let lastInsightPull                     = 0;

function insightPath(): string {
  return path.join(app.getPath('userData'), 'memory', 'collective_insights.json');
}

export async function pullCollectiveInsights(): Promise<void> {
  if (Date.now() - lastInsightPull < 24 * 60 * 60 * 1000) return;

  const supabase = getClient();
  if (!supabase) {
    // Load from local cache if offline
    try {
      const p = insightPath();
      if (fs.existsSync(p)) cachedInsights = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
    return;
  }

  try {
    const { data, error } = await supabase
      .from('collective_insights')
      .select('*')
      .gte('confidence', 0.65)
      .gte('sample_size', 30)
      .order('confidence', { ascending: false })
      .limit(20);

    if (error) {
      // Table may not exist yet — log the setup SQL
      if ((error as { code?: string }).code === '42P01') {
        logCollectiveSetupSQL();
      } else {
        throw error;
      }
    } else if (data && data.length > 0) {
      cachedInsights = data.map(d => ({
        insightType:    d.insight_type    as string,
        condition:      d.condition       as string,
        recommendation: d.recommendation  as string,
        confidence:     d.confidence      as number,
        sampleSize:     d.sample_size     as number,
      }));
      lastInsightPull = Date.now();
      console.log(`[CollectiveIntelligence] pulled ${cachedInsights.length} insights`);

      const memDir = path.join(app.getPath('userData'), 'memory');
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(insightPath(), JSON.stringify(cachedInsights, null, 2));
    }
  } catch (err) {
    console.error('[CollectiveIntelligence] pull failed:', err);
    // Fall back to local cache
    try {
      const p = insightPath();
      if (fs.existsSync(p)) cachedInsights = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
  }
}

export function getRelevantInsights(context: {
  appContext: string;
  timeOfDay:  string;
  tier:       number;
}): CollectiveInsight[] {
  const app = context.appContext.toLowerCase();
  const tod = context.timeOfDay.toLowerCase();
  return cachedInsights
    .filter(i =>
      i.condition.toLowerCase().includes(tod) ||
      i.condition.toLowerCase().includes(app),
    )
    .slice(0, 3);
}

// ── Part 5 — Supabase setup SQL ───────────────────────────────────────────────

let sqlLogged = false;

export function logCollectiveSetupSQL(): void {
  if (sqlLogged) return;
  sqlLogged = true;
  console.log(`[CollectiveIntelligence] Run this SQL in Supabase to enable collective intelligence:

create table if not exists collective_interventions (
  id uuid default gen_random_uuid() primary key,
  cohort_id text not null,
  intervention_type text,
  tier int,
  app_context text,
  time_of_day text,
  day_of_week text,
  energy_level text,
  drift_score int,
  days_since_onboarding int,
  message_length int,
  course_corrected boolean,
  response_time_seconds int,
  created_at timestamptz default now()
);

create table if not exists collective_insights (
  id uuid default gen_random_uuid() primary key,
  insight_type text,
  condition text,
  recommendation text,
  confidence float default 0,
  sample_size int default 0,
  updated_at timestamptz default now()
);

alter table collective_interventions enable row level security;
alter table collective_insights enable row level security;

create policy "Anyone can contribute" on collective_interventions
  for insert with check (true);

create policy "Anyone can read insights" on collective_insights
  for select using (true);
`);
}

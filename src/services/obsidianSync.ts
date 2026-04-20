import fs   from 'fs';
import path from 'path';
import { getLearnedFacts, getLearnedFactMeta } from './memoryService';
import { getActiveGoals }           from './goalService';
import { getWeeklyPlan }            from './planningService';
import { getRecentInterventions, getRecentAppSessions, getUserProfile } from './behaviourModel';

const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || null;

function axonDir(): string | null {
  if (!OBSIDIAN_VAULT_PATH) return null;
  const dir = path.join(OBSIDIAN_VAULT_PATH, 'Axon');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeVaultFile(filename: string, content: string): void {
  const dir = axonDir();
  if (!dir) return;
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

// ── Individual sync functions ──────────────────────────────────────────────────

async function syncFacts(): Promise<void> {
  const facts   = getLearnedFacts();
  const meta    = getLearnedFactMeta();
  const profile = getUserProfile();
  const ts      = new Date().toLocaleString('en-AU');

  function formatFact(f: string): string {
    const source = meta[f];
    if (source === 'consolidated') return `- ${f} *(consolidated)*`;
    if (source === 'uncertain')    return `- ${f} *(uncertain — verify)*`;
    return `- ${f}`;
  }

  const categories: Record<string, string[]> = {
    'Work & Career':         [],
    'Projects':              [],
    'Goals':                 [],
    'Behavioural Patterns':  [],
    'Preferences & Style':   [],
    'Other':                 [],
  };

  const workKw    = ['work', 'downer', 'crest', 'job', 'startup', 'employ', 'uts', 'university', 'study', 'intern'];
  const projectKw = ['axon', 'grantforge', 'vivify', 'build', 'project', 'app', 'saas', 'launch'];
  const goalKw    = ['goal', 'want', 'aim', 'target', 'achieve', 'revenue', 'mrr', 'financial'];
  const behavKw   = ['drift', 'distract', 'youtube', 'pattern', 'habit', 'morning', 'evening', 'peak', 'avoid', 'sleep'];
  const prefKw    = ['prefer', 'like', 'style', 'communicat', 'respond', 'tone', 'format'];

  for (const fact of facts) {
    const lower = fact.toLowerCase();
    if (workKw.some(k => lower.includes(k)))         categories['Work & Career'].push(fact);
    else if (projectKw.some(k => lower.includes(k))) categories['Projects'].push(fact);
    else if (goalKw.some(k => lower.includes(k)))    categories['Goals'].push(fact);
    else if (behavKw.some(k => lower.includes(k)))   categories['Behavioural Patterns'].push(fact);
    else if (prefKw.some(k => lower.includes(k)))    categories['Preferences & Style'].push(fact);
    else categories['Other'].push(fact);
  }

  const sections = Object.entries(categories)
    .filter(([, items]) => items.length > 0)
    .map(([heading, items]) =>
      `## ${heading}\n${items.map(f => formatFact(f)).join('\n')}`
    ).join('\n\n');

  const driftWindows = (profile.driftWindows ?? [])
    .map(w => `${w.start}:00–${w.end}:00`)
    .join(', ');

  const content = `# Isaac — Axon Profile
*Last updated: ${ts}*
*Total facts: ${facts.length}*

${sections}

---
*Peak hours: ${(profile.peakHours ?? []).join(', ')}*
*Drift windows: ${driftWindows || 'unknown'}*
*Work style: ${profile.workStyle}*
`;

  writeVaultFile('Profile.md', content);
}

async function syncGoals(): Promise<void> {
  const goals = getActiveGoals();
  const ts    = new Date().toLocaleString('en-AU');

  if (goals.length === 0) {
    writeVaultFile('Goals.md', `# Goals\n*Last updated: ${ts}*\n\nNo goals saved yet.\n`);
    return;
  }

  function progressBar(pct: number): string {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
  }

  const lines = goals.map(g => {
    const progress = g.progress ?? 0;
    return [
      `## ${g.text}`,
      `Progress: ${progressBar(progress)}`,
      `Category: ${g.category} | Impact: ${g.impactScore}/10 | Horizon: ${g.timeHorizon}`,
      g.notes ? `Notes: ${g.notes}` : '',
    ].filter(Boolean).join('\n');
  });

  writeVaultFile('Goals.md', `# Goals\n*Last updated: ${ts}*\n\n${lines.join('\n\n')}\n`);
}

async function syncWeeklyPlan(): Promise<void> {
  const plan = getWeeklyPlan();
  const ts   = new Date().toLocaleString('en-AU');

  if (!plan) {
    writeVaultFile('Weekly Plan.md', `# Weekly Plan\n*Last updated: ${ts}*\n\nNo weekly plan generated yet.\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const dayLines = plan.days.map(d => {
    const marker = d.date === today ? ' ← today' : '';
    const lines  = [`### ${d.date}${marker}`, `- Deep work: ${d.deepWorkWindow}`];
    if (d.gymOrRunTime)      lines.push(`- Gym/run: ${d.gymOrRunTime}`);
    if (d.laptopWindDownTime) lines.push(`- Wind-down: ${d.laptopWindDownTime}`);
    if (d.softLockStart)     lines.push(`- Soft lock: ${d.softLockStart}–${d.softLockEnd ?? '?'}`);
    if (d.notes)             lines.push(`- Notes: ${d.notes}`);
    return lines.join('\n');
  }).join('\n\n');

  const goals = plan.weeklyGoals.map(g => `- ${g}`).join('\n');

  writeVaultFile('Weekly Plan.md',
    `# Weekly Plan\n*Last updated: ${ts} | Week of ${plan.weekStarting}*\n\n` +
    `## Schedule\n\n${dayLines}\n\n` +
    `## Weekly Goals\n\n${goals}\n`
  );
}

async function syncInterventionLog(): Promise<void> {
  const interventions = getRecentInterventions(30);
  const ts            = new Date().toLocaleString('en-AU');

  if (interventions.length === 0) {
    writeVaultFile('Intervention Log.md', `# Intervention Log\n*Last updated: ${ts}*\n\nNo interventions in last 30 days.\n`);
    return;
  }

  const rows = interventions.slice(-30).map(r => {
    const time    = new Date(r.timestamp).toLocaleString('en-AU');
    const outcome = r.courseCorrected === true  ? '✓ corrected'
                  : r.courseCorrected === false ? '✗ ignored'
                  : '— pending';
    return `| ${time} | ${r.type} | ${r.message.slice(0, 60)} | ${r.appContext} | ${outcome} |`;
  });

  writeVaultFile('Intervention Log.md',
    `# Intervention Log\n*Last updated: ${ts} | Last 30 interventions*\n\n` +
    `| Time | Type | Message | App | Outcome |\n` +
    `|------|------|---------|-----|---------|\n` +
    rows.join('\n') + '\n'
  );
}

async function syncBehaviourPatterns(): Promise<void> {
  const sessions = getRecentAppSessions(7);
  const profile  = getUserProfile();
  const ts       = new Date().toLocaleString('en-AU');

  const appTotals: Record<string, { mins: number; distraction: boolean }> = {};
  for (const s of sessions) {
    const durMins = (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 60_000;
    if (!appTotals[s.app]) appTotals[s.app] = { mins: 0, distraction: s.wasDistraction };
    appTotals[s.app].mins += durMins;
  }

  const sorted = Object.entries(appTotals)
    .sort((a, b) => b[1].mins - a[1].mins)
    .slice(0, 15);

  const appRows = sorted.map(([app, data]) => {
    const label = data.distraction ? '⚠ drift' : '✓ focus';
    return `| ${app} | ${Math.round(data.mins)} min | ${label} |`;
  });

  const driftVectors = (profile.driftVectors ?? []).map(v => `- ${v}`).join('\n') || '- None recorded yet';
  const peakHours   = (profile.peakHours ?? []).map(h => `${h}:00`).join(', ') || 'unknown';
  const driftWindows = (profile.driftWindows ?? []).map(w => `${w.start}:00–${w.end}:00`).join(', ') || 'unknown';

  writeVaultFile('Behaviour Patterns.md',
    `# Behaviour Patterns\n*Last updated: ${ts} | Last 7 days*\n\n` +
    `## Most Used Apps\n\n| App | Time | Type |\n|-----|------|------|\n${appRows.join('\n')}\n\n` +
    `## Peak Productivity Hours\n${peakHours}\n\n` +
    `## Drift Windows\n${driftWindows}\n\n` +
    `## Known Drift Vectors\n${driftVectors}\n\n` +
    `## Work Style\n${profile.workStyle}\n`
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function syncToObsidian(): Promise<void> {
  if (!OBSIDIAN_VAULT_PATH) return;

  console.log('[ObsidianSync] syncing to vault...');
  try {
    await Promise.all([
      syncFacts(),
      syncGoals(),
      syncWeeklyPlan(),
      syncInterventionLog(),
      syncBehaviourPatterns(),
    ]);
    console.log('[ObsidianSync] sync complete');
  } catch (e) {
    console.warn('[ObsidianSync] sync error:', e);
  }
}

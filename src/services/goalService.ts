import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import * as cloudSync from './cloudSync';

// ── Types ─────────────────────────────────────────────────────────────────────

export type GoalCategory =
  | 'business'
  | 'financial'
  | 'health'
  | 'fitness'
  | 'social'
  | 'sleep'
  | 'learning'
  | 'personal'
  | 'other';

export interface GoalFrequency {
  timesPerWeek?:   number;       // e.g. gym 3x/week
  timesPerDay?:    number;       // e.g. drink water 8x/day
  preferredTimes?: string[];     // e.g. ['17:30', '07:00']
  preferredDays?:  string[];     // e.g. ['monday', 'wednesday', 'friday']
}

export interface Goal {
  id:                       string;
  text:                     string;
  category:                 GoalCategory;
  impactScore:              number;   // 1–10, higher = more critical to Isaac's mission
  timeHorizon:              'this week' | 'this month' | 'this year' | 'life';
  addedAt:                  string;
  updatedAt:                string;
  status:                   'active' | 'achieved' | 'paused';
  notes:                    string;
  progress:                 number;   // 0–100, actual completion percentage
  frequency?:               GoalFrequency;
  lastCompleted?:           string;   // ISO timestamp
  completionsThisWeek?:     number;
  targetMinutesPerSession?: number;   // e.g. 60 for gym sessions
}

// ── Storage ───────────────────────────────────────────────────────────────────

function goalsPath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'goals.json');
}

function readAll(): Goal[] {
  const p = goalsPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeAll(goals: Goal[]): void {
  fs.writeFileSync(goalsPath(), JSON.stringify(goals, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addGoal(
  text:        string,
  category:    GoalCategory = 'other',
  impactScore: number              = 5,
  timeHorizon: Goal['timeHorizon'] = 'this year',
  notes        = '',
): Goal {
  const goals = readAll();
  const goal: Goal = {
    id:          `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text:        text.trim(),
    category,
    impactScore: Math.max(1, Math.min(10, Math.round(impactScore))),
    timeHorizon,
    addedAt:     new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    status:      'active',
    notes,
    progress:    0,
  };
  goals.push(goal);
  writeAll(goals);
  console.log(`[Goals] added (impact ${goal.impactScore}): "${goal.text}"`);
  cloudSync.pushGoal({ text: goal.text, impactScore: goal.impactScore, timeHorizon: goal.timeHorizon });
  return goal;
}

export function getActiveGoals(): Goal[] {
  return readAll()
    .filter(g => g.status === 'active')
    .sort((a, b) => b.impactScore - a.impactScore);
}

export function updateGoal(
  id:      string,
  updates: Partial<Pick<Goal, 'status' | 'impactScore' | 'notes' | 'text' | 'progress'>>,
): boolean {
  const goals = readAll();
  const goal  = goals.find(g => g.id === id);
  if (!goal) return false;
  Object.assign(goal, updates, { updatedAt: new Date().toISOString() });
  writeAll(goals);
  console.log(`[Goals] updated: "${goal.text}"`);
  if (updates.status && updates.status !== 'active') {
    cloudSync.deactivateGoal(goal.text);
  }
  return true;
}

export function hasGoals(): boolean {
  return getActiveGoals().length > 0;
}

/**
 * Returns active goals with their actual progress percentages (0–100).
 * Progress is updated manually via goal_update_progress tool or the weekly review.
 */
export function getGoalProgress(): Array<Goal & { progress: number }> {
  return getActiveGoals().map(g => ({ ...g, progress: g.progress ?? 0 }));
}

/**
 * Returns goals formatted for injection into prompts.
 * Empty string if no active goals.
 */
export function getGoalsText(): string {
  const goals = getActiveGoals();
  if (goals.length === 0) return '';
  return goals
    .map((g, i) => `${i + 1}. [impact ${g.impactScore}/10 · ${g.timeHorizon}] ${g.text}`)
    .join('\n');
}

/**
 * Returns active goals in life categories: health, fitness, social, sleep.
 */
export function getLifeGoals(): Goal[] {
  const LIFE_CATS: GoalCategory[] = ['health', 'fitness', 'social', 'sleep'];
  return readAll()
    .filter(g => g.status === 'active' && LIFE_CATS.includes(g.category))
    .sort((a, b) => b.impactScore - a.impactScore);
}

/**
 * Records a completion for a goal.
 * Resets completionsThisWeek every Monday at midnight.
 */
export function logGoalActivity(goalId: string, durationMinutes?: number): boolean {
  const goals = readAll();
  const goal  = goals.find(g => g.id === goalId);
  if (!goal) return false;

  const now    = new Date();
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // ISO Monday

  // Reset weekly counter if last completion was before this Monday
  if (!goal.lastCompleted || new Date(goal.lastCompleted) < monday) {
    goal.completionsThisWeek = 0;
  }

  goal.lastCompleted       = now.toISOString();
  goal.completionsThisWeek = (goal.completionsThisWeek ?? 0) + 1;
  goal.updatedAt           = now.toISOString();

  // Bump progress toward target if frequency is configured
  if (goal.frequency?.timesPerWeek) {
    const pct = Math.min(100, Math.round((goal.completionsThisWeek / goal.frequency.timesPerWeek) * 100));
    goal.progress = pct;
  }

  writeAll(goals);
  console.log(
    `[Goals] activity logged for "${goal.text}" ` +
    `(${durationMinutes ?? 0}min, ${goal.completionsThisWeek}x this week)`,
  );
  cloudSync.pushGoal({ text: goal.text, impactScore: goal.impactScore, timeHorizon: goal.timeHorizon });
  return true;
}

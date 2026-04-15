import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AxonTask {
  id:          string;
  text:        string;
  addedAt:     string; // ISO timestamp
  doneAt:      string | null;
  surfacedAt:  string | null;
}

// ── Storage path ──────────────────────────────────────────────────────────────

function tasksPath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tasks.json');
}

// ── Read / write ──────────────────────────────────────────────────────────────

function readAll(): AxonTask[] {
  const p = tasksPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeAll(tasks: AxonTask[]): void {
  fs.writeFileSync(tasksPath(), JSON.stringify(tasks, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addTask(text: string): AxonTask {
  const tasks = readAll();
  const task: AxonTask = {
    id:         `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text:       text.trim(),
    addedAt:    new Date().toISOString(),
    doneAt:     null,
    surfacedAt: null,
  };
  tasks.push(task);
  writeAll(tasks);
  console.log(`[Tasks] added: "${task.text}"`);
  return task;
}

export function getPendingTasks(): AxonTask[] {
  return readAll().filter(t => t.doneAt === null);
}

export function getAllTasks(): AxonTask[] {
  return readAll();
}

export function markDone(id: string): boolean {
  const tasks = readAll();
  const task  = tasks.find(t => t.id === id);
  if (!task) return false;
  task.doneAt = new Date().toISOString();
  writeAll(tasks);
  console.log(`[Tasks] done: "${task.text}"`);
  return true;
}

export function markSurfaced(id: string): void {
  const tasks = readAll();
  const task  = tasks.find(t => t.id === id);
  if (!task) return;
  task.surfacedAt = new Date().toISOString();
  writeAll(tasks);
}

/**
 * Returns pending tasks formatted for inclusion in prompts.
 * Returns an empty string if there are no pending tasks.
 */
export function getPendingTasksText(): string {
  const pending = getPendingTasks();
  if (pending.length === 0) return '';
  return pending.map((t, i) => `${i + 1}. ${t.text}`).join('\n');
}

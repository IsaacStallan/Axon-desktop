import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import * as cloudSync from './cloudSync';
import type { Exchange } from './memoryService';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Commitment {
  id:             string;
  text:           string;         // e.g. "do GrantForge outreach"
  madeAt:         string;         // ISO timestamp of when the user said he'd do it
  dueDate:        string | null;  // "today", "tomorrow", or "YYYY-MM-DD" if mentioned
  followedUpAt:   string | null;  // when Axon last asked about it
  completedAt:    string | null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function commitmentsPath(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'commitments.json');
}

function readAll(): Commitment[] {
  const p = commitmentsPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeAll(items: Commitment[]): void {
  fs.writeFileSync(commitmentsPath(), JSON.stringify(items, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addCommitment(text: string, dueDate: string | null = null): Commitment {
  const all = readAll();
  const c: Commitment = {
    id:           `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text:         text.trim(),
    madeAt:       new Date().toISOString(),
    dueDate,
    followedUpAt: null,
    completedAt:  null,
  };
  all.push(c);
  writeAll(all);
  console.log(`[Commitments] logged: "${c.text}"`);
  cloudSync.pushCommitment({ text: c.text, dueDate: c.dueDate });
  return c;
}

/**
 * Returns commitments that are incomplete, not followed up today,
 * and made within the last 48 hours.
 * Older commitments are treated as archived — they remain in storage
 * but are not surfaced in the prompt each session.
 */
export function getOpenCommitments(): Commitment[] {
  const today       = new Date().toISOString().slice(0, 10);
  const cutoff48h   = Date.now() - 48 * 60 * 60 * 1000;
  return readAll().filter(c => {
    if (c.completedAt) return false;
    // Archive commitments older than 48 hours
    if (new Date(c.madeAt).getTime() < cutoff48h) return false;
    // Don't re-surface if we already followed up today
    if (c.followedUpAt && c.followedUpAt.startsWith(today)) return false;
    return true;
  });
}

export function markFollowedUp(id: string): void {
  const all  = readAll();
  const item = all.find(c => c.id === id);
  if (!item) return;
  item.followedUpAt = new Date().toISOString();
  writeAll(all);
}

export function markDone(id: string): boolean {
  const all  = readAll();
  const item = all.find(c => c.id === id);
  if (!item) return false;
  item.completedAt = new Date().toISOString();
  writeAll(all);
  console.log(`[Commitments] done: "${item.text}"`);
  cloudSync.completeCommitment(item.text);
  return true;
}

/**
 * Returns open commitments formatted for prompt injection.
 * Empty string if none.
 */
export function getOpenCommitmentsText(): string {
  const open = getOpenCommitments();
  if (open.length === 0) return '';
  const today = new Date().toISOString().slice(0, 10);
  return open.map((c, i) => {
    const age  = Math.round((Date.now() - new Date(c.madeAt).getTime()) / 86_400_000);
    const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
    const due  = c.dueDate && c.dueDate !== today ? ` (due: ${c.dueDate})` : '';
    return `${i + 1}. "${c.text}" — said ${when}${due}`;
  }).join('\n');
}

/**
 * Scans a single transcript string for completion signals and automatically
 * marks matching open commitments as done.  No API call needed — pure pattern match.
 * Returns the texts of any commitments that were marked complete.
 */
export function detectCompletionsFromTranscript(transcript: string): string[] {
  const norm = transcript.toLowerCase().replace(/[^\w\s]/g, ' ');

  const COMPLETION_SIGNALS = [
    // Direct
    'done', 'finished', 'completed', 'sorted', 'shipped',
    // Past tense actions
    'sent it', 'sent that', 'just sent', 'already sent',
    'did it', 'did that', 'just did', 'already did',
    'built it', 'built that', 'just built',
    'wrote it', 'wrote that', 'just wrote',
    'posted it', 'posted that', 'just posted',
    'submitted', 'just submitted', 'already submitted',
    'recorded', 'just recorded', 'already recorded',
    // Casual
    'its done', "it's done", 'all done', 'good to go',
    'wrapped up', 'wrapped that', 'knocked that out',
    'taken care of', 'handled', 'handled that',
    'got it done', 'got that done',
    'finished that', 'finished it',
    'yeah done', 'yep done', 'yep finished',
    'just finished', 'just wrapped',
    // Existing patterns kept for coverage
    'done with', 'i did', 'i\'ve done', 'took care of',
    'knocked out', 'sent the', 'did the', 'made the', 'wrote the',
  ];

  const hasSignal = COMPLETION_SIGNALS.some(s => norm.includes(s));
  if (!hasSignal) return [];

  const open = getOpenCommitments();
  const completed: string[] = [];

  for (const c of open) {
    const words = c.text.toLowerCase().replace(/[^\w\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) continue;

    const threshold = Math.min(2, Math.ceil(words.length * 0.4));
    const matches   = words.filter(w => norm.includes(w)).length;

    if (matches >= threshold) {
      markDone(c.id);
      completed.push(c.text);
      console.log(`[Commitments] auto-detected completion: "${c.text}"`);
    }
  }

  return completed;
}

/**
 * Sends recent conversation exchanges to Claude and extracts any commitments
 * the user made ("I'll do X", "I'm going to X", "I need to X by Y").
 * Fire-and-forget — caller should not await on the hot path.
 */
export async function extractCommitmentsFromSession(exchanges: Exchange[]): Promise<void> {
  if (exchanges.length === 0) return;

  const text = exchanges
    .map(e => `the user: ${e.user}\nAxon: ${e.axon}`)
    .join('\n\n');

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{
        role:    'user',
        content: `Extract every commitment the user made in this conversation — things he said he WILL do, plans to do, or needs to do.
Include implied commitments ("I'll look into that", "I'm going to start that tomorrow").
Exclude things he's already done or that Axon suggested without the user agreeing.

Return ONLY a raw JSON array of objects: [{"text": "...", "dueDate": "today|tomorrow|YYYY-MM-DD|null"}]
Return [] if no commitments were made.

Conversation:
${text}`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) return;

    const raw   = block.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;

    const items = JSON.parse(match[0]) as Array<{ text: string; dueDate?: string | null }>;
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
      if (typeof item.text === 'string' && item.text.trim()) {
        addCommitment(item.text.trim(), item.dueDate ?? null);
      }
    }
  } catch (e) {
    console.warn('[Commitments] extraction error:', e);
  }
}

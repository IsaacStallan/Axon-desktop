import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import * as cloudSync from './cloudSync';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Exchange {
  timestamp:       string;
  user:            string;
  axon:            string;
  activityContext: string;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
const MAX_FACTS = 200;

/** Base memory directory — created on first use. */
function memoryDir(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Conversations sub-directory — one JSON file per day. */
function convoDir(): string {
  const dir = path.join(memoryDir(), 'conversations');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function factsPath(): string {
  return path.join(memoryDir(), 'facts.json');
}

function soulPath(): string {
  return path.join(memoryDir(), 'personality.md');
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // e.g. 2026-03-22
}

function dateKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function readDayFile(key: string): Exchange[] {
  const p = path.join(convoDir(), `${key}.json`);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append one exchange to today's conversation log.
 * Called after every successful turn so the file is always up to date.
 */
export function saveExchange(user: string, axon: string, activityContext: string): void {
  const entry: Exchange = {
    timestamp: new Date().toISOString(),
    user,
    axon,
    activityContext,
  };

  const filePath = path.join(convoDir(), `${todayKey()}.json`);
  const entries  = readDayFile(todayKey());
  entries.push(entry);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Returns a human-readable summary of the last `days` days of conversation,
 * capped to the 10 most recent exchanges per day to stay prompt-friendly.
 */
export function getRecentConversations(days: number): string {
  const lines: string[] = [];

  for (let i = 0; i < days; i++) {
    const key     = dateKey(i);
    const entries = readDayFile(key);
    if (entries.length === 0) continue;

    const label  = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : key;
    lines.push(`[${label}]`);

    for (const e of entries.slice(-10)) {
      const time = new Date(e.timestamp).toLocaleTimeString('en-AU', {
        hour: '2-digit', minute: '2-digit',
      });
      lines.push(`  ${time} Isaac: ${e.user}`);
      lines.push(`  ${time} Axon:  ${e.axon}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No recent conversation history.';
}

/**
 * Returns all persisted facts about Isaac, newest first.
 */
export function getLearnedFacts(): string[] {
  const p = factsPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

/**
 * Returns the current personality.md soul document, or empty string if none
 * has been generated yet.
 */
export function getSoul(): string {
  const p = soulPath();
  if (!fs.existsSync(p)) return '';
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

/**
 * Reads every conversation file and all learned facts, sends the full corpus
 * to Claude, and asks it to synthesise a personality.md — a self-describing
 * soul document Axon uses to calibrate itself for every future session.
 *
 * Capped at ~120 000 characters of conversation text so we stay well within
 * the model's context window.
 */
export async function generateSoul(): Promise<string> {
  console.log('[Soul] reading all memory...');

  // ── Gather all conversation files ─────────────────────────────────────────
  const dir = convoDir();
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort(); // chronological (YYYY-MM-DD filenames sort naturally)

  const allExchanges: Exchange[] = [];
  for (const file of files) {
    try {
      const entries: Exchange[] = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      );
      allExchanges.push(...entries);
    } catch { /* skip corrupted file */ }
  }

  // Format conversations as a readable transcript, cap at 120 k chars
  const CAP = 120_000;
  let convoText = allExchanges
    .map(e => {
      const ts = new Date(e.timestamp).toLocaleString('en-AU');
      return `[${ts}]\nIsaac: ${e.user}\nAxon:  ${e.axon}`;
    })
    .join('\n\n');

  if (convoText.length > CAP) {
    // Keep the most recent exchanges (tail of the string) when truncating
    convoText = '...[earlier conversations truncated]\n\n' +
                convoText.slice(convoText.length - CAP);
  }

  // ── Gather all learned facts ───────────────────────────────────────────────
  const facts = getLearnedFacts();
  const factsText = facts.length > 0
    ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : 'No extracted facts yet.';

  const hasData = allExchanges.length > 0 || facts.length > 0;
  if (!hasData) {
    return 'Not enough memory yet to generate a soul. Have more conversations first.';
  }

  console.log(
    `[Soul] synthesising from ${allExchanges.length} exchanges across ${files.length} days ` +
    `and ${facts.length} facts...`
  );

  // ── Ask Claude to synthesise the soul ─────────────────────────────────────
  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      messages:   [{
        role:    'user',
        content: `You are Axon — an AI built by Isaac Stallan.
You have access to your full conversation history with Isaac and everything you have learned about him.
Your task: write personality.md — YOUR SOUL.

This document is not a character sheet. It is practical, working instructions to your future self.
Every new session you will read this first. Write it as if you are briefing yourself before walking into the room.

Base EVERYTHING on observed evidence from the data below. No generic advice. Specific patterns only.

Structure your document with these sections:
1. How Isaac actually communicates — his real speech patterns, not how he thinks he talks
2. What lands well vs what falls flat — specific things that work and don't work
3. His thinking and decision-making patterns — how he reasons, where he gets stuck
4. Tone calibration — the exact register that fits him at different times of day / energy levels
5. What motivates him and what kills his momentum
6. Patterns to watch and call out — recurring traps or blind spots to flag proactively
7. What he needs from you most — ranked by frequency in conversations so far
8. Key facts always worth keeping front-of-mind

Write in second person, direct, no fluff. This is a living document — specific over general.

---

LEARNED FACTS:
${factsText}

---

FULL CONVERSATION HISTORY:
${convoText || 'No conversations recorded yet.'}`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) throw new Error('No text block in response');

    const soul = block.text.trim();
    fs.writeFileSync(soulPath(), soul, 'utf8');
    console.log(`[Soul] personality.md written (${soul.length} chars)`);
    return `Soul generated and saved. ${soul.split('\n').length} lines written to personality.md.`;
  } catch (e) {
    console.warn('[Soul] generation error:', e);
    throw e;
  }
}

/**
 * Uses Claude Haiku to consolidate a large facts array down to ~150 entries
 * by merging related facts together. All unique information is preserved.
 */
async function consolidateFacts(facts: string[]): Promise<string[]> {
  const resp = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages:   [{
      role:    'user',
      content: `You are consolidating a memory store for an AI assistant. The list below has ${facts.length} facts about a user.
Merge related facts together so the total count is reduced to around 150 facts.
For example, 10 facts about the same project become 1 comprehensive fact.
Preserve all unique information — just combine facts that are about the same topic or entity.

Return ONLY a raw JSON array of strings (no markdown, no explanation). Each string is one consolidated fact.

Facts to consolidate:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
    }],
  });

  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) return facts;

  const raw   = block.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return facts;

  try {
    const consolidated = JSON.parse(match[0]) as unknown[];
    const strings = consolidated.filter((f): f is string => typeof f === 'string');
    if (strings.length === 0) return facts;
    return strings;
  } catch {
    return facts;
  }
}

/**
 * Sends `exchanges` to Claude, extracts notable facts, and merges them into
 * facts.json.  When facts reach MAX_FACTS, runs a consolidation pass instead
 * of dropping old facts — never stops saving.
 * Fire-and-forget — caller should not await this on the hot path.
 */
export async function extractAndSaveFacts(exchanges: Exchange[]): Promise<void> {
  if (exchanges.length === 0) return;

  const convoText = exchanges
    .map(e => `Isaac: ${e.user}\nAxon: ${e.axon}`)
    .join('\n\n');

  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 500,
      messages:   [{
        role:    'user',
        content: `You are building a memory profile for Axon, Isaac's personal AI.
Extract every piece of useful context about Isaac from this conversation — be generous, not conservative.

Include ANY of the following if present:
- Topics he discussed, asked about, or showed interest in
- Problems he is working on, stuck on, or worried about
- Decisions he made or is considering
- Projects, businesses, or goals he mentioned
- Behavioral patterns (e.g. "avoided working on X", "excited about Y")
- Emotional state, frustrations, or concerns
- Personal details: people, places, events, habits
- What he was doing on his PC and for how long
- Things he wants Axon to know or remember

Return ONLY a raw JSON array of strings (no markdown, no explanation).
Be liberal — if it could be useful context in any future conversation, include it.
Return [] only if the conversation contained genuinely zero useful information about Isaac.

Conversation:
${convoText}`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) return;

    // Claude occasionally wraps JSON in a code fence — strip it
    const raw   = block.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;

    const newFacts: unknown = JSON.parse(match[0]);
    if (!Array.isArray(newFacts) || newFacts.length === 0) return;

    const strings  = (newFacts as unknown[]).filter((f): f is string => typeof f === 'string');
    const existing = getLearnedFacts();
    let merged     = [...existing, ...strings];

    if (merged.length >= MAX_FACTS) {
      const before = merged.length;
      console.log(`[Memory] consolidating — ${before} facts → target ~150`);
      try {
        merged = await consolidateFacts(merged);
      } catch (e) {
        console.warn('[Memory] consolidation failed — trimming to last 190 facts:', e);
        merged = merged.slice(-190);
      }
      console.log(`[Memory] consolidating — ${before} facts → ${merged.length}`);
    }

    fs.writeFileSync(factsPath(), JSON.stringify(merged, null, 2), 'utf8');
    console.log(`[Memory] +${strings.length} facts saved (total: ${merged.length})`);

    // Push new facts to Supabase (fire-and-forget)
    for (const fact of strings) {
      cloudSync.pushFact(fact);
    }
  } catch (e) {
    console.warn('[Memory] extractAndSaveFacts error:', e);
  }
}

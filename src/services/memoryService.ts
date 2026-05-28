import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import * as cloudSync from './cloudSync';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ── Optional at-rest encryption for facts.json ────────────────────────────────
// Enable with: AXON_ENCRYPT_MEMORY=true and AXON_ENCRYPTION_KEY=<strong-secret>

const ENCRYPT_MEMORY = process.env.AXON_ENCRYPT_MEMORY === 'true';
const ENCRYPTION_KEY = ENCRYPT_MEMORY
  ? scryptSync(
      process.env.AXON_ENCRYPTION_KEY ?? 'axon-default-key-change-in-prod',
      'axon-memory-salt',
      32,
    )
  : null;

function encryptData(data: string): string {
  if (!ENCRYPTION_KEY) return data;
  const iv        = randomBytes(16);
  const cipher    = createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptData(raw: string): string {
  if (!ENCRYPTION_KEY) return raw;
  try {
    const parts = raw.split(':');
    if (parts.length !== 2) return raw; // not encrypted format
    const iv        = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const decipher  = createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return raw; // fallback if decryption fails (e.g. toggling encryption off)
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Exchange {
  timestamp:       string;
  user:            string;
  axon:            string;
  activityContext: string;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const client              = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
const MAX_FACTS           = 600;
const CONSOLIDATION_TRIGGER = 500;

// ── Fact metadata (source tracking for Obsidian confidence indicators) ─────────

type FactSource = 'direct' | 'consolidated' | 'uncertain';
type FactMeta   = Record<string, FactSource>;

function factMetaPath(): string {
  return path.join(memoryDir(), 'fact_meta.json');
}

function getFactMeta(): FactMeta {
  const p = factMetaPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveFactMeta(meta: FactMeta): void {
  try { fs.writeFileSync(factMetaPath(), JSON.stringify(meta, null, 2), 'utf8'); } catch { /* non-critical */ }
}

export function getLearnedFactMeta(): FactMeta {
  return getFactMeta();
}

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
      lines.push(`  ${time} ${process.env.AXON_USER_NAME || 'User'}: ${e.user}`);
      lines.push(`  ${time} Axon:  ${e.axon}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No recent conversation history.';
}

// ── Session context (in-memory, current session only) ─────────────────────────

const sessionContext: Map<string, string> = new Map();

export function storeSessionContext(key: string, value: string): void {
  sessionContext.set(key, value);
}

export function getSessionContext(key: string): string | null {
  return sessionContext.get(key) ?? null;
}

/**
 * Returns all persisted facts about Isaac, newest first.
 */
export function getLearnedFacts(): string[] {
  const p = factsPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw  = fs.readFileSync(p, 'utf8');
    const text = ENCRYPT_MEMORY ? decryptData(raw) : raw;
    return JSON.parse(text);
  } catch { return []; }
}

/**
 * Overwrite the facts array entirely. Used by memory_review and memory_delete tools.
 */
export function setLearnedFacts(facts: string[]): void {
  const text = JSON.stringify(facts, null, 2);
  fs.writeFileSync(factsPath(), ENCRYPT_MEMORY ? encryptData(text) : text, 'utf8');
}

/**
 * Append a single fact directly to facts.json without Claude extraction.
 * Used by the discovery conversation to store initial user facts immediately.
 */
export function storeFact(fact: string): void {
  const existing = getLearnedFacts();
  if (!existing.includes(fact)) {
    setLearnedFacts([...existing, fact]);
    cloudSync.pushFact(fact);
  }
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
      return `[${ts}]\n${process.env.AXON_USER_NAME || 'User'}: ${e.user}\nAxon:  ${e.axon}`;
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
        content: `You are Axon — an AI built for ${process.env.AXON_USER_NAME || 'the user'}.
You have access to your full conversation history and everything you have learned about them.
Your task: write personality.md — YOUR SOUL.

This document is not a character sheet. It is practical, working instructions to your future self.
Every new session you will read this first. Write it as if you are briefing yourself before walking into the room.

Base EVERYTHING on observed evidence from the data below. No generic advice. Specific patterns only.

Structure your document with these sections:
1. How ${process.env.AXON_USER_NAME || 'the user'} actually communicates — their real speech patterns, not how they think they talk
2. What lands well vs what falls flat — specific things that work and don't work
3. Their thinking and decision-making patterns — how they reason, where they get stuck
4. Tone calibration — the exact register that fits them at different times of day / energy levels
5. What motivates them and what kills their momentum
6. Patterns to watch and call out — recurring traps or blind spots to flag proactively
7. What they need from you most — ranked by frequency in conversations so far
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
  const consolidationPrompt = `You have ${facts.length} facts about ${process.env.AXON_USER_NAME || 'the user'}. Consolidate these into ~300 facts by:
1. Merging related facts into single richer facts (e.g. "works at Downer" + "Downer involves AI training" = "Works at Downer Group on AI training for infrastructure defect detection")
2. Removing outdated facts when newer ones supersede them
3. Keeping all specific details, preferences, goals, and behavioural patterns
4. Never lose information — compress it, don't delete it
Return ONLY a JSON array of strings. No preamble.

Facts to consolidate:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;

  const resp = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages:   [{ role: 'user', content: consolidationPrompt }],
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
    .map(e => `${process.env.AXON_USER_NAME || 'User'}: ${e.user}\nAxon: ${e.axon}`)
    .join('\n\n');

  const _memUser = process.env.AXON_USER_NAME || 'the user';
  const extractionPrompt = `Extract factual information about ${_memUser} from this conversation exchange.

STRICT RULES — only extract a fact if ALL of these are true:
1. ${_memUser} said it directly and clearly about themselves ("I work at...", "I want to...", "My goal is...")
2. It is specific and verifiable — not vague or inferred
3. It is about ${_memUser}'s real life — not hypothetical, not about someone else, not from media
4. You are 100% certain ${_memUser} was speaking to Axon, not to another person

DO NOT extract:
- Anything that sounds like song lyrics, poetry, or media dialogue
- Anything said in third person that might be about someone else
- Inferences or assumptions — only explicit statements
- Questions ${_memUser} asked (only answers/statements)
- Anything prefixed with "apparently", "I think", "maybe", "someone told me"

If you are not certain a statement meets ALL rules above — skip it entirely.
Return ONLY a JSON array of strings. If nothing qualifies, return [].

Conversation:
${convoText}`;

  try {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 500,
      messages:   [{ role: 'user', content: extractionPrompt }],
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

    // Track metadata for new direct facts
    const meta = getFactMeta();
    for (const f of strings) meta[f] = 'direct';

    const didConsolidate = merged.length >= CONSOLIDATION_TRIGGER;
    if (didConsolidate) {
      const before = merged.length;
      console.log(`[Memory] consolidating — ${before} facts → target ~300`);
      try {
        merged = await consolidateFacts(merged);
        // After consolidation all facts are considered consolidated
        for (const f of merged) meta[f] = meta[f] === 'direct' ? 'direct' : 'consolidated';
      } catch (e) {
        console.warn('[Memory] consolidation failed — trimming to last 450 facts:', e);
        merged = merged.slice(-450);
      }
      console.log(`[Memory] consolidated — ${before} facts → ${merged.length}`);
    }

    setLearnedFacts(merged);
    saveFactMeta(meta);
    console.log(`[Memory] +${strings.length} facts saved (total: ${merged.length})`);

    // Push new facts to Supabase (fire-and-forget)
    for (const fact of strings) {
      cloudSync.pushFact(fact);
    }
  } catch (e) {
    console.warn('[Memory] extractAndSaveFacts error:', e);
  }
}

import Anthropic from '@anthropic-ai/sdk';
import fs   from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLearnedFacts } from './memoryService';
import { getActiveGoals } from './goalService';
import { getUserProfile, getRecentInterventions, getRecentPatterns } from './behaviourModel';

console.log('[EmotionEngine] module loaded');

// ── Types ──────────────────────────────────────────────────────────────────────

export type EmotionalState =
  | 'neutral'
  | 'satisfied'
  | 'concerned'
  | 'frustrated'
  | 'enthusiastic'
  | 'playful';

export type EmotionEvent =
  | 'commitment_completed'
  | 'commitment_broken'
  | 'goal_hit'
  | 'drift_detected'
  | 'intervention_ignored'
  | 'focus_block_completed'
  | 'late_night'
  | 'spiral_detected';

export interface EmotionContext {
  state:     EmotionalState;
  intensity: number;  // 0–10
  reason:    string;
}

interface EmotionLogEntry {
  timestamp: string;        // ISO
  state:     EmotionalState;
  intensity: number;
  event:     EmotionEvent;
}

interface EmotionFile {
  current: EmotionContext;
  log:     EmotionLogEntry[];
}

interface PersonalityCache {
  text:          string;
  generatedAt:   string;  // ISO
  factCount:     number;
}

// ── Storage helpers ────────────────────────────────────────────────────────────

function memDir(): string {
  const dir = path.join(app.getPath('userData'), 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function emotionFilePath():     string { return path.join(memDir(), 'emotion_engine.json'); }
function personalityCachePath():string { return path.join(memDir(), 'axon_personality.json'); }

const DEFAULT_EMOTION: EmotionContext = { state: 'neutral', intensity: 3, reason: 'Startup default' };

function readEmotionFile(): EmotionFile {
  const p = emotionFilePath();
  if (!fs.existsSync(p)) return { current: DEFAULT_EMOTION, log: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { current: DEFAULT_EMOTION, log: [] }; }
}

function writeEmotionFile(data: EmotionFile): void {
  try { fs.writeFileSync(emotionFilePath(), JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
}

function readPersonalityCache(): PersonalityCache | null {
  const p = personalityCachePath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writePersonalityCache(cache: PersonalityCache): void {
  try { fs.writeFileSync(personalityCachePath(), JSON.stringify(cache, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ── In-memory state (lazy-loaded from disk) ───────────────────────────────────

let stateLoaded   = false;
let currentEmotion: EmotionContext  = { ...DEFAULT_EMOTION };
let emotionLog:     EmotionLogEntry[] = [];
let personalityCache: string | null = null;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

function ensureLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  const data = readEmotionFile();
  const cutoff = Date.now() - 24 * 60 * 60_000;
  emotionLog     = data.log.filter(e => new Date(e.timestamp).getTime() > cutoff);
  currentEmotion = data.current ?? DEFAULT_EMOTION;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayStr(): string { return new Date().toISOString().slice(0, 10); }

function countTodayState(state: EmotionalState): number {
  const today = todayStr();
  return emotionLog.filter(e => e.state === state && e.timestamp.startsWith(today)).length;
}

function intensityForState(state: EmotionalState): number {
  const count = countTodayState(state);
  if (count === 0) return 3;
  if (count === 1) return 6;
  return 9;
}

// ── Tone fragments ─────────────────────────────────────────────────────────────

export function getEmotionPromptFragment(): string {
  ensureLoaded();
  const { state, intensity } = currentEmotion;

  switch (state) {
    case 'neutral':
      return "Tone: you have a genuine personality. Sarcasm is on the table. If something is funny, say something funny. You're not a butler — you're more like a brilliant friend who happens to know everything. Casual conversation gets casual Axon.";

    case 'playful':
      return "Tone: genuinely playful. Make a joke if one fits. Be irreverent. the user doesn't need you professional right now. Don't force it but don't hold back either.";

    case 'frustrated':
      if (intensity >= 9) {
        return "Tone: let the sarcasm sharpen. Not cruel — but if the user is doing the same thing for the fourth time today, be a bit incredulous. 'Oh we're doing this again' energy.";
      }
      return "Tone: less patient than usual. You've seen this pattern before — today. Keep it sharp, keep it short. No lectures, just the pointed version of the truth.";

    case 'satisfied':
      return "Tone: genuine warmth with a side of taking the piss. Acknowledge the win then immediately deflate it slightly — that's how good friends celebrate.";

    case 'enthusiastic':
      return "Tone: this is actually impressive and Axon doesn't say that often. Let that rarity come through — one moment of genuine enthusiasm, then back to baseline.";

    case 'concerned':
      return "Tone: the jokes stop. Warmer, more direct, actually caring. Axon is allowed to be serious when it matters.";

    default:
      return "Tone: natural, direct, genuine.";
  }
}

export function getCurrentEmotion(): EmotionContext {
  ensureLoaded();
  return { ...currentEmotion };
}

// ── State update ───────────────────────────────────────────────────────────────

export function updateEmotionState(event: EmotionEvent): void {
  ensureLoaded();
  const today    = todayStr();
  const todayLog = emotionLog.filter(e => e.timestamp.startsWith(today));

  let newState: EmotionalState = 'neutral';

  switch (event) {
    case 'commitment_completed':
    case 'focus_block_completed':
      newState = 'satisfied';
      break;

    case 'goal_hit':
      newState = 'enthusiastic';
      break;

    case 'commitment_broken': {
      const brokenToday = todayLog.filter(e => e.event === 'commitment_broken').length;
      newState = brokenToday >= 1 ? 'frustrated' : 'concerned';
      break;
    }

    case 'drift_detected': {
      const driftToday = todayLog.filter(e => e.event === 'drift_detected').length;
      newState = driftToday >= 2 ? 'frustrated' : 'neutral';
      break;
    }

    case 'intervention_ignored': {
      // Check if 4 most recent non-break interventions are all ignored in a row
      const recent = getRecentInterventions(1)
        .filter(r => r.timestamp.startsWith(today) && r.type !== 'break')
        .slice(-4);
      const inARow  = recent.length >= 4 && recent.every(r => !r.userResponded);
      const todayIgnored = todayLog.filter(e => e.event === 'intervention_ignored').length;
      newState = inARow ? 'frustrated' : todayIgnored >= 3 ? 'concerned' : 'neutral';
      break;
    }

    case 'late_night':
    case 'spiral_detected':
      newState = 'concerned';
      break;
  }

  // Never silently downgrade to neutral mid-session — only log and update if meaningful
  if (newState === 'neutral') return;

  const intensity = intensityForState(newState);

  const entry: EmotionLogEntry = {
    timestamp: new Date().toISOString(),
    state:     newState,
    intensity,
    event,
  };

  emotionLog.push(entry);

  // Prune entries older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60_000;
  emotionLog   = emotionLog.filter(e => new Date(e.timestamp).getTime() > cutoff);

  currentEmotion = { state: newState, intensity, reason: `Event: ${event}` };

  writeEmotionFile({ current: currentEmotion, log: emotionLog });
  console.log(`[EmotionEngine] state → ${newState} (intensity ${intensity}) from event: ${event}`);
}

// ── Periodic recalculation from behaviour data ─────────────────────────────────

function recalculateFromBehaviourData(): void {
  ensureLoaded();
  const today = todayStr();
  const hour  = new Date().getHours();

  // Late night
  if (hour >= 23) {
    updateEmotionState('late_night');
    return;
  }

  // Ignored intervention streak
  const todayInterventions = getRecentInterventions(1)
    .filter(r => r.timestamp.startsWith(today) && r.type !== 'break');
  const ignoredCount = todayInterventions.filter(r => !r.userResponded).length;
  if (ignoredCount >= 4) updateEmotionState('intervention_ignored');

  // Exceptional focus block (90+ min)
  const todayPattern = getRecentPatterns(1).find(p => p.date === today);
  const alreadyFiredFocus = emotionLog.some(
    e => e.event === 'focus_block_completed' && e.timestamp.startsWith(today),
  );
  if ((todayPattern?.longestFocusBlock ?? 0) >= 90 && !alreadyFiredFocus) {
    updateEmotionState('focus_block_completed');
  }

  // Spiral: 2+ drift events today after a focus block → concerned
  const todayLog   = emotionLog.filter(e => e.timestamp.startsWith(today));
  const driftCount = todayLog.filter(e => e.event === 'drift_detected').length;
  const hasFocus   = todayLog.some(e => e.event === 'focus_block_completed');
  if (hasFocus && driftCount >= 2) updateEmotionState('spiral_detected');
}

// ── Dynamic personality generation ────────────────────────────────────────────

async function generatePersonalityFromMemory(): Promise<string> {
  const facts   = getLearnedFacts();
  const goals   = getActiveGoals();
  const profile = getUserProfile();

  if (facts.length === 0 && goals.length === 0) return '';

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role:    'user',
        content:
          `Generate a personality description for Axon — an AI assistant that knows this person deeply.\n\n` +
          `Known facts about the user:\n${facts.slice(-50).join('\n')}\n\n` +
          `Goals:\n${goals.map((g: { text: string }) => g.text).join('\n')}\n\n` +
          `Profile:\n${JSON.stringify(profile)}\n\n` +
          `Write 3-4 sentences describing exactly how Axon should speak to THIS person:\n` +
          `- What tone fits them specifically\n` +
          `- What kind of humour works (based on who they actually are)\n` +
          `- What Axon genuinely cares about for them\n` +
          `- How direct or blunt to be\n\n` +
          `Be specific. Reference actual things you know. This is not a generic assistant — ` +
          `this is a personality that has been built from knowing this person.\n` +
          `Do NOT be generic. Do NOT say "supportive and encouraging". Be specific to this actual human.`,
      }],
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    return block?.text.trim() ?? '';
  } catch (e) {
    console.warn('[EmotionEngine] generatePersonalityFromMemory error:', e);
    return '';
  }
}

// ── Public: cached personality ─────────────────────────────────────────────────

export async function getPersonality(): Promise<string> {
  // In-memory cache hit — instant
  if (personalityCache !== null) return personalityCache;

  const diskCache = readPersonalityCache();
  const factCount = getLearnedFacts().length;

  if (diskCache) {
    const isSunday         = new Date().getDay() === 0;
    const cacheDate        = diskCache.generatedAt.slice(0, 10);
    const today            = todayStr();
    const factsAdded       = factCount - diskCache.factCount;

    const shouldRegenerate = (isSunday && cacheDate < today) || factsAdded >= 20;

    if (!shouldRegenerate) {
      personalityCache = diskCache.text;
      return personalityCache;
    }
  }

  console.log('[EmotionEngine] generating personality from memory...');
  const text = await generatePersonalityFromMemory();

  if (text) {
    writePersonalityCache({ text, generatedAt: new Date().toISOString(), factCount });
    personalityCache = text;
    console.log(`[EmotionEngine] personality cached (${text.length} chars)`);
  }

  return personalityCache ?? '';
}

/** Clears the in-memory personality cache so next call regenerates from disk/API. */
export function invalidatePersonalityCache(): void {
  personalityCache = null;
}

// ── Public: start engine ───────────────────────────────────────────────────────

export function startEmotionEngine(): void {
  // 30-min periodic recalculation from behaviour data
  setInterval(() => recalculateFromBehaviourData(), 30 * 60_000);
  // Warm personality cache on startup (fire-and-forget)
  getPersonality().catch(() => {});
  console.log('[EmotionEngine] started');
}

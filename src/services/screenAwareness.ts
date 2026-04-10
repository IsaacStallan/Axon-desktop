import { desktopCapturer, BrowserWindow } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';

console.log('[ScreenAwareness] module loaded');

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScreenContext {
  activeApp:          string;
  activity:           string;
  visibleContent:     string;
  productivitySignal: 'productive' | 'distracted' | 'idle';
  timestamp:          number;
  notes:              string;
}

// ── Change event bus ───────────────────────────────────────────────────────────

/** Emits `screen:changed` with a ScreenContext payload when changeScore > 40. */
export const screenEvents = new EventEmitter();

// ── Module state ───────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// Rolling window — raw screenshots are NEVER stored; only parsed ScreenContext
const recentContexts: ScreenContext[] = [];
const MAX_CONTEXTS = 5;

let orbWin:       BrowserWindow | null = null;
let monitorTimer: NodeJS.Timeout | undefined;

const FALLBACK: ScreenContext = {
  activeApp:          '',
  activity:           '',
  visibleContent:     '',
  productivitySignal: 'idle',
  timestamp:          0,
  notes:              '',
};

export function setOrbWindow(win: BrowserWindow): void {
  orbWin = win;
}

// ── Change scoring ─────────────────────────────────────────────────────────────

/**
 * Scores how much the screen context changed between two captures (0–100).
 * App changed → 50 pts, activity description changed significantly → 30 pts,
 * productivity signal changed → 20 pts.
 */
function computeChangeScore(prev: ScreenContext, next: ScreenContext): number {
  let score = 0;

  if (prev.activeApp.toLowerCase() !== next.activeApp.toLowerCase()) {
    score += 50;
  }

  if (prev.activity.toLowerCase() !== next.activity.toLowerCase()) {
    // Weight by word-overlap — minor rewording of the same idea scores 0
    const prevWords = new Set(prev.activity.toLowerCase().split(/\s+/));
    const nextWords = next.activity.toLowerCase().split(/\s+/);
    const overlap   = nextWords.filter(w => prevWords.has(w)).length;
    const total     = Math.max(prevWords.size, 1);
    if (overlap / total < 0.5) score += 30;
  }

  if (prev.productivitySignal !== next.productivitySignal) {
    score += 20;
  }

  return score;
}

// ── Screen capture ─────────────────────────────────────────────────────────────

/** Returns a base64-encoded PNG of the primary display. */
export async function captureScreen(): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types:         ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });

  if (!sources.length) throw new Error('No screen sources available — check screen recording permission');

  const png    = sources[0].thumbnail.toPNG();
  const base64 = png.toString('base64');
  if (!base64 || base64.length < 100) throw new Error('empty screenshot — skipping');
  return base64;
}

// ── Vision analysis ────────────────────────────────────────────────────────────

/** Captures the screen and sends it to Claude Haiku for analysis. */
export async function analyseScreen(): Promise<ScreenContext> {
  let base64Screenshot: string;
  try {
    base64Screenshot = await captureScreen();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'empty screenshot — skipping') {
      const cached = recentContexts[recentContexts.length - 1];
      console.log('[ScreenAwareness] empty capture — using cached context');
      return cached ? { ...cached, timestamp: Date.now() } : { ...FALLBACK, timestamp: Date.now() };
    }
    console.warn('[ScreenAwareness] capture failed (screen recording permission?):', e);
    return { ...FALLBACK, timestamp: Date.now() };
  }

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:
        'You are analysing a Mac desktop screenshot for an AI assistant. ' +
        'Return ONLY valid JSON — no markdown, no explanation. ' +
        'Fields: activeApp (string), activity (string — what user is doing), ' +
        'visibleContent (string — key visible content, summarised), ' +
        'productivitySignal ("productive"|"distracted"|"idle"), ' +
        'notes (string — anything the AI should know to be helpful). ' +
        'All string values max 1-2 sentences.',
      messages: [{
        role:    'user',
        content: [
          {
            type:   'image',
            source: {
              type:       'base64',
              media_type: 'image/png',
              data:        base64Screenshot,
            },
          },
          {
            type: 'text',
            text:
              "Analyse this Mac desktop screenshot for an AI productivity assistant. " +
              "Describe: 1) The active app and what the user is doing " +
              "2) Key visible content (code, errors, documents — summarise don't transcribe) " +
              "3) Productivity signal: productive/distracted/idle " +
              "4) Anything the AI should know. Return as JSON only.",
          },
        ],
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const raw       = textBlock?.type === 'text' ? textBlock.text.trim() : '';

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON found in Haiku response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(match[0]) as Partial<ScreenContext>;

    const valid: ScreenContext['productivitySignal'][] = ['productive', 'distracted', 'idle'];
    const ctx: ScreenContext = {
      activeApp:          parsed.activeApp          ?? '',
      activity:           parsed.activity           ?? '',
      visibleContent:     parsed.visibleContent     ?? '',
      productivitySignal: valid.includes(parsed.productivitySignal as ScreenContext['productivitySignal'])
        ? parsed.productivitySignal as ScreenContext['productivitySignal']
        : 'idle',
      timestamp:          Date.now(),
      notes:              parsed.notes              ?? '',
    };

    // Keep previous context before pushing so we can score the change
    const prevCtx = recentContexts.length > 0
      ? recentContexts[recentContexts.length - 1]
      : null;

    recentContexts.push(ctx);
    if (recentContexts.length > MAX_CONTEXTS) recentContexts.shift();

    console.log(
      `[ScreenAwareness] captured screen — ` +
      `active: ${ctx.activeApp} — activity: ${ctx.activity}, signal: ${ctx.productivitySignal}`,
    );

    // Passive observation — emit change event when context shifts meaningfully
    if (prevCtx) {
      const changeScore = computeChangeScore(prevCtx, ctx);
      if (changeScore > 40) {
        console.log(`[ScreenAwareness] change score ${changeScore} — emitting screen:changed`);
        screenEvents.emit('screen:changed', ctx);
      }
    }

    return ctx;
  } catch (e) {
    console.warn('[ScreenAwareness] vision analysis failed:', e);
    return { ...FALLBACK, timestamp: Date.now() };
  }
}

// ── Periodic monitor ──────────────────────────────────────────────────────────

export function startScreenMonitor(intervalMs = 30_000): void {
  if (monitorTimer) clearInterval(monitorTimer);
  console.log(`[ScreenAwareness] starting monitor (every ${intervalMs / 1000}s)`);
  // First capture on next tick — gives Electron time to settle after startup
  setTimeout(() => { void analyseScreen(); }, 5_000);
  monitorTimer = setInterval(() => { void analyseScreen(); }, intervalMs);
}

export function stopScreenMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = undefined;
    console.log('[ScreenAwareness] monitor stopped');
  }
}

// ── Getters ────────────────────────────────────────────────────────────────────

/** Returns last 5 screen contexts (no raw image data — privacy safe). */
export function getRecentContext(): ScreenContext[] {
  return [...recentContexts];
}

/** Single-line summary for injection into decision engine / conversation. */
export function getCurrentScreenSummary(): string {
  if (recentContexts.length === 0) return '';
  const ctx = recentContexts[recentContexts.length - 1];
  if (!ctx.activeApp) return '';
  let s = `User is in ${ctx.activeApp} — ${ctx.activity}.`;
  if (ctx.notes) s += ` ${ctx.notes}`;
  return s;
}

// ── On-demand (conversation-triggered) ────────────────────────────────────────

/** Captures + analyses immediately; notifies the orb UI while working. */
export async function analyseOnDemand(): Promise<ScreenContext> {
  if (orbWin && !orbWin.isDestroyed()) {
    orbWin.webContents.send('axon:screen', 'Axon is looking at your screen...');
  }
  const ctx = await analyseScreen();
  return ctx;
}

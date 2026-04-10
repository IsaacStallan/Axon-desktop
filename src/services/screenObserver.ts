import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow } from 'electron';
import { screenEvents }               from './screenAwareness';
import type { ScreenContext }          from './screenAwareness';
import { triggerContentQualityCheck, flagDistractionContext } from './interventionDecider';
import { speak, isSpeaking }          from './elevenLabsService';
import { isConversationActive }        from './conversationService';
import { setLastProactiveMessage }    from './proactiveContext';
import {
  acquireSpeakerLock,
  releaseSpeakerLock,
} from './deviceCoordinator';

console.log('[ScreenObserver] module loaded');

// ── Types ──────────────────────────────────────────────────────────────────────

type ActivityMode =
  | 'deep_work'
  | 'studying'
  | 'communication'
  | 'planning'
  | 'distraction'
  | 'idle';

// ── Module state ───────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

let orbWin: BrowserWindow | null = null;
let lastKnownMode: ActivityMode  = 'idle';
let lastCommentTime              = 0;
const COMMENT_COOLDOWN_MS        = 5 * 60_000;  // 5 min between unprompted comments

export function setOrbWindow(win: BrowserWindow): void {
  orbWin = win;
}

// ── Context classifiers ────────────────────────────────────────────────────────

function isWritingContext(ctx: ScreenContext): boolean {
  const act = ctx.activity.toLowerCase();
  const app = ctx.activeApp.toLowerCase();
  return (
    act.includes('writ')  || act.includes('typ')    || act.includes('draft') ||
    act.includes('edit')  || act.includes('compos') || act.includes('cod')   ||
    app.includes('mail')  || app.includes('word')   || app.includes('notion') ||
    app.includes('notes') || app.includes('vs code') || app.includes('docs')  ||
    app.includes('pages') || app.includes('cursor')
  );
}

function isDistractionContext(ctx: ScreenContext): boolean {
  const app = ctx.activeApp.toLowerCase();
  return (
    ctx.productivitySignal === 'distracted' ||
    app.includes('youtube') || app.includes('reddit') ||
    app.includes('instagram') || app.includes('tiktok') ||
    app.includes('twitter') || app.includes('x.com')
  );
}

function classifyMode(ctx: ScreenContext): ActivityMode {
  if (ctx.productivitySignal === 'idle') return 'idle';
  if (isDistractionContext(ctx))         return 'distraction';

  const app = ctx.activeApp.toLowerCase();
  const act = ctx.activity.toLowerCase();

  if (
    act.includes('cod') || act.includes('devel') || act.includes('build') ||
    act.includes('program') || app.includes('vs code') || app.includes('cursor') ||
    app.includes('xcode') || app.includes('warp') || app.includes('terminal')
  ) return 'deep_work';

  if (
    act.includes('read') || act.includes('study') || act.includes('research') ||
    act.includes('notes') || app.includes('notion') || app.includes('obsidian')
  ) return 'studying';

  if (
    app.includes('mail') || app.includes('slack') || app.includes('messages') ||
    app.includes('discord') || act.includes('email') || act.includes('chat')
  ) return 'communication';

  if (
    app.includes('calendar') || act.includes('plan') || act.includes('schedul')
  ) return 'planning';

  return 'deep_work';  // productive but unclassified
}

function isUnexpectedContext(prevMode: ActivityMode, ctx: ScreenContext): boolean {
  const currMode = classifyMode(ctx);
  // Productive → distraction is the core unexpected pattern
  if (
    ['deep_work', 'studying', 'planning', 'communication'].includes(prevMode) &&
    currMode === 'distraction'
  ) return true;
  // Deep work → anything non-work is worth noticing
  if (prevMode === 'deep_work' && currMode !== 'deep_work' && currMode !== 'idle') return true;
  return false;
}

// ── Proactive comment (Haiku, SKIP-guarded) ────────────────────────────────────

async function evaluateProactiveComment(ctx: ScreenContext): Promise<void> {
  if (isSpeaking || isConversationActive()) return;

  const now = Date.now();
  if (now - lastCommentTime < COMMENT_COOLDOWN_MS) return;

  if (orbWin && !orbWin.isDestroyed()) {
    orbWin.webContents.send('axon:activity', 'Watching your screen...');
  }

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role:    'user',
        content:
          `The user's screen just changed to show: ${ctx.activeApp} — ${ctx.activity}.\n` +
          (ctx.visibleContent ? `Visible content: ${ctx.visibleContent.slice(0, 200)}\n` : '') +
          (ctx.notes ? `Notes: ${ctx.notes}\n` : '') +
          `\nIs there anything genuinely useful to say right now? ` +
          `Only respond if there's something specific and valuable — an observation, a useful reminder, ` +
          `a relevant fact, or a heads-up that would actually help. ` +
          `Keep it 1–2 natural spoken sentences. ` +
          `If nothing worth saying, respond with exactly "SKIP".`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const text  = block?.text.trim() ?? 'SKIP';

    if (text.toUpperCase() === 'SKIP' || !text) return;

    lastCommentTime = now;

    if (isSpeaking || isConversationActive()) return;

    console.log(`[ScreenObserver] proactive comment: "${text.slice(0, 80)}"`);
    setLastProactiveMessage(text, 'predictive');

    if (await acquireSpeakerLock(30_000)) {
      try {
        await speak(text);
      } finally {
        await releaseSpeakerLock();
      }
    }
  } catch (e) {
    console.warn('[ScreenObserver] proactive comment error:', e);
  }
}

// ── Core router ────────────────────────────────────────────────────────────────

function onScreenChanged(ctx: ScreenContext): void {
  const prevMode = lastKnownMode;
  lastKnownMode  = classifyMode(ctx);

  console.log(
    `[ScreenObserver] screen changed — mode: ${prevMode} → ${lastKnownMode}, ` +
    `app: ${ctx.activeApp}, signal: ${ctx.productivitySignal}`,
  );

  if (isWritingContext(ctx)) {
    console.log('[ScreenObserver] writing context — triggering content quality check');
    triggerContentQualityCheck();
  }

  if (isDistractionContext(ctx)) {
    console.log('[ScreenObserver] distraction context — notifying decision engine');
    flagDistractionContext();
  }

  if (isUnexpectedContext(prevMode, ctx)) {
    console.log(`[ScreenObserver] unexpected context (${prevMode} → ${lastKnownMode}) — evaluating proactive comment`);
    void evaluateProactiveComment(ctx);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function startScreenObserver(): void {
  screenEvents.on('screen:changed', (ctx: ScreenContext) => {
    onScreenChanged(ctx);
  });
  console.log('[ScreenObserver] listening for screen:changed events');
}

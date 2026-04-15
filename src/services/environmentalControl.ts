import { exec }    from 'child_process';
import { promisify } from 'util';
import { transcribe }           from './whisperService';
import { isConversationActive } from './conversationService';
import { getProductivityScore, getCurrentApp } from './windowMonitor';

const execAsync = promisify(exec);

// ── Drift vector map: app name fragment → replacement app ──────────────────────

const DRIFT_VECTOR_MAP = new Map<string, string>([
  ['youtube',     'Visual Studio Code'],
  ['crunchyroll', 'Visual Studio Code'],
  ['netflix',     'Visual Studio Code'],
  ['instagram',   'Visual Studio Code'],
  ['tiktok',      'Visual Studio Code'],
  ['twitter',     'Visual Studio Code'],
  ['reddit',      'Visual Studio Code'],
  ['x.com',       'Visual Studio Code'],
]);

// ── Override keywords (case-insensitive substring match) ──────────────────────

const OVERRIDE_KEYWORDS = ['keep it open', 'i need this', 'leave it', 'stop', 'cancel'];

// ── In-memory state ───────────────────────────────────────────────────────────

interface GracePeriod {
  appName: string;
  endsAt:  number;
}

const activePeriods: GracePeriod[] = [];
const recentlyClosed = new Map<string, number>(); // appName.toLowerCase → epoch ms

// ── Grace period helpers ──────────────────────────────────────────────────────

export function isInGracePeriod(appName: string): boolean {
  const now = Date.now();
  return activePeriods.some(
    g => g.appName.toLowerCase() === appName.toLowerCase() && g.endsAt > now,
  );
}

export function setGracePeriod(appName: string, minutes = 20): void {
  const key = appName.toLowerCase();
  const idx = activePeriods.findIndex(g => g.appName.toLowerCase() === key);
  if (idx !== -1) activePeriods.splice(idx, 1);
  activePeriods.push({ appName, endsAt: Date.now() + minutes * 60_000 });
  console.log(`[EnvControl] grace period set for ${appName} (${minutes}min)`);
}

export function getGracePeriodRemainingMins(appName: string): number {
  const now = Date.now();
  const gp  = activePeriods.find(
    g => g.appName.toLowerCase() === appName.toLowerCase() && g.endsAt > now,
  );
  return gp ? Math.max(0, (gp.endsAt - now) / 60_000) : 0;
}

// ── Safety gate ───────────────────────────────────────────────────────────────

function isSafeToTarget(appName: string): boolean {
  if (getProductivityScore() > 60)  return false;  // currently in a productive session
  if (isConversationActive())        return false;  // don't interrupt conversation
  if (isInGracePeriod(appName))      return false;  // user just overrode this app

  const lastClosed = recentlyClosed.get(appName.toLowerCase());
  if (lastClosed && Date.now() - lastClosed < 60 * 60_000) return false;  // closed < 1h ago

  const curr = getCurrentApp();
  if (curr.name === appName && curr.durationMins < 10) return false;  // opened < 10 min ago

  return true;
}

// ── Core AppleScript controls ─────────────────────────────────────────────────

export async function closeApp(appName: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execAsync(`osascript -e 'quit app "${appName}"'`);
    recentlyClosed.set(appName.toLowerCase(), Date.now());
    console.log(`[EnvControl] closed: ${appName}`);
  } catch (e) {
    console.warn(`[EnvControl] closeApp failed (${appName}):`, e);
  }
}

export async function openApp(appName: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execAsync(`open -a "${appName}"`);
    console.log(`[EnvControl] opened: ${appName}`);
  } catch (e) {
    console.warn(`[EnvControl] openApp failed (${appName}):`, e);
  }
}

export async function focusApp(appName: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execAsync(`osascript -e 'tell application "${appName}" to activate'`);
    console.log(`[EnvControl] focused: ${appName}`);
  } catch (e) {
    console.warn(`[EnvControl] focusApp failed (${appName}):`, e);
  }
}

export async function closeBrowserTab(urlPattern: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const safe = urlPattern.replace(/'/g, '');  // strip quotes to prevent injection
  const script = `
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "${safe}" then close t
        end repeat
      end repeat
    end tell`;
  try {
    await execAsync(`osascript -e '${script}'`);
    console.log(`[EnvControl] closed browser tab matching: ${urlPattern}`);
  } catch (e) {
    console.warn('[EnvControl] closeBrowserTab failed:', e);
  }
}

// ── Warn + listen for override ────────────────────────────────────────────────

/**
 * Speaks a countdown warning, then listens for the full `seconds` window.
 * Returns true if the user said an override keyword (app should be kept open).
 */
export async function warnBeforeClose(
  appName:  string,
  seconds:  number,
  speakFn:  (text: string) => Promise<void>,
): Promise<boolean> {
  const message =
    `Closing ${appName} in ${seconds} seconds. ` +
    `Say "keep it open" or "stop" if you need it.`;
  await speakFn(message);

  const transcript = await transcribe(seconds);
  const lower      = transcript.toLowerCase();
  const overridden = OVERRIDE_KEYWORDS.some(kw => lower.includes(kw));

  if (overridden) {
    console.log(`[EnvControl] override for ${appName}: "${transcript}"`);
    setGracePeriod(appName, 20);
  }

  return overridden;
}

// ── Replacement app lookup ────────────────────────────────────────────────────

export function getReplacementApp(appName: string): string {
  const lower = appName.toLowerCase();
  for (const [fragment, replacement] of DRIFT_VECTOR_MAP.entries()) {
    if (lower.includes(fragment)) return replacement;
  }
  return 'Visual Studio Code';
}

// ── Rotating forward questions ────────────────────────────────────────────────

const FORWARD_QUESTIONS = [
  'Where were you up to with Axon?',
  "What's the one thing that would make today feel like a win?",
  "VS Code's open — what are we building?",
];
let questionIndex = 0;

function nextForwardQuestion(): string {
  const q = FORWARD_QUESTIONS[questionIndex % FORWARD_QUESTIONS.length];
  questionIndex++;
  return q;
}

// ── High-level action (called by interventionDecider) ─────────────────────────

export interface EnvActionResult {
  overridden: boolean;
  question:   string;
}

/**
 * Full environmental intervention:
 * 1. Check safety rules — no-op if unsafe
 * 2. Warn + listen for override
 * 3. If not overridden: close drift app, open + focus VS Code
 * 4. Return { overridden, question } — question is always populated
 *
 * `onOverride` is called when the user explicitly overrides — use it to log.
 */
export async function executeEnvironmentalAction(
  appName:     string,
  warnSecs:    number,
  speakFn:     (text: string) => Promise<void>,
  onOverride?: (appName: string) => void,
): Promise<EnvActionResult> {
  const question = nextForwardQuestion();

  if (!isSafeToTarget(appName)) {
    console.log(`[EnvControl] ${appName} — skipped (safety rules)`);
    return { overridden: false, question };
  }

  const overridden = await warnBeforeClose(appName, warnSecs, speakFn);

  if (overridden) {
    onOverride?.(appName);
    return { overridden: true, question };
  }

  const replacement = getReplacementApp(appName);
  await closeApp(appName);
  await openApp(replacement);
  await focusApp(replacement);

  return { overridden: false, question };
}

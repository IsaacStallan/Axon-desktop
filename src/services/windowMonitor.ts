import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── App classification ────────────────────────────────────────────────────────

const NEGATIVE_APPS = new Set([
  'discord', 'instagram', 'tiktok', 'youtube', 'netflix',
  'steam', 'league of legends', 'twitter', 'reddit', 'twitch',
  'facebook', 'snapchat', 'spotify', 'vlc',
]);

const POSITIVE_APPS = new Set([
  'visual studio code', 'code', 'cursor', 'terminal', 'cmd',
  'powershell', 'windows terminal', 'winword', 'word', 'excel',
  'notion', 'linear', 'figma', 'xcode', 'android studio',
  'webstorm', 'intellij', 'pycharm', 'sublime text', 'vim', 'neovim',
]);

type AppLabel = 'positive' | 'negative' | 'neutral';

function classifyApp(appName: string): AppLabel {
  const lower = appName.toLowerCase();
  if ([...NEGATIVE_APPS].some(n => lower.includes(n))) return 'negative';
  if ([...POSITIVE_APPS].some(p => lower.includes(p))) return 'positive';
  return 'neutral';
}

// ── Active window query ───────────────────────────────────────────────────────
// macOS: osascript returns the frontmost app name.
// Windows: PowerShell returns "processName|windowTitle" sorted by CPU usage.

const MAC_CMD = `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`;

const WIN_CMD =
  'powershell -NoProfile -NonInteractive -Command "' +
  '$p = Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | ' +
  'Sort-Object CPU -Descending | Select-Object -First 1; ' +
  "if ($p) { Write-Output ('{0}|{1}' -f $p.ProcessName, $p.MainWindowTitle) }" +
  '"';

async function getActiveWindow(): Promise<{ processName: string; title: string } | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync(MAC_CMD, { timeout: 5000 });
      const appName = stdout.trim();
      if (!appName) return null;
      return { processName: appName, title: appName };
    }

    const { stdout } = await execAsync(WIN_CMD, { timeout: 5000 });
    const line = stdout.trim();
    if (!line) return null;

    const pipeIdx = line.indexOf('|');
    if (pipeIdx === -1) return { processName: line, title: line };

    return {
      processName: line.slice(0, pipeIdx).trim(),
      title:       line.slice(pipeIdx + 1).trim(),
    };
  } catch {
    return null;
  }
}

// ── Derive a readable app name from process + title ───────────────────────────
// Window titles on Windows typically read "File — App" or just "App".
// We prefer the process name for classification (it's stable) but build a
// human-readable label from the rightmost " - " segment of the title.

function deriveAppName(processName: string, title: string): string {
  // Try to extract the app portion from the window title (rightmost segment)
  const segments = title.split(' - ');
  const titleApp = segments.length > 1 ? segments[segments.length - 1].trim() : '';

  // Prefer a non-trivial title segment; fall back to the process name
  return titleApp.length >= 2 ? titleApp : processName;
}

// ── Session log ───────────────────────────────────────────────────────────────

interface AppEntry {
  name:       string;
  label:      AppLabel;
  startedAt:  number; // epoch ms
  durationMs: number;
}

const sessionLog: AppEntry[] = [];
const TWO_HOURS = 2 * 60 * 60 * 1000;

let currentApp:    string   = 'unknown';
let currentLabel:  AppLabel = 'neutral';
let currentAppStart: number = Date.now();

// ── Accumulated active time tracking ─────────────────────────────────────────
// sessionActiveTimes accumulates total active milliseconds per app across all
// visits within the current day. Reset at midnight or on process restart.

const sessionActiveTimes = new Map<string, number>();
let   lastResetDate      = new Date().toISOString().slice(0, 10);

function checkMidnightReset(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    sessionActiveTimes.clear();
    lastResetDate = today;
    console.log('[WindowMonitor] midnight reset — session active times cleared');
  }
}

/** Total accumulated active time for any named app today, in milliseconds. */
export function getTimeOnApp(appName: string): number {
  const accumulated = sessionActiveTimes.get(appName) ?? 0;
  if (appName === currentApp) {
    return accumulated + (Date.now() - currentAppStart);
  }
  return accumulated;
}

/** Total accumulated active time for the currently focused app, in milliseconds. */
export function getTimeOnCurrentApp(): number {
  return getTimeOnApp(currentApp);
}

// ── Poll ──────────────────────────────────────────────────────────────────────

export function startWindowMonitor(): void {
  poll(); // immediate first sample
  setInterval(poll, 15_000); // 15-second resolution keeps context fresh
}

async function poll(): Promise<void> {
  checkMidnightReset();

  const win = await getActiveWindow();
  if (!win) return;

  // Classify against both process name AND window title for maximum coverage
  const combinedText = `${win.processName} ${win.title}`;
  const label        = classifyApp(combinedText);
  const appName      = deriveAppName(win.processName, win.title);

  if (appName !== currentApp) {
    // Commit the previous entry before switching
    if (currentApp !== 'unknown') {
      const elapsed = Date.now() - currentAppStart;

      sessionLog.push({
        name:       currentApp,
        label:      currentLabel,
        startedAt:  currentAppStart,
        durationMs: elapsed,
      });

      // Accumulate into the per-app active time map
      sessionActiveTimes.set(
        currentApp,
        (sessionActiveTimes.get(currentApp) ?? 0) + elapsed,
      );
    }

    // Trim entries older than 2 hours
    const cutoff = Date.now() - TWO_HOURS;
    while (sessionLog.length > 0 && sessionLog[0].startedAt < cutoff) {
      sessionLog.shift();
    }

    currentApp      = appName;
    currentLabel    = label;
    currentAppStart = Date.now();

    console.log(`[WindowMonitor] ${appName} (${label})`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getCurrentApp(): { name: string; label: AppLabel; durationMins: number; startedAt: number } {
  return {
    name:         currentApp,
    label:        currentLabel,
    durationMins: getTimeOnCurrentApp() / 60_000,  // total accumulated, not just current session
    startedAt:    currentAppStart,
  };
}

export function getActivitySummary(): string {
  const totals = new Map<string, number>();
  for (const entry of sessionLog) {
    totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.durationMs);
  }
  // Include the still-running current app
  totals.set(currentApp, (totals.get(currentApp) ?? 0) + (Date.now() - currentAppStart));

  const sorted = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const parts = sorted.map(([name, ms]) => `${name} ${Math.round(ms / 60_000)}m`);
  return parts.length > 0 ? `Last 2 hrs: ${parts.join(', ')}` : 'No activity recorded yet';
}

export function getProductivityScore(): number {
  let positive = 0;
  let total    = 0;

  for (const entry of sessionLog) {
    total    += entry.durationMs;
    if (entry.label === 'positive') positive += entry.durationMs;
  }
  total += Date.now() - currentAppStart;
  if (currentLabel === 'positive') positive += Date.now() - currentAppStart;

  return total === 0 ? 100 : Math.round((positive / total) * 100);
}

export function getSessionLog(): AppEntry[] {
  return sessionLog;
}

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  systemPreferences,
  session,
  powerMonitor,
  globalShortcut,
} from 'electron';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { autoUpdater } from 'electron-updater';
import { BUILD_CONSTANTS } from './buildConstants';

// Load .env from multiple possible locations.
// In development: project root. In production: next to the app executable.
const envPaths = [
  path.join(process.cwd(), '.env'),
  path.join(app.getPath('exe'), '..', '.env'),
  path.join(app.getPath('exe'), '..', '..', '.env'),
  path.join(app.getPath('exe'), '..', '..', '..', '.env'),
  path.join(app.getPath('userData'), '.env'),
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];

let envLoaded = false;
for (const envPath of envPaths) {
  const result = dotenv.config({ path: envPath });
  if (!result.error) {
    console.log(`[Main] loaded .env from: ${envPath}`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.log('[Main] no .env file found — using environment variables only');
}

// Fallback to Aretica shared keys when user hasn't configured their own.
// Set ARETICA_* at build time to ship a zero-config distribution.
if (!process.env.ANTHROPIC_API_KEY  && process.env.ARETICA_ANTHROPIC_KEY)     process.env.ANTHROPIC_API_KEY  = process.env.ARETICA_ANTHROPIC_KEY;
if (!process.env.ELEVENLABS_API_KEY && process.env.ARETICA_ELEVENLABS_KEY)    process.env.ELEVENLABS_API_KEY = process.env.ARETICA_ELEVENLABS_KEY;
if (!process.env.OPENAI_API_KEY     && process.env.ARETICA_OPENAI_KEY)        process.env.OPENAI_API_KEY     = process.env.ARETICA_OPENAI_KEY;
if (!process.env.SUPABASE_URL       && process.env.ARETICA_SUPABASE_URL)      process.env.SUPABASE_URL       = process.env.ARETICA_SUPABASE_URL;
if (!process.env.SUPABASE_ANON_KEY  && process.env.ARETICA_SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY  = process.env.ARETICA_SUPABASE_ANON_KEY;

// Final fallback: build-time constants compiled in by scripts/inject-env.js
if (!process.env.ANTHROPIC_API_KEY  && BUILD_CONSTANTS.ARETICA_ANTHROPIC_KEY)       process.env.ANTHROPIC_API_KEY  = BUILD_CONSTANTS.ARETICA_ANTHROPIC_KEY;
if (!process.env.ELEVENLABS_API_KEY && BUILD_CONSTANTS.ARETICA_ELEVENLABS_KEY)      process.env.ELEVENLABS_API_KEY = BUILD_CONSTANTS.ARETICA_ELEVENLABS_KEY;
if (!process.env.ELEVENLABS_VOICE_ID && BUILD_CONSTANTS.ARETICA_ELEVENLABS_VOICE_ID) process.env.ELEVENLABS_VOICE_ID = BUILD_CONSTANTS.ARETICA_ELEVENLABS_VOICE_ID;
if (!process.env.SUPABASE_URL       && BUILD_CONSTANTS.ARETICA_SUPABASE_URL)        process.env.SUPABASE_URL       = BUILD_CONSTANTS.ARETICA_SUPABASE_URL;
if (!process.env.SUPABASE_ANON_KEY  && BUILD_CONSTANTS.ARETICA_SUPABASE_ANON_KEY)   process.env.SUPABASE_ANON_KEY  = BUILD_CONSTANTS.ARETICA_SUPABASE_ANON_KEY;

const execAsync = promisify(exec);

console.error('[Main] loading windowMonitor');
const { startWindowMonitor, getActivitySummary, getCurrentApp, getProductivityScore, getSessionLog } = require('./services/windowMonitor');
const { getActiveGoals } = require('./services/goalService');
const { getOpenCommitments } = require('./services/commitmentTracker');
console.error('[Main] loading silentMonitor');
const { startSilentMonitor } = require('./services/silentMonitor');
console.error('[Main] loading decisionEngine');
const { startDecisionLoop, snoozeInterventions, checkMorningBriefingTrigger } = require('./services/decisionEngine');
const { startCognitiveLoop } = require('./services/cognitiveEngine');
const { toggleMute, isMuted } = require('./services/muteControl');
console.error('[Main] loading voiceListener');
const { stopVoiceListener, setOrbWindow, startPersistentWakeWordLoop, stopPersistentWakeWordLoop, isWakeWordLoopRunning, setInConversation } = require('./services/voiceListener');
const { startScreenMonitor, setOrbWindow: setScreenOrbWindow } = require('./services/screenAwareness');
const { startScreenObserver, setOrbWindow: setObserverOrbWindow } = require('./services/screenObserver');
const { startEmotionEngine } = require('./services/emotionEngine');
console.error('[Main] loading conversationService');
const { triggerConversation, stopConversation, setOrbWindow: setConvOrbWindow, handleInterrupt, triggerProactiveConversation } = require('./services/conversationService');
const { setOrbWindow: setTtsOrbWindow, speak: elevenLabsSpeak, getPreferredOutputDevice, prewarmElevenLabs } = require('./services/elevenLabsService');
const { transcribe: whisperTranscribe } = require('./services/whisperService');
console.error('[Main] loading briefingService');
const { startBriefingService } = require('./services/briefingService');
const { setOrbWindow: setSubAgentOrbWindow } = require('./services/subAgentOrchestrator');
const { setOrbWindow: setCodingAgentOrbWindow } = require('./services/codingAgent');
const { getPerformanceStats, getCognitiveStats } = require('./services/behaviourModel');
const { getDailyTotal, getSessionTotal } = require('./services/costTracker');
const { isGmailConnected } = require('./services/gmailService');
const { getAllDeviceStatuses } = require('./services/deviceCoordinator');
const { getClient: getSupabaseClient } = require('./services/cloudSync');
const { pullCollectiveInsights, logCollectiveSetupSQL } = require('./services/collectiveIntelligence');
const { startMDMServer } = require('./services/mdmServer');
const { initTierService, getTier: getTierFromService } = require('./services/tierService');
console.error('[Main] all imports done');

// ── Global error handlers ─────────────────────────────────────────────────────
// Registered as early as possible (first executable lines after imports).
// In TypeScript/ESM, import declarations are syntactically required to precede
// all executable statements, so this is the earliest achievable position.

process.on('uncaughtException', (err) => {
  console.error('[Main] UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] UNHANDLED REJECTION:', reason);
});

// ── Keep single instance ────────────────────────────────────────────────────
// Skip in dev: electron-forge restarts frequently and orphaned dev processes
// silently hold the lock, causing new starts to quit with no output.
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
  console.error('[Main] another instance is already running — quitting');
  app.quit();
}

// ── Globals ─────────────────────────────────────────────────────────────────
let orbWindow:        BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let softlockWindow:   BrowserWindow | null = null;
let tray:             Tray | null = null;
let isConversing  = false;
let updateReady   = false;

declare const ORB_WINDOW_WEBPACK_ENTRY: string;
declare const ORB_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const ONBOARDING_WINDOW_WEBPACK_ENTRY: string;
declare const ONBOARDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const SOFTLOCK_WINDOW_WEBPACK_ENTRY: string;
declare const SOFTLOCK_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// ── Create the floating orb window ──────────────────────────────────────────
function createOrbWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width:           600,
    height:          900,
    minWidth:        500,
    minHeight:       600,
    x:               Math.max(0, width  - 620),
    y:               Math.max(0, height - 920),
    frame:           false,
    transparent:     true,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       true,
    movable:         true,
    hasShadow:       false,
    show:            false,
    webPreferences: {
      preload:          ORB_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  // Forward renderer console messages to main process stdout
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[Renderer]', message);
  });

  let loadAttempts = 0;
  const maxAttempts = 3;
  let showingErrorPage = false;

  const attemptLoad = (): void => {
    loadAttempts++;
    win.loadURL(ORB_WINDOW_WEBPACK_ENTRY);
  };

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (showingErrorPage) return;
    console.error('[Main] renderer failed to load:', errorCode, errorDescription);
    if (loadAttempts < maxAttempts) {
      console.log(`[Main] retrying renderer load (attempt ${loadAttempts + 1}/${maxAttempts})...`);
      setTimeout(attemptLoad, 2000);
      return;
    }
    showingErrorPage = true;
    const html = `<html style="background:#080c10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#00D4FF">Axon failed to start</h2><p style="opacity:0.5">Error ${errorCode}: ${errorDescription}</p><p style="opacity:0.3;font-size:0.8rem">Please reinstall or contact support@aretica.ai</p></div></html>`;
    void win.webContents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] renderer crashed:', details.reason);
  });

  win.once('ready-to-show', () => {
    win.show();
    console.log('[Main] orb window shown via ready-to-show');
  });

  // Fallback — force show after 3 seconds if ready-to-show hasn't fired
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      console.log('[Main] ready-to-show never fired — force showing window');
      win.show();
    }
  }, 3000);

  // Never actually close — just hide
  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  attemptLoad();

  return win;
}

// ── Soft lock window ─────────────────────────────────────────────────────────

function createSoftlockWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    width,
    height,
    x:           0,
    y:           0,
    frame:       false,
    resizable:   false,
    movable:     false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreen:  true,
    show:        false,
    webPreferences: {
      preload:          SOFTLOCK_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.loadURL(SOFTLOCK_WINDOW_WEBPACK_ENTRY);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[SoftlockRenderer]', message);
  });
  return win;
}

// ── System tray ─────────────────────────────────────────────────────────────

function buildTrayMenu(showUpdate = updateReady): void {
  const muted = (isMuted as () => boolean)();
  const menu  = Menu.buildFromTemplate([
    ...(showUpdate ? [{
      label: 'Restart to Update',
      click: () => autoUpdater.quitAndInstall(),
    }, { type: 'separator' as const }] : []),
    {
      label: 'Open Dashboard',
      click: openDashboard,
    },
    { type: 'separator' as const },
    {
      label: 'Snooze Interventions',
      submenu: [
        { label: '30 minutes',  click: () => { (snoozeInterventions as (m: number) => void)(30); } },
        { label: '2 hours',     click: () => { (snoozeInterventions as (m: number) => void)(120); } },
        { label: 'Rest of day', click: () => { (snoozeInterventions as (m: number) => void)(999); } },
      ],
    },
    {
      label: muted ? 'Unmute' : 'Mute',
      click: () => { (toggleMute as () => void)(); buildTrayMenu(); },
    },
    { type: 'separator' as const },
    {
      label: 'Quit Axon',
      click: () => { orbWindow?.removeAllListeners('close'); app.quit(); },
    },
  ]);
  tray?.setContextMenu(menu);
}

function createTray(): Tray {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon     = nativeImage.createFromPath(iconPath);
  const t        = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  t.setToolTip('Axon');
  tray = t;          // assign early so buildTrayMenu() can reference it
  buildTrayMenu();

  t.on('click', openDashboard);

  return t;
}

export function updateTrayState(label: string): void {
  const muted = (isMuted as () => boolean)();
  tray?.setToolTip(`Axon — ${label}${muted ? ' [muted]' : ''}`);
}

// ── Open apps (macOS only) ────────────────────────────────────────────────────

const THIRTY_MINS = 30 * 60_000;

async function getOpenApps(): Promise<Array<{ name: string; lastUsed: number; isActive: boolean }>> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`,
      { timeout: 5_000 },
    );
    const names     = stdout.trim().split(', ').map(n => n.trim()).filter(Boolean);
    const log       = getSessionLog() as Array<{ name: string; startedAt: number }>;
    const recentSet = new Set(
      log.filter(e => Date.now() - e.startedAt < THIRTY_MINS).map(e => e.name.toLowerCase()),
    );
    const cur = (getCurrentApp() as { name: string }).name.toLowerCase();
    recentSet.add(cur);

    return names.map(name => ({
      name,
      lastUsed: Date.now(),
      isActive: recentSet.has(name.toLowerCase()),
    }));
  } catch {
    return [];
  }
}

// ── Dashboard open helper ────────────────────────────────────────────────────
// Ensures the orb window is visible even if it was somehow destroyed.

function openDashboard(): void {
  if (!orbWindow || orbWindow.isDestroyed()) {
    orbWindow = createOrbWindow();
    setOrbWindow(orbWindow);
    setConvOrbWindow(orbWindow);
    setTtsOrbWindow(orbWindow);
    setSubAgentOrbWindow(orbWindow);
    setCodingAgentOrbWindow(orbWindow);
    setScreenOrbWindow(orbWindow);
    setObserverOrbWindow(orbWindow);
    orbWindow.show();
  } else {
    orbWindow.show();
    orbWindow.focus();
  }
}

// ── Broadcast orb state to renderer ─────────────────────────────────────────

const ACTIVITY_LABELS: Record<string, string> = {
  idle:      'Monitoring your activity',
  listening: 'Listening for your response',
  thinking:  'Thinking…',
  speaking:  'Speaking',
  urgent:    'Urgent alert',
};

let listeningStateEnteredAt: number | null = null;

export function setOrbState(state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent'): void {
  if (state === 'listening') {
    if (!listeningStateEnteredAt) listeningStateEnteredAt = Date.now();
  } else {
    listeningStateEnteredAt = null;
  }
  orbWindow?.webContents.send('orb:state', state);
  orbWindow?.webContents.send('axon:activity', ACTIVITY_LABELS[state] ?? state);
  updateTrayState(ACTIVITY_LABELS[state] ?? state);
}

// ── Stats payload for the Command Center UI ──────────────────────────────────
async function sendStats(): Promise<void> {
  if (!orbWindow || orbWindow.isDestroyed()) return;

  const today  = new Date().toISOString().slice(0, 10);
  const log    = getSessionLog() as Array<{ label: string; durationMs: number; startedAt: number }>;

  const focusMin = Math.round(
    log.filter(e => e.label === 'positive').reduce((s, e) => s + e.durationMs, 0) / 60_000,
  );
  const driftMin = Math.round(
    log.filter(e => e.label === 'negative').reduce((s, e) => s + e.durationMs, 0) / 60_000,
  );

  // Screen time: all entries from today, plus current running session
  const screenTimeMins = Math.round(
    log
      .filter(e => new Date(e.startedAt).toISOString().startsWith(today))
      .reduce((s, e) => s + e.durationMs, 0) / 60_000,
  ) + Math.round((getCurrentApp() as { durationMins: number }).durationMins);

  const priorities = (getActiveGoals() as Array<{ text: string; impactScore: number; status: string; progress: number }>)
    .filter(g => g.status === 'active')
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 3)
    .map(g => ({ text: g.text, impactScore: g.impactScore, progress: g.progress ?? 0 }));

  const commitments = (getOpenCommitments() as Array<{ text: string }>)
    .slice(0, 4)
    .map(c => c.text);

  const openApps    = await getOpenApps();
  const performance = getPerformanceStats();
  const capacity    = {
    ...getCognitiveStats(screenTimeMins),
    todayCost:   getDailyTotal()   as number,
    sessionCost: getSessionTotal() as number,
  };

  // Capabilities status
  const gmailConnected = isGmailConnected() as boolean;
  const allDevices     = await getAllDeviceStatuses().catch(() => []) as Array<{ platform: string; lastSeen: Date }>;
  const pcMonitorActive = allDevices.some(
    (d) => d.platform === 'windows' && (Date.now() - new Date(d.lastSeen).getTime()) < 5 * 60_000,
  );

  orbWindow.webContents.send('axon:stats', {
    focusMin,
    driftMin,
    priorities,
    commitments,
    openApps,
    performance,
    capacity,
    capabilities: { gmailConnected, pcMonitorActive },
  });
}

// ── Wake-word → conversation lifecycle ──────────────────────────────────────
// The voice listener and conversation loop both call SoX to record from the
// mic.  Running them simultaneously splits the audio stream and produces
// fragmented, echoed transcripts.  The fix: stop the listener before the
// conversation starts and restart it cleanly after the conversation ends.

function beginConversation(): void {
  if (isConversing) return;
  isConversing = true;
  setOrbState('listening');
  console.log('[Main] conversation started');

  triggerConversation().finally(() => {
    isConversing = false;
    // orb state + setInConversation(false) handled by triggerConversation's own finally
    console.log('[Main] conversation ended — persistent wake word loop will resume');
  });
}

function startWakeWordListener(): void {
  void (startPersistentWakeWordLoop as Function)(() => beginConversation(), setOrbState);
}

// ── Onboarding window ────────────────────────────────────────────────────────

function createOnboardingWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width:     800,
    height:    600,
    x:         Math.round((width  - 800) / 2),
    y:         Math.round((height - 600) / 2),
    frame:           false,
    resizable:       false,
    show:            true,
    backgroundColor: '#080c10',
    webPreferences: {
      preload:          ONBOARDING_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[OnboardingRenderer] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Onboarding] failed to load:', errorCode, errorDescription);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Onboarding] renderer crashed:', details.reason, details.exitCode);
  });

  win.loadURL(ONBOARDING_WINDOW_WEBPACK_ENTRY);

  return win;
}

// ── Onboarding IPC handlers ───────────────────────────────────────────────────

ipcMain.handle('permissions:screen', () =>
  systemPreferences.getMediaAccessStatus('screen'),
);

ipcMain.handle('permissions:accessibility', () =>
  systemPreferences.isTrustedAccessibilityClient(false),
);

ipcMain.handle('permissions:requestAccessibility', () =>
  systemPreferences.isTrustedAccessibilityClient(true),
);

ipcMain.handle('onboarding:speak', async (_e, text: string) => {
  try {
    await (elevenLabsSpeak as (t: string) => Promise<void>)(text);
  } catch (e) {
    console.warn('[Onboarding] TTS error:', e);
  }
});

ipcMain.handle('onboarding:listen', async (_e, secs: number) => {
  try {
    return await (whisperTranscribe as (s: number) => Promise<string>)(secs ?? 12);
  } catch (e) {
    console.warn('[Onboarding] transcribe error:', e);
    return '';
  }
});

ipcMain.handle('onboarding:saveAnswers', (_e, answers: unknown) => {
  try {
    writeFileSync(
      path.join(app.getPath('userData'), 'onboarding-answers.json'),
      JSON.stringify(answers, null, 2), 'utf8',
    );
  } catch (e) {
    console.warn('[Onboarding] saveAnswers error:', e);
  }
});

ipcMain.handle('onboarding:complete', () => {
  try {
    writeFileSync(
      path.join(app.getPath('userData'), 'onboarding-complete.json'),
      JSON.stringify({ completedAt: new Date().toISOString() }), 'utf8',
    );
  } catch (e) {
    console.warn('[Onboarding] could not write completion marker:', e);
  }
  onboardingWindow?.destroy();
  onboardingWindow = null;
  console.log('[Main] startFullAxon called from:', new Error().stack?.split('\n')[2]);
  startFullAxon();
});

// ── electronAPI IPC handlers (new onboarding flow) ───────────────────────────

ipcMain.handle('request-accessibility', () =>
  systemPreferences.isTrustedAccessibilityClient(true),
);

ipcMain.handle('onboarding-speak', async (_e, text: string) => {
  try {
    await (elevenLabsSpeak as (t: string) => Promise<void>)(text);
  } catch (e) {
    console.warn('[Onboarding] TTS error:', e);
  }
});

ipcMain.handle('complete-onboarding', () => {
  try {
    writeFileSync(
      path.join(app.getPath('userData'), 'onboarding-complete.json'),
      JSON.stringify({ completedAt: new Date().toISOString() }), 'utf8',
    );
  } catch (e) {
    console.warn('[Onboarding] could not write completion marker:', e);
  }
  onboardingWindow?.destroy();
  onboardingWindow = null;
  console.log('[Main] startFullAxon called from:', new Error().stack?.split('\n')[2]);
  startFullAxon();
});

export function notifyOnboardingWakeWord(): void {
  onboardingWindow?.webContents.send('wake-word-detected');
}

// ── IPC: renderer signals ───────────────────────────────────────────────────
ipcMain.on('axon:interrupt', () => {
  console.log('[Main] interrupt triggered via UI');
  (handleInterrupt as () => void)();
});

ipcMain.on('orb:tap', () => {
  console.log('[Main] orb tapped');
  if (isConversing) {
    // Tap while talking → end conversation; persistent loop resumes when
    // triggerConversation's finally block calls setInConversation(false).
    stopConversation();
    isConversing = false;
    setOrbState('idle');
  } else {
    beginConversation();
  }
});

ipcMain.on('orb:ready', () => {
  console.log('[Main] orb renderer ready');
  setOrbState('idle');
});

ipcMain.on('orb:minimise', () => {
  orbWindow?.minimize();
});

ipcMain.on('orb:to-pill', () => {
  if (!orbWindow) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  orbWindow.setSize(320, 48);
  orbWindow.setPosition(Math.max(0, width - 340), Math.max(0, height - 68));
});

ipcMain.on('orb:from-pill', () => {
  if (!orbWindow) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  orbWindow.setSize(600, 900);
  orbWindow.setPosition(Math.max(0, width - 620), Math.max(0, height - 920));
});

// ── Second-instance focus (production only) ──────────────────────────────────
app.on('second-instance', () => {
  console.error('[Main] second instance launched — focusing existing window');
  if (orbWindow) {
    if (!orbWindow.isVisible()) orbWindow.show();
    orbWindow.focus();
  }
});

// ── Soft lock IPC handlers ────────────────────────────────────────────────────

ipcMain.handle('softlock:going', async () => {
  const { deactivateSoftLock } = require('./services/softLockService');
  await deactivateSoftLock();
  // Give a moment for windows to restore, then start a check-in conversation
  setTimeout(() => {
    if (!isConversing) beginConversation();
  }, 2000);
});

ipcMain.handle('softlock:override', async () => {
  try {
    await (elevenLabsSpeak as (t: string) => Promise<void>)(
      'Say "override" to unlock your computer.',
    );
    const transcript = await (whisperTranscribe as (s: number) => Promise<string>)(8);
    const confirmed  = /\boverride\b/i.test(transcript);
    if (confirmed) {
      const { logSoftLockOverride, deactivateSoftLock } = require('./services/softLockService');
      logSoftLockOverride();
      await deactivateSoftLock();
      return 'override_confirmed';
    }
    return 'override_denied';
  } catch (e) {
    console.warn('[SoftLock] override IPC error:', e);
    return 'override_denied';
  }
});

// ── Supabase table verification ───────────────────────────────────────────────

async function verifySupabaseTables(): Promise<void> {
  try {
    const supabase = (getSupabaseClient as () => import('@supabase/supabase-js').SupabaseClient | null)();
    if (!supabase) {
      console.log('[Main] Supabase not configured — skipping phone_activity table check');
      return;
    }
    const { error } = await supabase
      .from('phone_activity')
      .select('id')
      .limit(1);
    if (error) {
      console.error('[Main] phone_activity table missing — run SQL setup');
      console.error('[Main] SQL: create table phone_activity (id uuid default gen_random_uuid() primary key, user_id text, app_name text, timestamp timestamptz default now(), device text default \'iphone\');');
    } else {
      console.log('[Main] phone_activity table verified');
    }
  } catch (err) {
    console.error('[Main] Supabase table check failed:', err);
  }
}

// ── Config validation ─────────────────────────────────────────────────────────

function checkRequiredConfig(): boolean {
  const required = [
    'ANTHROPIC_API_KEY',
    'ELEVENLABS_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('[Main] missing required config:', missing);
    return false;
  }
  return true;
}

// ── Full Axon startup ─────────────────────────────────────────────────────────
// Called either directly from ready (if onboarding already done)
// or from the onboarding:complete IPC handler.

function startFullAxon(): void {
  try {
    if (!checkRequiredConfig()) {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      const errWin = new BrowserWindow({
        width: 500, height: 300,
        x: Math.round((width - 500) / 2),
        y: Math.round((height - 300) / 2),
        frame: false,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      const missing = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']
        .filter(k => !process.env[k]).join(', ');
      const html = `<html style="background:#080c10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:24px"><h2 style="color:#00D4FF">Axon configuration error</h2><p style="opacity:0.7">Missing required config: ${missing}</p><p style="opacity:0.3;font-size:0.8rem">Add these to your .env file and restart. Contact support@aretica.ai for help.</p></div></html>`;
      void errWin.webContents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
      if (!tray) tray = createTray();
      return;
    }

    console.log('[Main] creating orb window');
    orbWindow = createOrbWindow();
    setOrbWindow(orbWindow);
    setConvOrbWindow(orbWindow);
    setTtsOrbWindow(orbWindow);
    setSubAgentOrbWindow(orbWindow);
    setCodingAgentOrbWindow(orbWindow);
    setScreenOrbWindow(orbWindow);
    setObserverOrbWindow(orbWindow);
    setTimeout(() => sendStats(), 4000);
    setInterval(sendStats, 30_000);
    if (!tray) tray = createTray();
    // Wire soft lock callbacks
    const { setSoftLockCallbacks } = require('./services/softLockService');
    let pendingSoftLockReason = '';
    setSoftLockCallbacks(
      (state: { reason: string; startTime: string; endTime: string; canOverride: boolean; overrideUsed: boolean }) => {
        // onActivate — show the soft lock window
        pendingSoftLockReason = state.reason;
        if (!softlockWindow || softlockWindow.isDestroyed()) {
          softlockWindow = createSoftlockWindow();
        }
        softlockWindow.show();
        // Send state to renderer once it's ready
        softlockWindow.webContents.once('did-finish-load', () => {
          softlockWindow?.webContents.send('softlock:state', state);
        });
        // If already loaded, send immediately too
        softlockWindow.webContents.send('softlock:state', state);
        console.log('[Main] soft lock window shown');
      },
      () => {
        // onDeactivate — hide and destroy the soft lock window
        if (softlockWindow && !softlockWindow.isDestroyed()) {
          softlockWindow.destroy();
          softlockWindow = null;
        }
        console.log('[Main] soft lock window closed');
        // Ensure wake word loop is still running after soft lock
        if (!(isWakeWordLoopRunning as () => boolean)()) {
          console.log('[Main] restarting wake word loop after soft lock deactivation');
          startWakeWordListener();
        } else {
          // Loop is running but mic may have been interrupted — restart mic session
          console.log('[Main] soft lock ended — ensuring mic session active');
          orbWindow?.webContents.send('mic:start');
        }
        setTimeout(() => {
          const reason = pendingSoftLockReason || 'your session';
          void (triggerProactiveConversation as (p: string) => Promise<void>)(
            `The soft lock for "${reason}" just ended. Isaac has returned. Ask him briefly and directly how it went — one short question. "How was the ${reason.toLowerCase()}?" Nothing more. Wait for his answer.`,
          );
        }, 3000);
      },
    );

    void (initTierService as () => Promise<void>)().then(() => {
      console.log(`[Main] user tier: ${(getTierFromService as () => string)()}`);
    });
    void (prewarmElevenLabs as () => Promise<void>)();
    startWindowMonitor();
    void verifySupabaseTables();
    void (pullCollectiveInsights as () => Promise<void>)();       // pull anonymised insights, log SQL if tables missing
    (logCollectiveSetupSQL as () => void)();
    startDecisionLoop(beginConversation);   // setup: seeding, cloud sync, heartbeat, weekly review
    void (startCognitiveLoop as (fn: () => void) => Promise<void>)(beginConversation);
    startBriefingService(beginConversation);
    startScreenMonitor();
    startScreenObserver();
    startEmotionEngine();
    startWakeWordListener();

    // Watchdog: verify the persistent wake word loop is still running every 60s.
    setInterval(() => {
      if (!(isWakeWordLoopRunning as () => boolean)()) {
        console.error('[Watchdog] wake word loop died — restarting');
        startWakeWordListener();
      }
    }, 60_000);

    // Secondary watchdog: if orb is stuck in "listening" state >45s, reset it.
    setInterval(() => {
      if (listeningStateEnteredAt && Date.now() - listeningStateEnteredAt > 45_000) {
        console.log('[Watchdog] stuck in listening state >45s — resetting orb');
        listeningStateEnteredAt = null;
        orbWindow?.webContents.send('orb:state', 'idle');
      }
    }, 30_000);

    globalShortcut.register('CommandOrControl+Shift+A', () => {
      console.log('[Main] hotkey activated'); beginConversation();
    });
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      console.log('[Main] interrupt hotkey fired');
      (handleInterrupt as () => void)();
    });

    powerMonitor.on('suspend', () => {
      console.log('[Main] system suspending — pausing mic');
      orbWindow?.webContents.send('mic:stop');
    });
    powerMonitor.on('resume', async () => {
      console.log('[Main] system resumed from sleep — restarting mic');
      await new Promise(r => setTimeout(r, 2000));
      orbWindow?.webContents.send('mic:restart');
      if (!(isWakeWordLoopRunning as () => boolean)()) {
        console.log('[Main] wake word loop was dead — restarting');
        startWakeWordListener();
      }
      // Check morning briefing on lid open (fire-and-forget, guard inside)
      setTimeout(() => {
        void (checkMorningBriefingTrigger as () => Promise<void>)();
      }, 3000);
    });

    const AXON_CORE_MODE = process.env.AXON_CORE_MODE === 'true';

    if (AXON_CORE_MODE) {
      console.log('[Main] Axon Core mode enabled — personal instance features active');

      // MDM server — receives iPhone check-ins for presence detection
      (startMDMServer as () => void)();

      // AirPods connect detection — greet Isaac when he puts them on
      let lastOutputDevice = (getPreferredOutputDevice as () => string)();
      setInterval(() => {
        const current = (getPreferredOutputDevice as () => string)();
        if (current === 'airpods' && lastOutputDevice !== 'airpods') {
          setTimeout(() => {
            void (elevenLabsSpeak as (text: string) => Promise<void>)("You're up.");
          }, 2000);
        }
        lastOutputDevice = current;
      }, 30_000);

      if (process.env.HOME_ASSISTANT_URL) {
        console.log('[Main] Home Assistant configured — speaker broadcast enabled');
      }
    } else {
      console.log('[Main] Standard mode — personal features disabled');
    }

    console.log('[Main] Axon desktop started');
  } catch (err) {
    console.error('[Main] startFullAxon error:', err);
  }
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.on('ready', () => {
  try {
    console.log('[Main] app ready');
    console.log('[Main] process.arch:', process.arch);
    console.log('[Main] process.platform:', process.platform);
    app.dock?.hide();
    app.setLoginItemSettings({ openAtLogin: true });

    // Grant media permissions to all renderer windows
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });

    // ── Monitor-only mode ──────────────────────────────────────────────────
    if (process.env.DEVICE_ROLE === 'monitor') {
      tray = createTray();
      startSilentMonitor();
      console.log('[Main] running in monitor mode');
      return;
    }

    // Request mic access from macOS
    if (process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then((granted: boolean) => {
        if (!granted) console.error('[Main] Microphone access denied by macOS');
        else          console.log('[Main] Microphone access granted');
      });
    }

    tray = createTray();

    // ── First-launch check ─────────────────────────────────────────────────
    const onboardingDonePath = path.join(app.getPath('userData'), 'onboarding-complete.json');
    if (!existsSync(onboardingDonePath)) {
      console.log('[Main] first launch — showing onboarding');
      onboardingWindow = createOnboardingWindow();
      // startFullAxon() is called by the onboarding:complete IPC handler
      return;
    }

    console.log('[Main] startFullAxon called from:', new Error().stack?.split('\n')[2]);
    startFullAxon();
  } catch (err) {
    console.error('[Main] STARTUP ERROR in ready handler:', err);
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray — never quit unless Tray > Quit.
  // On Windows/Linux, Electron only auto-quits if this handler
  // calls app.quit(). By not calling it, the process stays alive.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ── Auto-updater (production only) ───────────────────────────────────────────
// Only runs when the app is packaged — skipped during `npm start`.

if (app.isPackaged) {
  autoUpdater.checkForUpdatesAndNotify();

  // Poll every 4 hours
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);

  autoUpdater.on('update-available', () => {
    tray?.setToolTip('Axon — Update downloading...');
    console.log('[Updater] update available — downloading');
  });

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    tray?.setToolTip('Axon — Update ready');
    console.log('[Updater] update downloaded — will install on next restart');
    buildTrayMenu(true);
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err);
  });
}

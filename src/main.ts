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
import * as dotenv from 'dotenv';
dotenv.config();

const execAsync = promisify(exec);

console.error('[Main] loading windowMonitor');
const { startWindowMonitor, getActivitySummary, getCurrentApp, getProductivityScore, getSessionLog } = require('./services/windowMonitor');
const { getActiveGoals } = require('./services/goalService');
const { getOpenCommitments } = require('./services/commitmentTracker');
console.error('[Main] loading silentMonitor');
const { startSilentMonitor } = require('./services/silentMonitor');
console.error('[Main] loading decisionEngine');
const { startDecisionLoop, snoozeInterventions } = require('./services/decisionEngine');
const { toggleMute, isMuted } = require('./services/muteControl');
console.error('[Main] loading voiceListener');
const { startVoiceListener, stopVoiceListener, setOrbWindow } = require('./services/voiceListener');
const { startScreenMonitor, setOrbWindow: setScreenOrbWindow } = require('./services/screenAwareness');
const { startScreenObserver, setOrbWindow: setObserverOrbWindow } = require('./services/screenObserver');
const { startEmotionEngine } = require('./services/emotionEngine');
console.error('[Main] loading conversationService');
const { triggerConversation, stopConversation, setOrbWindow: setConvOrbWindow, handleInterrupt } = require('./services/conversationService');
const { setOrbWindow: setTtsOrbWindow } = require('./services/elevenLabsService');
console.error('[Main] loading briefingService');
const { startBriefingService } = require('./services/briefingService');
const { setOrbWindow: setSubAgentOrbWindow } = require('./services/subAgentOrchestrator');
const { setOrbWindow: setCodingAgentOrbWindow } = require('./services/codingAgent');
const { getPerformanceStats, getCognitiveStats } = require('./services/behaviourModel');
const { getDailyTotal, getSessionTotal } = require('./services/costTracker');
const { isGmailConnected } = require('./services/gmailService');
const { getAllDeviceStatuses } = require('./services/deviceCoordinator');
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
let orbWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isConversing = false;

declare const ORB_WINDOW_WEBPACK_ENTRY: string;
declare const ORB_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

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

  win.loadURL(ORB_WINDOW_WEBPACK_ENTRY);
  win.setAlwaysOnTop(true, 'screen-saver');

  // Forward renderer console messages to main process stdout
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[Renderer]', message);
  });

  // Never actually close — just hide
  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  return win;
}

// ── System tray ─────────────────────────────────────────────────────────────

function buildTrayMenu(): void {
  const muted = (isMuted as () => boolean)();
  const menu  = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => { orbWindow?.show(); orbWindow?.focus(); },
    },
    { type: 'separator' },
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
    { type: 'separator' },
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

  t.on('click', () => {
    if (orbWindow?.isVisible()) {
      orbWindow.focus();
    } else {
      orbWindow?.show();
      orbWindow?.focus();
    }
  });

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

// ── Broadcast orb state to renderer ─────────────────────────────────────────

const ACTIVITY_LABELS: Record<string, string> = {
  idle:      'Monitoring your activity',
  listening: 'Listening for your response',
  thinking:  'Thinking…',
  speaking:  'Speaking',
  urgent:    'Urgent alert',
};

export function setOrbState(state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent'): void {
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
  stopVoiceListener();          // silence the wake-word loop first
  setOrbState('listening');
  console.log('[Main] conversation started');

  triggerConversation().finally(() => {
    isConversing = false;
    setOrbState('idle');
    console.log('[Main] conversation ended — restarting wake-word listener');
    startWakeWordListener();    // resume listening for the next wake word
  });
}

function startWakeWordListener(): void {
  startVoiceListener(
    () => beginConversation(),  // called when "hey axon" is detected
    setOrbState,
  );
}

// ── IPC: renderer signals ───────────────────────────────────────────────────
ipcMain.on('axon:interrupt', () => {
  console.log('[Main] interrupt triggered via UI');
  (handleInterrupt as () => void)();
});

ipcMain.on('orb:tap', () => {
  console.log('[Main] orb tapped');
  if (isConversing) {
    // Tap while talking → end conversation, restart wake-word listener
    stopConversation();
    isConversing = false;
    setOrbState('idle');
    startWakeWordListener();
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

// ── App lifecycle ────────────────────────────────────────────────────────────
app.on('ready', () => {
  try {
    console.log('[Main] app ready');
    app.dock?.hide(); // macOS — no dock icon
    app.setLoginItemSettings({ openAtLogin: true });

    // ── Monitor-only mode ──────────────────────────────────────────────────
    // DEVICE_ROLE=monitor: run windowMonitor + Supabase heartbeat only.
    // No orb window, no voice, no conversation pipeline.
    if (process.env.DEVICE_ROLE === 'monitor') {
      tray = createTray();  // tray keeps the process alive and allows quit
      startSilentMonitor();
      console.log('[Main] running in monitor mode');
      return;
    }

    // ── Full Axon mode (default) ───────────────────────────────────────────

    if (process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then((granted: boolean) => {
        if (!granted) {
          console.error('[Main] Microphone access denied by macOS');
        } else {
          console.log('[Main] Microphone access granted');
        }
      });
    }

    // Grant microphone (and camera) permissions to the renderer automatically.
    // Without this, Electron's internal permission system blocks getUserMedia
    // in the renderer even when macOS has already granted system-level access.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'media') {
        console.log('[Main] granting media permission to renderer');
        callback(true);
      } else {
        callback(false);
      }
    });

    console.log('[Main] creating orb window');
    orbWindow = createOrbWindow();
    console.log('[Main] orb window created');
    setOrbWindow(orbWindow);
    setConvOrbWindow(orbWindow);
    setTtsOrbWindow(orbWindow);
    setSubAgentOrbWindow(orbWindow);
    setCodingAgentOrbWindow(orbWindow);
    setScreenOrbWindow(orbWindow);
    setObserverOrbWindow(orbWindow);
    // Send initial stats once renderer has loaded, then every 30 s
    setTimeout(() => sendStats(), 4000);
    setInterval(sendStats, 30_000);
    console.log('[Main] creating tray');
    tray      = createTray();
    console.log('[Main] tray created');
    console.log('[Main] starting window monitor');
    startWindowMonitor();
    console.log('[Main] starting decision loop');
    startDecisionLoop(beginConversation);
    console.log('[Main] starting briefing service');
    startBriefingService(beginConversation);
    console.log('[Main] starting screen monitor');
    startScreenMonitor();
    console.log('[Main] starting screen observer');
    startScreenObserver();
    console.log('[Main] starting emotion engine');
    startEmotionEngine();
    console.log('[Main] starting wake-word listener');
    startWakeWordListener();

    // Global hotkey — Cmd+Shift+A triggers conversation same as wake word
    const hotkeyRegistered = globalShortcut.register('CommandOrControl+Shift+A', () => {
      console.log('[Main] hotkey activated');
      beginConversation();
    });
    if (!hotkeyRegistered) {
      console.warn('[Main] globalShortcut CommandOrControl+Shift+A could not be registered');
    }

    // Global hotkey — Cmd+Shift+I interrupts current TTS playback
    const interruptRegistered = globalShortcut.register('CommandOrControl+Shift+I', () => {
      console.log('[Main] interrupt hotkey fired');
      (handleInterrupt as () => void)();
    });
    if (!interruptRegistered) {
      console.warn('[Main] globalShortcut CommandOrControl+Shift+I could not be registered');
    }

    // ── Sleep / wake handling ────────────────────────────────────────────────
    // On suspend: stop the voice listener so the WebSocket and AudioContext are
    // cleanly torn down before the system sleeps.
    // On resume: wait 3 s for the audio device to become available again, then
    // restart — but only if a conversation isn't already in progress.
    powerMonitor.on('suspend', () => {
      console.log('[Main] system suspending — stopping voice listener');
      stopVoiceListener();
    });

    powerMonitor.on('resume', () => {
      console.log('[Main] system resumed — restarting voice listener in 5 s');
      setTimeout(() => {
        if (!isConversing) {
          console.log('[Main] restarting wake-word listener after wake');
          startWakeWordListener();
        }
      }, 5000);
    });

    console.log('[Main] Axon desktop started');
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

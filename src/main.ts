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
} from 'electron';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

console.error('[Main] loading windowMonitor');
const { startWindowMonitor, getActivitySummary, getCurrentApp, getProductivityScore } = require('./services/windowMonitor');
console.error('[Main] loading silentMonitor');
const { startSilentMonitor } = require('./services/silentMonitor');
console.error('[Main] loading decisionEngine');
const { startDecisionLoop } = require('./services/decisionEngine');
console.error('[Main] loading voiceListener');
const { startVoiceListener, stopVoiceListener, setOrbWindow } = require('./services/voiceListener');
console.error('[Main] loading conversationService');
const { triggerConversation, stopConversation } = require('./services/conversationService');
console.error('[Main] loading briefingService');
const { startBriefingService } = require('./services/briefingService');
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
    width:           120,
    height:          120,
    x:               width  - 140,
    y:               height - 140,
    frame:           false,
    transparent:     true,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       false,
    movable:         true,
    hasShadow:       false,
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
function createTray(): Tray {
  // 16x16 purple circle as tray icon (base64 PNG)
  const icon = nativeImage.createEmpty();
  const t = new Tray(icon);

  t.setToolTip('Axon');
  t.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Axon',
        click: () => {
          orbWindow?.show();
          orbWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          orbWindow?.removeAllListeners('close');
          app.quit();
        },
      },
    ])
  );

  t.on('click', () => {
    if (orbWindow?.isVisible()) {
      orbWindow.focus();
    } else {
      orbWindow?.show();
    }
  });

  return t;
}

// ── Broadcast orb state to renderer ─────────────────────────────────────────
export function setOrbState(state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent'): void {
  orbWindow?.webContents.send('orb:state', state);
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
    console.log('[Main] creating tray');
    tray      = createTray();
    console.log('[Main] tray created');
    console.log('[Main] starting window monitor');
    startWindowMonitor();
    console.log('[Main] starting decision loop');
    startDecisionLoop(beginConversation);
    console.log('[Main] starting briefing service');
    startBriefingService(beginConversation);
    console.log('[Main] starting wake-word listener');
    startWakeWordListener();

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
      console.log('[Main] system resumed — restarting voice listener in 3 s');
      setTimeout(() => {
        if (!isConversing) {
          console.log('[Main] restarting wake-word listener after wake');
          startWakeWordListener();
        }
      }, 3000);
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

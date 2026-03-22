import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
} from 'electron';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

import { startWindowMonitor, getActivitySummary, getCurrentApp, getProductivityScore } from './services/windowMonitor';
import { startDecisionLoop } from './services/decisionEngine';
import { startVoiceListener, stopVoiceListener } from './services/voiceListener';
import { triggerConversation, stopConversation } from './services/conversationService';

// ── Keep single instance ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

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

// ── App lifecycle ────────────────────────────────────────────────────────────
app.on('ready', () => {
  app.dock?.hide(); // macOS — no dock icon

  orbWindow = createOrbWindow();
  tray      = createTray();

  // Start background services
  startWindowMonitor();
  startDecisionLoop(setOrbState);
  startWakeWordListener();

  console.log('[Main] Axon desktop started');
});

app.on('window-all-closed', () => {
  // Keep running in tray — never quit unless Tray > Quit.
  // On Windows/Linux, Electron only auto-quits if this handler
  // calls app.quit(). By not calling it, the process stays alive.
});

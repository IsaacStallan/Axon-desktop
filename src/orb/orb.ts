// `export {}` makes this a module so `declare global` augmentations are legal.
export {};

declare global {
  interface Window {
    axon: {
      onStateChange:    (cb: (state: string) => void) => void;
      onMessage:        (cb: (msg: string) => void) => void;
      onStats:          (cb: (data: unknown) => void) => void;
      onLog:            (cb: (data: unknown) => void) => void;
      onNotification:   (cb: (data: unknown) => void) => void;
      onActivityUpdate: (cb: (activity: string) => void) => void;
      tapOrb:           () => void;
      ready:            () => void;
      interruptAxon:    () => void;
      minimiseWindow:   () => void;
      toPill:           () => void;
      fromPill:         () => void;
      onMicStart:       (cb: () => void) => void;
      onMicStop:        (cb: () => void) => void;
      onMicRestart:     (cb: () => void) => void;
      sendMicChunk:     (chunk: Uint8Array) => void;
      sendMicError:     (msg: string) => void;
      sendMicReady:     () => void;
      sendMicDied:      () => void;
    };
  }
}

interface OrbStats {
  focusMin:      number;
  driftScore:    number;
  streakDays:    number;
  interventions: number;
  activeGoal:    string;
  currentApp:    string;
  todayCost:     number;
}

interface LogEntry {
  time:    string;
  type:    string;
  message: string;
}

interface OrbNotification {
  message: string;
  type:    'info' | 'urgent';
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentState = 'idle';

// ── Clock ─────────────────────────────────────────────────────────────────────

function updateClock(): void {
  const now = new Date();
  const h   = now.getHours().toString().padStart(2, '0');
  const m   = now.getMinutes().toString().padStart(2, '0');
  const s   = now.getSeconds().toString().padStart(2, '0');
  const el  = document.getElementById('clock');
  if (el) el.textContent = `${h}:${m}:${s}`;
}
setInterval(updateClock, 1000);
updateClock();

// ── State changes ─────────────────────────────────────────────────────────────

const STATE_LABELS: Record<string, string> = {
  idle:      'IDLE',
  listening: 'LISTENING',
  thinking:  'THINKING',
  speaking:  'SPEAKING',
  urgent:    'URGENT',
};

window.axon.onStateChange((state: string) => {
  currentState            = state;
  document.body.className = state;

  const statusText = document.getElementById('status-text');
  if (statusText) statusText.textContent = STATE_LABELS[state] ?? state.toUpperCase();

  const dotColors: Record<string, string> = {
    idle: '#333333', listening: '#00D4FF',
    thinking: '#FFFFFF', speaking: '#00FFAA', urgent: '#FF4444',
  };
  const miniDot = document.getElementById('mini-status-dot');
  if (miniDot) miniDot.style.background = dotColors[state] ?? '#333333';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats(stats: OrbStats): void {
  const pct        = Math.min(100, Math.round(stats.focusMin / 4.8));
  const focusMinEl = document.getElementById('stat-focus-min');
  if (focusMinEl) focusMinEl.textContent = `${stats.focusMin}m focus`;

  const bar = document.getElementById('focus-bar-fill') as HTMLElement | null;
  if (bar) bar.style.width = `${pct}%`;

  const driftEl = document.getElementById('stat-drift');
  if (driftEl) driftEl.textContent = `${stats.driftScore}%`;

  const streakEl = document.getElementById('stat-streak');
  if (streakEl) streakEl.textContent = `${stats.streakDays}d`;

  const nudgesEl = document.getElementById('stat-nudges');
  if (nudgesEl) nudgesEl.textContent = `${stats.interventions}`;

  const goalEl = document.getElementById('active-goal-text');
  if (goalEl) goalEl.textContent = stats.activeGoal || '—';

  const appEl = document.getElementById('current-app');
  if (appEl) appEl.textContent = stats.currentApp || '—';
}

window.axon.onStats((data: unknown) => {
  updateStats(data as OrbStats);
});

// ── Activity updates ──────────────────────────────────────────────────────────

window.axon.onActivityUpdate((activity: string) => {
  const el = document.getElementById('axon-activity');
  if (el) el.textContent = activity;
});

// ── Log entries ───────────────────────────────────────────────────────────────

const LOG_ICONS: Record<string, string> = {
  session:      '◈',
  intervention: '⚡',
  goal:         '◎',
  pattern:      '≈',
  conversation: '◇',
};

window.axon.onLog((data: unknown) => {
  const entry = data as LogEntry;
  const list  = document.getElementById('log-list');
  if (!list) return;

  const empty = list.querySelector('.log-empty');
  if (empty) list.removeChild(empty);

  const icon = LOG_ICONS[entry.type] ?? '·';
  const div  = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="log-time">${escapeHtml(entry.time)}</span><span class="log-icon">${icon}</span><span class="log-msg">${escapeHtml(entry.message)}</span>`;
  list.prepend(div);

  while (list.children.length > 50) {
    list.removeChild(list.lastChild!);
  }
});

// ── Notifications (free-tier orb interventions) ──────────────────────────────

window.axon.onNotification((data: unknown) => {
  const notif = data as OrbNotification;
  const area  = document.getElementById('notification-area');
  if (!area) return;

  const div = document.createElement('div');
  div.className = `orb-notification ${notif.type}`;
  div.textContent = notif.message;
  area.prepend(div);

  while (area.children.length > 3) {
    area.removeChild(area.lastChild!);
  }

  setTimeout(() => {
    if (div.parentNode === area) area.removeChild(div);
  }, 30_000);
});

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab: 'hud' | 'log'): void {
  const hudView = document.getElementById('hud-view') as HTMLElement;
  const logView = document.getElementById('log-view') as HTMLElement;
  const hudTab  = document.getElementById('tab-hud')  as HTMLElement;
  const logTab  = document.getElementById('tab-log')  as HTMLElement;

  if (tab === 'hud') {
    hudView.style.display = 'flex';
    logView.style.display = 'none';
    hudTab.classList.add('tab-active');
    logTab.classList.remove('tab-active');
  } else {
    hudView.style.display = 'none';
    logView.style.display = 'flex';
    hudTab.classList.remove('tab-active');
    logTab.classList.add('tab-active');
  }
}

(document.getElementById('tab-hud') as HTMLElement).addEventListener('click', () => switchTab('hud'));
(document.getElementById('tab-log') as HTMLElement).addEventListener('click', () => switchTab('log'));

// ── Waveform canvas ───────────────────────────────────────────────────────────
// All geometry is derived from the canvas's current pixel size so it scales
// automatically when the user resizes the window.

const canvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const ctx    = canvas.getContext('2d')!;
const N_BARS = 64;

// Mutable geometry — recalculated by resizeCanvas() via ResizeObserver
let CX      = 130;
let CY      = 130;
let R_INNER = 72;
let R_MAX   = 118;
let RING1   = 124;
let RING2   = 132;
let BAR_W   = 1.8;
let DOT_R   = 3;

/** Resize the canvas backing buffer to match its CSS display size. */
function resizeCanvas(): void {
  const container = document.getElementById('waveform-container') as HTMLElement;
  const raw       = container.clientWidth;
  const size      = Math.min(raw, 300);          // cap at 300px — matches CSS max-width
  const dpr       = window.devicePixelRatio || 1;

  canvas.width  = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.scale(dpr, dpr);                           // reset transform after resize

  const half = size / 2;
  CX      = half;
  CY      = half;
  R_INNER = half * 0.554;
  R_MAX   = half * 0.908;
  RING1   = half * 0.954;
  RING2   = half * 1.015;
  BAR_W   = Math.max(1.2, half * 0.014);
  DOT_R   = Math.max(2, half * 0.023);
}

// Run once immediately, then watch for window resize.
// Debounce prevents "ResizeObserver loop completed with undelivered notifications".
resizeCanvas();
let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => resizeCanvas(), 100);
}).observe(document.getElementById('waveform-container') as HTMLElement);

const barEnergy    = new Float32Array(N_BARS);
const targetEnergy = new Float32Array(N_BARS);
let   frameCount   = 0;

function setTargetEnergies(): void {
  for (let i = 0; i < N_BARS; i++) {
    switch (currentState) {
      case 'idle':
        // Very slow, low amplitude breathing — different phase per bar
        targetEnergy[i] = 2 + 2.5 * Math.abs(Math.sin(frameCount * 0.012 + i * 0.28));
        break;
      case 'listening':
        // Energetic, variable, reacts to "mic activity"
        targetEnergy[i] = 5 + Math.random() * 20;
        break;
      case 'thinking':
        // Low uniform base — sweep effect handles the visual interest
        targetEnergy[i] = 2 + Math.random() * 5;
        break;
      case 'speaking':
        // High amplitude, punchy peaks
        targetEnergy[i] = 10 + Math.random() * 22;
        break;
      case 'urgent':
        targetEnergy[i] = 8 + Math.random() * 18;
        break;
      default:
        targetEnergy[i] = 2;
    }
  }
}

function lerpEnergies(): void {
  // Idle lerps very slowly for a smooth breath; other states snap quicker
  const speed = currentState === 'idle' ? 0.035 : 0.18;
  for (let i = 0; i < N_BARS; i++) {
    barEnergy[i] += (targetEnergy[i] - barEnergy[i]) * speed;
  }
}

function drawFrame(): void {
  // CX*2 = canvas logical size (dpr scaling already applied via ctx.scale in resizeCanvas)
  ctx.clearRect(0, 0, CX * 2, CY * 2);

  // ── Rotating arc rings ─────────────────────────────────────────────────────
  // Two rings with 4 segments each, gaps give the targeting sight look.
  const rotCW  =  frameCount * 0.005;
  const rotCCW = -frameCount * 0.007;

  const ringConfig: [number, number][] = [[RING1, rotCW], [RING2, rotCCW]];
  for (const [r, rot] of ringConfig) {
    ctx.strokeStyle = 'rgba(0, 68, 85, 0.9)';
    ctx.lineWidth   = 1;
    for (let seg = 0; seg < 4; seg++) {
      const start = rot + seg * (Math.PI / 2);
      const end   = start + Math.PI / 2 - 0.25;
      ctx.beginPath();
      ctx.arc(CX, CY, r, start, end);
      ctx.stroke();
    }
  }

  // ── Bars ────────────────────────────────────────────────────────────────────
  for (let i = 0; i < N_BARS; i++) {
    const angle  = (i / N_BARS) * Math.PI * 2 - Math.PI / 2;
    const energy = Math.max(0.5, barEnergy[i]);

    // Thinking state: rotating sweep makes one sector bright white
    let sweepMult = 1;
    if (currentState === 'thinking') {
      const sweepAngle = (frameCount * 0.022) % (Math.PI * 2);
      const normalised = ((angle - sweepAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const dist       = Math.abs(normalised);
      sweepMult        = dist < 0.6 ? 3 - dist * 3 : 0.35;
    }

    const barLen = Math.min(energy, R_MAX - R_INNER);
    const sx     = CX + Math.cos(angle) * R_INNER;
    const sy     = CY + Math.sin(angle) * R_INNER;
    const ex     = CX + Math.cos(angle) * (R_INNER + barLen);
    const ey     = CY + Math.sin(angle) * (R_INNER + barLen);

    let color: string;
    switch (currentState) {
      case 'idle':
        color = `rgba(0, 212, 255, ${(0.28 * sweepMult).toFixed(2)})`;
        break;
      case 'listening':
        color = `rgba(0, 212, 255, 0.80)`;
        break;
      case 'thinking': {
        const w = Math.min(1, sweepMult * 0.45);
        const r = Math.round(180 * w);
        const g = Math.round(210 * w + 212 * (1 - w));
        color   = `rgba(${r}, ${g}, 255, ${(0.35 + w * 0.55).toFixed(2)})`;
        break;
      }
      case 'speaking': {
        // Gradient from cyan (#00D4FF) toward blue (#0040FF) as amplitude rises
        const t = Math.min(1, barLen / 30);
        const r = Math.round(t * 0);
        const g = Math.round(212 - t * 148);
        color   = `rgba(${r}, ${g}, 255, 0.88)`;
        break;
      }
      case 'urgent':
        color = `rgba(255, 55, 55, 0.82)`;
        break;
      default:
        color = 'rgba(0, 212, 255, 0.3)';
    }

    ctx.strokeStyle = color;
    ctx.lineWidth   = BAR_W;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }

  // ── Centre dot ──────────────────────────────────────────────────────────────
  const dotAlpha = currentState === 'idle' ? 0.35 : 0.75;
  ctx.beginPath();
  ctx.arc(CX, CY, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0, 212, 255, ${dotAlpha})`;
  ctx.fill();
}

// ── Mini waveform (pill mode) ─────────────────────────────────────────────────

const miniCanvas = document.getElementById('mini-waveform') as HTMLCanvasElement;
const miniCtx    = miniCanvas.getContext('2d')!;
const MINI_CX    = 20;
const MINI_CY    = 20;
const MINI_INNER = 9;
const MINI_OUTER = 17;
const MINI_BARS  = 32;

function drawMiniFrame(): void {
  miniCtx.clearRect(0, 0, 40, 40);
  for (let i = 0; i < MINI_BARS; i++) {
    const angle  = (i / MINI_BARS) * Math.PI * 2 - Math.PI / 2;
    const energy = barEnergy[i % N_BARS];
    const len    = Math.min(Math.max(0.5, energy * 0.38), MINI_OUTER - MINI_INNER);
    miniCtx.strokeStyle = 'rgba(0, 212, 255, 0.7)';
    miniCtx.lineWidth   = 1;
    miniCtx.beginPath();
    miniCtx.moveTo(MINI_CX + Math.cos(angle) * MINI_INNER,
                   MINI_CY + Math.sin(angle) * MINI_INNER);
    miniCtx.lineTo(MINI_CX + Math.cos(angle) * (MINI_INNER + len),
                   MINI_CY + Math.sin(angle) * (MINI_INNER + len));
    miniCtx.stroke();
  }
}

// ── Animation loop ────────────────────────────────────────────────────────────

function animate(): void {
  frameCount++;

  // Refresh targets at different rates per state
  const rate = currentState === 'idle' ? 10 : currentState === 'thinking' ? 5 : 3;
  if (frameCount % rate === 0) setTargetEnergies();

  lerpEnergies();
  drawFrame();
  drawMiniFrame();

  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

// ── Waveform click → toggle pill ─────────────────────────────────────────────

(document.getElementById('waveform-container') as HTMLElement).addEventListener('click', () => {
  const panel    = document.getElementById('panel') as HTMLElement;
  const miniPill = document.getElementById('mini-pill') as HTMLElement;
  panel.style.display    = 'none';
  miniPill.style.display = 'flex';
  isPillMode = true;
  window.axon.toPill();
});

// ── Window controls ───────────────────────────────────────────────────────────

let isPillMode = false;

(document.getElementById('minimise-btn') as HTMLElement).addEventListener('click', () => {
  window.axon.minimiseWindow();
});

(document.getElementById('close-btn') as HTMLElement).addEventListener('click', () => {
  const panel    = document.getElementById('panel') as HTMLElement;
  const miniPill = document.getElementById('mini-pill') as HTMLElement;
  panel.style.display    = 'none';
  miniPill.style.display = 'flex';
  isPillMode = true;
  window.axon.toPill();
});

(document.getElementById('mini-pill') as HTMLElement).addEventListener('click', () => {
  if (!isPillMode) return;
  const panel    = document.getElementById('panel') as HTMLElement;
  const miniPill = document.getElementById('mini-pill') as HTMLElement;
  miniPill.style.display = 'none';
  panel.style.display    = 'flex';
  isPillMode = false;
  window.axon.fromPill();
});

// ── Interrupt button ──────────────────────────────────────────────────────────

(document.getElementById('interrupt-btn') as HTMLElement).addEventListener('click', () => {
  window.axon.interruptAxon();
});

// ── Ready signal ──────────────────────────────────────────────────────────────

window.axon.ready();

// ── Microphone capture (macOS IPC path) ──────────────────────────────────────
// Main sends mic:start when it wants PCM audio. We capture via getUserMedia,
// convert float32 → int16, and stream raw PCM16LE back via IPC.

let micStream:    MediaStream | null = null;
let micContext:   AudioContext | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micChunkCount = 0;

async function startMic(): Promise<void> {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,   // remove Axon TTS echo
      noiseSuppression: true,   // reduce ambient noise
      autoGainControl:  false,  // keep levels consistent for RMS gate
      channelCount:     1,
    },
    video: false,
  });
  console.log('[Orb] getUserMedia granted');
  micContext = new AudioContext({ sampleRate: 24000 });
  await micContext.resume();
  console.log('[Orb] AudioContext state:', micContext.state);

  const source = micContext.createMediaStreamSource(micStream);
  // 4096-sample buffer ≈ 170ms at 24kHz
  micProcessor = micContext.createScriptProcessor(4096, 1, 1);

  micChunkCount = 0;
  micProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
    const float32 = e.inputBuffer.getChannelData(0);
    const int16   = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      // 0.5 gain matches SoX 'vol 0.5' used on Windows
      const s = float32[i] * 0.5;
      int16[i] = Math.max(-32768, Math.min(32767, s * 32768));
    }
    const chunk = new Uint8Array(int16.buffer);
    if (micChunkCount === 0 || micChunkCount % 50 === 0) {
      console.log('[Orb] sendMicChunk #' + micChunkCount + ', bytes:', chunk.byteLength);
    }
    micChunkCount++;
    window.axon.sendMicChunk(chunk);
  };

  source.connect(micProcessor);
  micProcessor.connect(micContext.destination);
}

async function stopMic(): Promise<void> {
  micProcessor?.disconnect();
  micProcessor = null;
  if (micContext) {
    await micContext.close();
    micContext = null;
  }
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
}

window.axon.onMicStart(async () => {
  console.log('[Orb] mic:start received, requesting getUserMedia...');
  try {
    await startMic();
  } catch (err) {
    console.error('[Orb] getUserMedia failed:', err);
    window.axon.sendMicError(String(err));
  }
});

window.axon.onMicStop(() => {
  void stopMic();
});

window.axon.onMicRestart(async () => {
  console.log('[Orb] mic:restart received — resuming AudioContext');
  try {
    await stopMic();
    await new Promise(r => setTimeout(r, 500));
    await startMic();
    console.log('[Orb] mic restarted successfully after resume');
  } catch (err) {
    console.error('[Orb] mic restart failed:', err);
    window.axon.sendMicDied();
  }
});

// Periodic AudioContext health check — catches silent death after lid open
setInterval(async () => {
  if (!micContext) return;
  if (micContext.state === 'suspended') {
    console.log('[Orb] AudioContext suspended — attempting resume');
    try {
      await micContext.resume();
      console.log('[Orb] AudioContext resumed successfully');
    } catch {
      console.log('[Orb] AudioContext resume failed — sending mic:died');
      window.axon.sendMicDied();
    }
  }
  if (micContext.state === 'closed') {
    console.log('[Orb] AudioContext closed — sending mic:died');
    window.axon.sendMicDied();
  }
}, 30000);

console.log('[Orb] sending mic:ready');
window.axon.sendMicReady();

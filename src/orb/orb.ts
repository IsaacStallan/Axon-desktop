// `export {}` makes this a module so `declare global` augmentations are legal.
export {};

declare global {
  interface Window {
    axon: {
      onStateChange:    (cb: (state: string) => void) => void;
      onMessage:        (cb: (msg: string) => void) => void;
      onStatsUpdate:    (cb: (stats: AxonStats) => void) => void;
      onActivityUpdate: (cb: (activity: string) => void) => void;
      onAgentsUpdate:   (cb: (agents: AgentStatus[]) => void) => void;
      tapOrb:           () => void;
      ready:            () => void;
      minimiseWindow:   () => void;
      toPill:           () => void;
      fromPill:         () => void;
      onMicStart:       (cb: () => void) => void;
      onMicStop:        (cb: () => void) => void;
      sendMicChunk:     (chunk: Uint8Array) => void;
      sendMicError:     (msg: string) => void;
      sendMicReady:     () => void;
    };
  }
}

interface AxonStats {
  focusMin:   number;
  driftMin:   number;
  priorities: Array<{ text: string; impactScore: number }>;
  commitments: string[];
  openApps:   Array<{ name: string; lastUsed: number; isActive: boolean }>;
}

interface AgentStatus {
  id:          string;
  description: string;
  status:      'running' | 'completed' | 'failed';
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentState = 'idle';

// ── Clock ─────────────────────────────────────────────────────────────────────

function updateClock(): void {
  const now = new Date();
  const h   = now.getHours().toString().padStart(2, '0');
  const m   = now.getMinutes().toString().padStart(2, '0');
  const el  = document.getElementById('clock');
  if (el) el.textContent = `${h}:${m}`;
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
  currentState           = state;
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

// ── Stats updates ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.axon.onStatsUpdate((stats: AxonStats) => {
  const get = (id: string) => document.getElementById(id);

  const focusEl = get('focus-time');
  const driftEl = get('drift-time');
  const prList  = get('priorities-list');
  const cmList  = get('commitments-list');
  const actRow  = get('apps-active-row');
  const inactRow = get('apps-inactive-row');

  if (focusEl) focusEl.textContent = `${stats.focusMin}m`;
  if (driftEl) driftEl.textContent = `${stats.driftMin}m`;

  // Open apps
  const apps   = stats.openApps ?? [];
  const active = apps.filter(a => a.isActive);
  const inact  = apps.filter(a => !a.isActive);

  if (actRow) {
    actRow.innerHTML = active.length > 0
      ? active.map(a => `<span class="app-chip active">● ${escapeHtml(a.name)}</span>`).join('')
      : '';
  }
  if (inactRow) {
    inactRow.innerHTML = inact.length > 0
      ? inact.map(a => `<span class="app-chip inactive">○ ${escapeHtml(a.name)}</span>`).join('')
      : '';
  }

  // Goals with bar + percentage
  if (prList) {
    prList.innerHTML = (stats.priorities ?? []).map((p, i) => {
      const pct = p.impactScore * 10;
      return `
        <div class="priority-item">
          <span class="priority-num">0${i + 1}</span>
          <span class="priority-text">${escapeHtml(p.text.slice(0, 28))}${p.text.length > 28 ? '…' : ''}</span>
          <div class="priority-bar-wrap">
            <div class="priority-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="priority-pct">${pct}%</span>
        </div>
      `;
    }).join('');
  }

  if (cmList) {
    cmList.innerHTML = (stats.commitments ?? []).map(c => `
      <div class="commitment-item">
        <span class="commitment-arrow">→</span>
        <span class="commitment-text">${escapeHtml(c)}</span>
      </div>
    `).join('');
  }
});

// ── Activity updates ──────────────────────────────────────────────────────────

window.axon.onActivityUpdate((activity: string) => {
  const el = document.getElementById('axon-activity');
  if (el) el.textContent = activity;
});

// ── Agent updates ─────────────────────────────────────────────────────────────

window.axon.onAgentsUpdate((agents: AgentStatus[]) => {
  const list = document.getElementById('agents-list');
  if (!list) return;

  if (agents.length === 0) {
    list.innerHTML = '<div class="no-agents">no agents active</div>';
    return;
  }

  list.innerHTML = agents.map(a => {
    const icon = a.status === 'running'   ? '<span class="agent-spin">⟳</span>'
               : a.status === 'completed' ? '✓'
               : '✗';
    const cls  = a.status === 'running'   ? 'agent-running'
               : a.status === 'completed' ? 'agent-done'
               : 'agent-failed';
    return `<div class="agent-item ${cls}">${icon} <span>${escapeHtml(a.description)}</span></div>`;
  }).join('');
});

// ── Waveform canvas ───────────────────────────────────────────────────────────

const canvas   = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const ctx      = canvas.getContext('2d')!;
const N_BARS   = 64;
const CX       = 100;
const CY       = 100;
const R_INNER  = 55;   // where bars start
const R_MAX    = 90;   // max bar tip radius
const BAR_W    = 1.6;

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
  ctx.clearRect(0, 0, 200, 200);

  // ── Rotating arc rings ─────────────────────────────────────────────────────
  // Two rings with 4 segments each, gaps give the targeting sight look.
  const rotCW  =  frameCount * 0.005;
  const rotCCW = -frameCount * 0.007;

  const ringConfig: [number, number][] = [[95, rotCW], [101, rotCCW]];
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
  ctx.arc(CX, CY, 3, 0, Math.PI * 2);
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

// ── Ready signal ──────────────────────────────────────────────────────────────

window.axon.ready();

// ── Microphone capture (macOS IPC path) ──────────────────────────────────────
// Main sends mic:start when it wants PCM audio. We capture via getUserMedia,
// convert float32 → int16, and stream raw PCM16LE back via IPC.

let micStream:    MediaStream | null = null;
let micContext:   AudioContext | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micChunkCount = 0;

window.axon.onMicStart(async () => {
  console.log('[Orb] mic:start received, requesting getUserMedia...');
  try {
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
  } catch (err) {
    console.error('[Orb] getUserMedia failed:', err);
    window.axon.sendMicError(String(err));
  }
});

window.axon.onMicStop(() => {
  micProcessor?.disconnect();
  micProcessor = null;
  micContext?.close();
  micContext = null;
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
});

console.log('[Orb] sending mic:ready');
window.axon.sendMicReady();

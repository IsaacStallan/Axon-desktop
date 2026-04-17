export {};

// ── IPC bridge type ───────────────────────────────────────────────────────────

declare global {
  interface Window {
    softlock: {
      onState:  (cb: (state: SoftLockState) => void) => void;
      going:    () => Promise<void>;
      override: () => Promise<string>;
    };
  }
}

interface SoftLockState {
  active:       boolean;
  reason:       string;
  startTime:    string;
  endTime:      string;
  canOverride:  boolean;
  overrideUsed: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lockState: any = null;

// ── Waveform ──────────────────────────────────────────────────────────────────

const N_BARS    = 64;
const energy    = new Float32Array(N_BARS);
let   frame     = 0;

function tickEnergy(): void {
  for (let i = 0; i < N_BARS; i++) {
    const target = 4 + 4 * Math.abs(Math.sin(frame * 0.018 + i * 0.28)) + Math.random() * 6;
    energy[i] += (target - energy[i]) * 0.12;
  }
}

function drawWave(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr  = window.devicePixelRatio || 1;
  const size = canvas.offsetWidth;
  if (canvas.width !== size * dpr) {
    canvas.width  = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const CX      = size / 2;
  const CY      = size / 2;
  const R_INNER = CX * 0.52;
  const R_MAX   = CX * 0.90;
  const RING1   = CX * 0.95;
  const RING2   = CX * 1.02;
  const BAR_W   = Math.max(1.2, CX * 0.013);

  // Rotating rings
  for (const [r, rot] of [[RING1,  frame * 0.004], [RING2, -frame * 0.006]] as [number, number][]) {
    ctx.strokeStyle = 'rgba(0,68,85,0.8)';
    ctx.lineWidth   = 1;
    for (let seg = 0; seg < 4; seg++) {
      const start = rot + seg * (Math.PI / 2);
      ctx.beginPath();
      ctx.arc(CX, CY, r, start, start + Math.PI / 2 - 0.25);
      ctx.stroke();
    }
  }

  // Bars
  for (let i = 0; i < N_BARS; i++) {
    const angle  = (i / N_BARS) * Math.PI * 2 - Math.PI / 2;
    const e      = Math.max(0.5, energy[i]);
    const barLen = Math.min(e, R_MAX - R_INNER);
    const sx     = CX + Math.cos(angle) * R_INNER;
    const sy     = CY + Math.sin(angle) * R_INNER;
    const ex     = CX + Math.cos(angle) * (R_INNER + barLen);
    const ey     = CY + Math.sin(angle) * (R_INNER + barLen);
    ctx.strokeStyle = 'rgba(0,212,255,0.75)';
    ctx.lineWidth   = BAR_W;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function formatCountdown(endIso: string): string {
  const remaining = Math.max(0, new Date(endIso).getTime() - Date.now());
  const totalSecs = Math.floor(remaining / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} remaining`
    : `${m}:${String(s).padStart(2, '0')} remaining`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

const canvas      = document.getElementById('wave') as HTMLCanvasElement;
const reasonEl    = document.getElementById('reason')!;
const subEl       = document.getElementById('sub')!;
const countdownEl = document.getElementById('countdown')!;
const btnGoing    = document.getElementById('btn-going') as HTMLButtonElement;
const btnOverride = document.getElementById('btn-override') as HTMLAnchorElement;
const overrideMsgEl = document.getElementById('override-msg')!;

window.softlock.onState((state) => {
  lockState = state;
  reasonEl.textContent = state.reason.toUpperCase();
});

btnGoing.addEventListener('click', async () => {
  btnGoing.disabled  = true;
  btnGoing.textContent = 'See you out there.';
  await window.softlock.going();
});

btnOverride.addEventListener('click', async (e) => {
  e.preventDefault();
  btnOverride.style.display     = 'none';
  overrideMsgEl.style.display   = 'block';
  overrideMsgEl.textContent     = 'Listening for "override"...';
  const result = await window.softlock.override();
  if (result === 'override_confirmed') {
    overrideMsgEl.textContent = 'Override confirmed. Windows restored.';
  } else {
    overrideMsgEl.textContent = 'Override not confirmed.';
    btnOverride.style.display = 'block';
  }
});

// ── Animation loop ────────────────────────────────────────────────────────────

(function loop() {
  frame++;
  tickEnergy();
  drawWave(canvas);

  if (lockState?.endTime) {
    countdownEl.textContent = formatCountdown(lockState.endTime as string);
  }

  requestAnimationFrame(loop);
})();

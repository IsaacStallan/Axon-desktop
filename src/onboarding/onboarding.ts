export {};

declare global {
  interface Window {
    electronAPI: {
      requestAccessibility: () => Promise<boolean>;
      speak:               (text: string) => Promise<void>;
      completeOnboarding:  (name: string) => Promise<void>;
      onWakeWordDetected:  (callback: () => void) => void;
    };
  }
}

// ── Global error handler — catches crashes before DOMContentLoaded ────────────
window.addEventListener('error', (e) => {
  console.error('[Onboarding] JS error:', e.message, e.error);
  document.body.innerHTML = `
    <div style="background:#080c10;color:#fff;height:100vh;display:flex;
                align-items:center;justify-content:center;flex-direction:column;
                font-family:sans-serif;text-align:center;padding:40px">
      <h2 style="color:#00D4FF;margin-bottom:16px">Starting Axon...</h2>
      <p style="opacity:0.5">If this persists, restart the app.</p>
      <p style="opacity:0.3;font-size:0.8rem;margin-top:8px">${e.message}</p>
    </div>
  `;
});

// ── Safe electronAPI wrapper ──────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function axonAPI(method: string, ...args: any[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (window.electronAPI && typeof (window.electronAPI as any)[method] === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (window.electronAPI as any)[method](...args) as Promise<void> | void;
    return result ?? Promise.resolve();
  }
  console.warn('[Onboarding] electronAPI not ready or missing method:', method);
  return Promise.resolve();
}

// ── Wait for preload injection with retry ─────────────────────────────────────
function waitForElectronAPI(callback: () => void, retries = 10): void {
  if (window.electronAPI) {
    callback();
  } else if (retries > 0) {
    console.log('[Onboarding] waiting for electronAPI...', retries);
    setTimeout(() => waitForElectronAPI(callback, retries - 1), 200);
  } else {
    console.error('[Onboarding] electronAPI never became available — proceeding without it');
    callback();
  }
}

// ── Waveform helpers (pure — no DOM dependency) ───────────────────────────────

const N_BARS = 64;

function drawWave(
  canvas: HTMLCanvasElement | null,
  energy: Float32Array,
  frame:  number,
  state:  'idle' | 'speaking',
): void {
  try {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr  = window.devicePixelRatio || 1;
    const size = canvas.offsetWidth || 200;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width  = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const CX    = size / 2;
    const CY    = size / 2;
    const RI    = CX * 0.55;
    const RMAX  = CX * 0.91;
    const RING1 = CX * 0.955;
    const RING2 = CX * 1.015;
    const BAR_W = Math.max(1.2, CX * 0.014);

    const rotCW  =  frame * 0.005;
    const rotCCW = -frame * 0.007;
    for (const [r, rot] of [[RING1, rotCW], [RING2, rotCCW]] as [number, number][]) {
      ctx.strokeStyle = 'rgba(0,68,85,0.9)';
      ctx.lineWidth   = 1;
      for (let seg = 0; seg < 4; seg++) {
        const st = rot + seg * (Math.PI / 2);
        ctx.beginPath();
        ctx.arc(CX, CY, r, st, st + Math.PI / 2 - 0.25);
        ctx.stroke();
      }
    }

    const alpha = state === 'idle' ? 0.28 : 0.88;
    for (let i = 0; i < N_BARS; i++) {
      const angle  = (i / N_BARS) * Math.PI * 2 - Math.PI / 2;
      const barLen = Math.min(Math.max(0.5, energy[i]), RMAX - RI);
      ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
      ctx.lineWidth   = BAR_W;
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(angle) * RI,           CY + Math.sin(angle) * RI);
      ctx.lineTo(CX + Math.cos(angle) * (RI + barLen), CY + Math.sin(angle) * (RI + barLen));
      ctx.stroke();
    }
  } catch (err) {
    console.error('[Onboarding] drawWave error:', err);
  }
}

function tickEnergy(energy: Float32Array, frame: number, state: 'idle' | 'speaking'): void {
  const speed = state === 'idle' ? 0.035 : 0.18;
  for (let i = 0; i < N_BARS; i++) {
    const target = state === 'idle'
      ? 2 + 2.5 * Math.abs(Math.sin(frame * 0.012 + i * 0.28))
      : 10 + Math.random() * 22;
    energy[i] += (target - energy[i]) * speed;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  waitForElectronAPI(() => {
    console.log('[Onboarding] electronAPI ready — initialising');
    initOnboarding();
  });
});

function initOnboarding(): void {

  // ── Screen navigation ──────────────────────────────────────────────────────
  let currentScreen = 1;
  let userName = '';

  function goTo(n: number): void {
    for (const i of [1, 2, 3, 4]) {
      const el = document.getElementById(`s${i}`);
      if (el) el.style.display = 'none';
    }
    const target = document.getElementById(`s${n}`);
    if (target) {
      target.style.display = 'flex';
      target.style.flexDirection = 'column';
      target.style.alignItems = 'center';
      target.style.justifyContent = 'center';
    }
    currentScreen = n;
    if (n === 4) setTimeout(() => {
      if (btnFinish) {
        btnFinish.style.opacity = '1';
        btnFinish.style.pointerEvents = 'all';
      }
    }, 800);
  }

  // ── Screen 1: Welcome ──────────────────────────────────────────────────────
  const wave1Canvas = document.getElementById('wave1') as HTMLCanvasElement | null;
  const wave1Energy = new Float32Array(N_BARS);
  let   wave1Frame  = 0;
  if (!wave1Canvas) console.error('[Onboarding] canvas #wave1 not found');

  (function animateWave1() {
    try {
      wave1Frame++;
      tickEnergy(wave1Energy, wave1Frame, 'idle');
      if (currentScreen === 1) drawWave(wave1Canvas, wave1Energy, wave1Frame, 'idle');
    } catch (err) { console.error('[Onboarding] animateWave1 error:', err); }
    requestAnimationFrame(animateWave1);
  })();

  const btnStart  = document.getElementById('btn-start')  as HTMLButtonElement | null;
  const inputName = document.getElementById('input-name') as HTMLInputElement | null;
  if (!btnStart) {
    console.error('[Onboarding] #btn-start not found');
  } else {
    btnStart.addEventListener('click', () => goTo(2));
    if (inputName) {
      inputName.addEventListener('input', () => {
        userName = inputName.value.trim();
        btnStart.style.display = userName.length >= 2 ? 'block' : 'none';
      });
      inputName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && userName.length >= 2) btnStart.click();
      });
    }
  }

  // ── Screen 2: Permissions ──────────────────────────────────────────────────
  const btnPermissions = document.getElementById('btn-permissions') as HTMLButtonElement | null;
  if (!btnPermissions) {
    console.error('[Onboarding] #btn-permissions not found');
  } else {
    btnPermissions.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(t => t.stop());
        setTimeout(() => goTo(3), 1000);
      } catch {
        const denied = document.getElementById('perm-denied');
        const skip   = document.getElementById('btn-perm-skip');
        if (denied)          denied.style.display          = 'block';
        if (skip)            skip.style.display            = 'inline-block';
        if (btnPermissions)  btnPermissions.style.display  = 'none';
      }
    });
  }

  const btnPermSkip = document.getElementById('btn-perm-skip');
  if (btnPermSkip) btnPermSkip.addEventListener('click', () => goTo(3));

  // ── Screen 3: Almost ready ─────────────────────────────────────────────────
  const btnSkipVoice = document.getElementById('btn-skip-voice');
  if (btnSkipVoice) btnSkipVoice.addEventListener('click', () => goTo(4));

  // ── Screen 4: Ready ────────────────────────────────────────────────────────
  const wave4Canvas = document.getElementById('wave4') as HTMLCanvasElement | null;
  const wave4Energy = new Float32Array(N_BARS);
  let   wave4Frame  = 0;
  let   wave4State: 'idle' | 'speaking' = 'idle';
  if (!wave4Canvas) console.error('[Onboarding] canvas #wave4 not found');

  (function animateWave4() {
    try {
      wave4Frame++;
      tickEnergy(wave4Energy, wave4Frame, wave4State);
      if (currentScreen === 4) drawWave(wave4Canvas, wave4Energy, wave4Frame, wave4State);
    } catch (err) { console.error('[Onboarding] animateWave4 error:', err); }
    requestAnimationFrame(animateWave4);
  })();

  const btnFinish = document.getElementById('btn-finish') as HTMLButtonElement | null;
  if (!btnFinish) {
    console.error('[Onboarding] #btn-finish not found');
  } else {
    btnFinish.addEventListener('click', async () => {
      btnFinish.disabled = true;
      wave4State = 'speaking';
      await axonAPI('speak', "Let's get to work.");
      wave4State = 'idle';
      await axonAPI('completeOnboarding', userName);
    });
  }

  console.log('[Onboarding] initialised successfully');
}

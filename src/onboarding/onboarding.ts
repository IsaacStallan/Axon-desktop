export {};

declare global {
  interface Window {
    electronAPI: {
      requestAccessibility: () => Promise<boolean>;
      speak:               (text: string) => Promise<void>;
      completeOnboarding:  () => Promise<void>;
      onWakeWordDetected:  (callback: () => void) => void;
    };
  }
}

// ── Screen navigation ─────────────────────────────────────────────────────────

let currentScreen = 1;

function goTo(n: number): void {
  document.getElementById(`s${currentScreen}`)?.classList.remove('active');
  document.getElementById(`s${n}`)?.classList.add('active');
  currentScreen = n;
  if (n === 3) setTimeout(startVoiceTest, 600);
  if (n === 4) setTimeout(() => btnFinish.classList.add('visible'), 800);
}

// ── Waveform drawing ──────────────────────────────────────────────────────────

const N_BARS = 64;

function drawWave(
  canvas: HTMLCanvasElement,
  energy: Float32Array,
  frame:  number,
  state:  'idle' | 'speaking',
): void {
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

// ── Screen 1: Welcome ─────────────────────────────────────────────────────────

const wave1Canvas = document.getElementById('wave1') as HTMLCanvasElement;
const wave1Energy = new Float32Array(N_BARS);
let   wave1Frame  = 0;

(function animateWave1() {
  wave1Frame++;
  tickEnergy(wave1Energy, wave1Frame, 'idle');
  if (currentScreen === 1) drawWave(wave1Canvas, wave1Energy, wave1Frame, 'idle');
  requestAnimationFrame(animateWave1);
})();

const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
setTimeout(() => { btnStart.classList.add('visible'); }, 2000);
btnStart.addEventListener('click', () => goTo(2));

// ── Screen 2: Permissions ─────────────────────────────────────────────────────

document.getElementById('btn-permissions')!.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(t => t.stop());
    setTimeout(() => goTo(3), 1000);
  } catch {
    (document.getElementById('perm-denied')!    as HTMLElement).style.display = 'block';
    (document.getElementById('btn-perm-skip')!  as HTMLElement).style.display = 'inline-block';
    (document.getElementById('btn-permissions')! as HTMLButtonElement).style.display = 'none';
  }
});

document.getElementById('btn-perm-skip')!.addEventListener('click', () => goTo(3));

// ── Screen 3: Voice test ──────────────────────────────────────────────────────

const wave3Canvas = document.getElementById('wave3') as HTMLCanvasElement;
const wave3Energy = new Float32Array(N_BARS);
let   wave3Frame  = 0;
let   wave3State: 'idle' | 'speaking' = 'idle';

(function animateWave3() {
  wave3Frame++;
  tickEnergy(wave3Energy, wave3Frame, wave3State);
  if (currentScreen === 3) drawWave(wave3Canvas, wave3Energy, wave3Frame, wave3State);
  requestAnimationFrame(animateWave3);
})();

async function startVoiceTest(): Promise<void> {
  wave3State = 'speaking';
  try {
    await window.electronAPI.speak("I'm Axon. Say hey Axon to wake me.");
  } catch { /* TTS optional */ }
  wave3State = 'idle';
  setTimeout(() => {
    (document.getElementById('btn-skip-voice') as HTMLElement).classList.add('visible');
  }, 400);
}

document.getElementById('btn-skip-voice')!.addEventListener('click', () => goTo(4));

window.electronAPI.onWakeWordDetected(() => {
  if (currentScreen === 3) goTo(4);
});

// ── Screen 4: Ready ───────────────────────────────────────────────────────────

const wave4Canvas = document.getElementById('wave4') as HTMLCanvasElement;
const wave4Energy = new Float32Array(N_BARS);
let   wave4Frame  = 0;
let   wave4State: 'idle' | 'speaking' = 'idle';

(function animateWave4() {
  wave4Frame++;
  tickEnergy(wave4Energy, wave4Frame, wave4State);
  if (currentScreen === 4) drawWave(wave4Canvas, wave4Energy, wave4Frame, wave4State);
  requestAnimationFrame(animateWave4);
})();

const btnFinish = document.getElementById('btn-finish') as HTMLButtonElement;

btnFinish.addEventListener('click', async () => {
  btnFinish.disabled = true;
  wave4State = 'speaking';
  try {
    await window.electronAPI.speak("Let's get to work.");
  } catch { /* TTS optional */ }
  wave4State = 'idle';
  await window.electronAPI.completeOnboarding();
});

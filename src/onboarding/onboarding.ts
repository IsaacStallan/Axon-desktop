export {};

declare global {
  interface Window {
    onboarding: {
      speak:    (text: string) => Promise<void>;
      complete: ()             => Promise<void>;
    };
  }
}

// ── Screen navigation ─────────────────────────────────────────────────────────

let currentScreen = 1;

function goTo(n: number): void {
  document.getElementById(`s${currentScreen}`)?.classList.remove('active');
  document.getElementById(`s${n}`)?.classList.add('active');
  currentScreen = n;
}

// ── Waveform drawing (idle / speaking / listening) ────────────────────────────

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

  const CX     = size / 2;
  const CY     = size / 2;
  const RI     = CX * 0.55;
  const RMAX   = CX * 0.91;
  const RING1  = CX * 0.955;
  const RING2  = CX * 1.015;
  const BAR_W  = Math.max(1.2, CX * 0.014);

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
    ctx.moveTo(CX + Math.cos(angle) * RI,          CY + Math.sin(angle) * RI);
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

// Button appears after 2 seconds
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
setTimeout(() => { btnStart.classList.add('visible'); }, 2000);
btnStart.addEventListener('click', () => goTo(2));

// ── Screen 2: Microphone ──────────────────────────────────────────────────────

document.getElementById('btn-allow-mic')!.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Permission granted — stop the test stream immediately (main orb will use its own)
    stream.getTracks().forEach(t => t.stop());
    // Auto-advance after 1 second
    setTimeout(() => {
      goTo(3);
      startDoneScreen();
    }, 1000);
  } catch {
    // Denied — show fallback message and continue button
    (document.getElementById('mic-denied')      as HTMLElement).style.display = 'block';
    (document.getElementById('btn-mic-continue') as HTMLElement).style.display = 'inline-block';
    (document.getElementById('btn-allow-mic')    as HTMLButtonElement).style.display = 'none';
  }
});

document.getElementById('btn-mic-continue')!.addEventListener('click', () => {
  goTo(3);
  startDoneScreen();
});

// ── Screen 3: Done ─────────────────────────────────────────────────────────────

const waveDoneCanvas = document.getElementById('wave-done') as HTMLCanvasElement;
const waveDoneEnergy = new Float32Array(N_BARS);
let   waveDoneFrame  = 0;
let   waveDoneState: 'idle' | 'speaking' = 'idle';

(function animateWaveDone() {
  waveDoneFrame++;
  tickEnergy(waveDoneEnergy, waveDoneFrame, waveDoneState);
  if (currentScreen === 3) drawWave(waveDoneCanvas, waveDoneEnergy, waveDoneFrame, waveDoneState);
  requestAnimationFrame(animateWaveDone);
})();

async function startDoneScreen(): Promise<void> {
  waveDoneState = 'speaking';
  try {
    await window.onboarding.speak("I'm Axon. I'll be watching. Let's get to work.");
  } catch {
    // TTS failed — proceed anyway
  }
  waveDoneState = 'idle';
  // Complete onboarding and launch orb
  await window.onboarding.complete();
}

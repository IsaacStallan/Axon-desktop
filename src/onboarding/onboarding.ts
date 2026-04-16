export {};

// ── Global IPC bridge ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    onboarding: {
      getScreenPermission:        () => Promise<string>;
      getAccessibilityPermission: () => Promise<boolean>;
      requestAccessibility:       () => Promise<boolean>;
      speak:       (text: string)                                    => Promise<void>;
      listen:      (secs: number)                                    => Promise<string>;
      saveAnswers: (qa: Array<{ question: string; answer: string }>) => Promise<void>;
      complete:    ()                                                => Promise<void>;
    };
  }
}

// ── Screen navigation ─────────────────────────────────────────────────────────

let currentScreen = 1;

function goTo(n: number): void {
  const prev = document.getElementById(`s${currentScreen}`);
  const next = document.getElementById(`s${n}`);
  if (prev) prev.classList.remove('active');
  if (next) next.classList.add('active');
  currentScreen = n;
}

// ── Waveform helpers ─────────────────────────────────────────────────────────
// Matches the orb.ts idle-breathing formula.

const N_BARS  = 64;
const barEnergy: Float32Array[] = [];

function makeEnergyBuf(): Float32Array { return new Float32Array(N_BARS); }

function drawWave(
  canvas:     HTMLCanvasElement,
  energy:     Float32Array,
  frame:      number,
  state:      'idle' | 'speaking' | 'listening',
): void {
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
  const R_INNER = CX * 0.55;
  const R_MAX   = CX * 0.91;
  const RING1   = CX * 0.955;
  const RING2   = CX * 1.015;
  const BAR_W   = Math.max(1.2, CX * 0.014);

  // Rotating rings
  const rotCW  =  frame * 0.005;
  const rotCCW = -frame * 0.007;
  for (const [r, rot] of [[RING1, rotCW], [RING2, rotCCW]] as [number, number][]) {
    ctx.strokeStyle = 'rgba(0,68,85,0.9)';
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

    const alpha = state === 'idle'     ? 0.28
                : state === 'speaking' ? 0.88
                : 0.80;
    ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
    ctx.lineWidth   = BAR_W;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

function tickEnergy(energy: Float32Array, frame: number, state: 'idle' | 'speaking' | 'listening'): void {
  const speed = state === 'idle' ? 0.035 : 0.18;
  for (let i = 0; i < N_BARS; i++) {
    let target: number;
    if (state === 'idle') {
      target = 2 + 2.5 * Math.abs(Math.sin(frame * 0.012 + i * 0.28));
    } else if (state === 'speaking') {
      target = 10 + Math.random() * 22;
    } else {
      target = 5 + Math.random() * 20;
    }
    energy[i] += (target - energy[i]) * speed;
  }
}

// ── Screen 1: Welcome waveform ────────────────────────────────────────────────

const wave1Canvas  = document.getElementById('wave1')  as HTMLCanvasElement;
const wave1Energy  = makeEnergyBuf();
let   wave1Frame   = 0;

(function animateWave1() {
  wave1Frame++;
  tickEnergy(wave1Energy, wave1Frame, 'idle');
  if (currentScreen === 1) drawWave(wave1Canvas, wave1Energy, wave1Frame, 'idle');
  requestAnimationFrame(animateWave1);
})();

document.getElementById('btn-start')!.addEventListener('click', () => goTo(2));

// ── Screen 2: Permissions ─────────────────────────────────────────────────────

let micGranted = false;

async function refreshPermissions(): Promise<void> {
  const screenStatus = await window.onboarding.getScreenPermission();
  const accGranted   = await window.onboarding.getAccessibilityPermission();

  setDot('screen-dot', screenStatus === 'granted');
  setDot('acc-dot',    accGranted);

  if (screenStatus === 'granted') markPermDone('btn-screen-grant');
  if (accGranted)                  markPermDone('btn-acc-grant');
}

function setDot(id: string, granted: boolean): void {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('granted', granted);
}

function markPermDone(btnId: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (btn) { btn.textContent = 'Granted'; btn.classList.add('done'); btn.disabled = true; }
}

document.getElementById('btn-mic-grant')!.addEventListener('click', async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    micGranted = true;
    setDot('mic-dot', true);
    markPermDone('btn-mic-grant');
    (document.getElementById('btn-perms-continue') as HTMLButtonElement).disabled = false;
  } catch {
    console.warn('[Onboarding] mic access denied');
  }
});

document.getElementById('btn-screen-grant')!.addEventListener('click', async () => {
  await window.onboarding.getScreenPermission();
  await refreshPermissions();
});

document.getElementById('btn-acc-grant')!.addEventListener('click', async () => {
  await window.onboarding.requestAccessibility();
  await refreshPermissions();
});

document.getElementById('btn-perms-continue')!.addEventListener('click', () => goTo(3));

// Run permission status check when screen 2 becomes visible
const s2El = document.getElementById('s2')!;
new MutationObserver(() => {
  if (s2El.classList.contains('active')) void refreshPermissions();
}).observe(s2El, { attributes: true });

// ── Screen 3: Voice test ──────────────────────────────────────────────────────

const waveMicCanvas = document.getElementById('wave-mic') as HTMLCanvasElement;
const waveMicEnergy = makeEnergyBuf();
let   waveMicFrame  = 0;
let   micStream:   MediaStream | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let   analyserNode: any = null;
const MIC_THRESHOLD = 20;

async function startMicWaveform(): Promise<void> {
  try {
    micStream   = await navigator.mediaDevices.getUserMedia({ audio: true });
    const actx  = new AudioContext();
    const src   = actx.createMediaStreamSource(micStream);
    analyserNode = actx.createAnalyser();
    analyserNode.fftSize = 128;
    src.connect(analyserNode);
  } catch { /* mic not available — still show idle waveform */ }
}

void startMicWaveform();

(function animateMicWave() {
  waveMicFrame++;
  let level = 0;

  const an = analyserNode;
  if (an) {
    const buf = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(buf);
    level = buf.reduce((s, v) => s + v, 0) / buf.length;
  }

  const state = level > MIC_THRESHOLD ? 'listening' : 'idle';
  tickEnergy(waveMicEnergy, waveMicFrame, state);
  if (currentScreen === 3) drawWave(waveMicCanvas, waveMicEnergy, waveMicFrame, state);

  const fb = document.getElementById('mic-feedback')!;
  if (currentScreen === 3) {
    if (level > MIC_THRESHOLD) {
      fb.textContent = 'Microphone working';
      fb.classList.add('active');
    } else {
      fb.classList.remove('active');
    }
  }

  requestAnimationFrame(animateMicWave);
})();

document.getElementById('btn-voice-continue')!.addEventListener('click', () => {
  // Stop mic stream before interview (whisperService will start its own)
  micStream?.getTracks().forEach(t => t.stop());
  micStream     = null;
  analyserNode  = null;
  initInterview();
  goTo(4);
});

// ── Screen 4: Interview ───────────────────────────────────────────────────────

const QUESTIONS = [
  "What's your biggest time waster right now?",
  "Do you work better in long blocks or short sprints?",
  "What would you want me to say to you when you're at your worst?",
  "What are your major goals you want completed in the next 100 days?",
  "What does your schedule look like right now?",
];

const answers: Array<{ question: string; answer: string }> = [];
let currentQ = 0;

function initInterview(): void {
  // Build progress dots
  const dotsRow = document.getElementById('q-dots-row')!;
  dotsRow.innerHTML = QUESTIONS.map((_, i) =>
    `<div class="q-dot" id="qdot-${i}"></div>`
  ).join('');
  updateDots(0);
  void askQuestion(0);
}

function updateDots(active: number): void {
  QUESTIONS.forEach((_, i) => {
    const d = document.getElementById(`qdot-${i}`);
    if (!d) return;
    d.className = 'q-dot' + (i < active ? ' done' : i === active ? ' current' : '');
  });
  const numEl = document.getElementById('q-num');
  if (numEl) numEl.textContent = String(active + 1);
}

async function askQuestion(index: number): Promise<void> {
  currentQ = index;
  updateDots(index);

  const qTextEl      = document.getElementById('q-text')!;
  const qStateEl     = document.getElementById('q-state')!;
  const qTransEl     = document.getElementById('q-transcript')!;
  const btnNext      = document.getElementById('btn-next-q') as HTMLButtonElement;
  const btnRerecord  = document.getElementById('btn-rerecord') as HTMLButtonElement;

  const q = QUESTIONS[index];
  qTextEl.textContent   = q;
  qStateEl.textContent  = 'Axon is speaking...';
  qStateEl.className    = 'q-state';
  qTransEl.textContent  = '';
  btnNext.disabled      = true;
  btnRerecord.style.display = 'none';

  // Speak the question via ElevenLabs
  try {
    await window.onboarding.speak(q);
  } catch { /* continue even if TTS fails */ }

  // Record answer
  qStateEl.textContent = '● Listening...';
  qStateEl.className   = 'q-state listening';

  let transcript = '';
  try {
    transcript = await window.onboarding.listen(12);
  } catch { transcript = ''; }

  if (transcript.trim()) {
    qStateEl.textContent  = 'Answer captured';
    qStateEl.className    = 'q-state done';
    qTransEl.textContent  = `"${transcript.trim()}"`;
    answers[index] = { question: q, answer: transcript.trim() };
    btnNext.disabled          = false;
    btnRerecord.style.display = 'inline-block';
  } else {
    qStateEl.textContent = 'Nothing captured — skip or re-record';
    qStateEl.className   = 'q-state';
    answers[index]       = { question: q, answer: '' };
    btnNext.disabled         = false;
    btnRerecord.style.display = 'inline-block';
  }
}

document.getElementById('btn-rerecord')!.addEventListener('click', () => {
  void askQuestion(currentQ);
});

document.getElementById('btn-next-q')!.addEventListener('click', async () => {
  if (currentQ < QUESTIONS.length - 1) {
    void askQuestion(currentQ + 1);
  } else {
    await completedInterview();
  }
});

async function completedInterview(): Promise<void> {
  await window.onboarding.saveAnswers(answers);
  goTo(5);
  startDoneScreen();
}

// ── Screen 5: Done ────────────────────────────────────────────────────────────

const wave5Canvas = document.getElementById('wave5') as HTMLCanvasElement;
const wave5Energy = makeEnergyBuf();
let   wave5Frame  = 0;
let   wave5State: 'idle' | 'speaking' = 'idle';

(function animateWave5() {
  wave5Frame++;
  tickEnergy(wave5Energy, wave5Frame, wave5State);
  if (currentScreen === 5) drawWave(wave5Canvas, wave5Energy, wave5Frame, wave5State);
  requestAnimationFrame(animateWave5);
})();

function startDoneScreen(): void {
  wave5State = 'speaking';
  window.onboarding.speak("I'm ready. Let's build something.").finally(() => {
    wave5State = 'idle';
  });
  setTimeout(async () => {
    await window.onboarding.complete();
  }, 3500);
}

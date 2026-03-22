import { transcribe } from './whisperService';

type StateCallback = (state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent') => void;

let stopFlag = false;

// ── Wake-word detection ───────────────────────────────────────────────────────
// Fuzzy matching covers common mishearings of "hey axon" by Windows SR:
//   "action"  — SR mishears the 'x' as 'ction'
//   "ax on"   — SR splits the word
//   "Jackson" — SR maps the sound to a known name

const WAKE_PATTERNS = [
  'axon',
  'hey ax',
  'action',
  'ax on',
  'jackson',
];

function isWakeWord(transcript: string): boolean {
  // Confidence filter: ignore noise artifacts shorter than 3 characters
  if (transcript.trim().length < 3) return false;

  const t = transcript.toLowerCase();
  return WAKE_PATTERNS.some(p => t.includes(p));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startVoiceListener(
  onWakeWord:  () => void,
  setOrbState: StateCallback,
): void {
  stopFlag = false;
  loop(onWakeWord, setOrbState);
}

export function stopVoiceListener(): void {
  stopFlag = true;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function loop(onWakeWord: () => void, setOrbState: StateCallback): Promise<void> {
  console.log('[VoiceListener] wake-word loop started (Whisper)');

  while (!stopFlag) {
    try {
      // 4-second chunks — short enough to feel responsive for wake-word detection
      const transcript = await transcribe(4);

      if (!transcript) continue;
      console.log('[VoiceListener] heard:', transcript);

      if (isWakeWord(transcript) && !stopFlag) {
        console.log('[VoiceListener] WAKE WORD DETECTED:', transcript);
        onWakeWord();
        // Pause the wake-word loop while the conversation is active
        await new Promise<void>(r => setTimeout(r, 30_000));
      }
    } catch (e) {
      console.warn('[VoiceListener] error:', e);
      await new Promise<void>(r => setTimeout(r, 2000));
    }
  }

  console.log('[VoiceListener] loop stopped');
}

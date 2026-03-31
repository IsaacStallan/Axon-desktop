import { spawn, exec } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { transcribeFile } from '../utils/transcribeFile';

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

// Silence threshold for the SoX silence effect, expressed as a percentage of
// maximum amplitude (e.g. "2%").  Values that are too low will trigger on
// background noise; values that are too high will clip quiet speech.
// Run `npx ts-node src/utils/calibrate.ts` to measure your mic's noise floor
// and get a personalised recommendation.
const SILENCE_THRESHOLD = process.env.AXON_SILENCE_THRESHOLD ?? '2%';

// Hard upper bound on recording length.  SoX is force-killed when this is
// reached so the audio device is never held open indefinitely.
const MAX_RECORD_SECS = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

type StateCallback = (state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent') => void;

// ── Module state ──────────────────────────────────────────────────────────────

let stopFlag = false;
let currentSoxPid: number | undefined;

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

// Phrases Whisper generates when there is silence or background noise
// rather than real speech.  Filtering these out prevents phantom wake-words.
const HALLUCINATION_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'subscribe',
  'beadaholique',
  'fema.gov',
  'zeoranger',
  'subs by',
  'for more information visit',
  'www.',
  '.com',
  '.gov',
  '.co.uk',
];

function isHallucination(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return HALLUCINATION_PHRASES.some(h => lower.includes(h));
}

function isJunk(transcript: string): boolean {
  if (isHallucination(transcript)) return true;
  // Single-word transcripts are almost always noise or mis-fires
  if (transcript.trim().split(/\s+/).length < 2) return true;
  return false;
}

function isWakeWord(transcript: string): boolean {
  // Confidence filter: ignore noise artifacts shorter than 3 characters
  if (transcript.trim().length < 3) return false;

  const t = transcript.toLowerCase();
  return WAKE_PATTERNS.some(p => t.includes(p));
}

// ── SoX process management ────────────────────────────────────────────────────

function killListenerRecording(): void {
  if (!currentSoxPid) return;
  const pid = currentSoxPid;
  currentSoxPid = undefined;
  console.log(`[VoiceListener] killing SoX PID ${pid}`);
  // taskkill /F /T kills the process and its entire child tree on Windows
  exec(`taskkill /F /T /PID ${pid}`, () => {});
}

// ── Silence-detected recording ────────────────────────────────────────────────

/**
 * Records audio into a temp WAV file using the SoX silence effect.
 *
 * SoX starts writing once audio exceeds SILENCE_THRESHOLD for 0.3 s, and
 * stops once audio falls back below SILENCE_THRESHOLD for 1.5 s.  A watchdog
 * timer force-kills SoX after MAX_RECORD_SECS so the device is never blocked
 * if the speaker doesn't pause naturally (e.g. continuous ambient sound).
 *
 * Returns the path to the recorded WAV file.  The caller is responsible for
 * deleting it after transcription.
 */
function recordUntilSilence(): Promise<string> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `axon_${Date.now()}.wav`);

    const proc = spawn(
      SOX_PATH,
      [
        '-t', 'waveaudio', 'default',
        '-r', '16000',
        '-c', '1',
        '-b', '16',
        outPath,
        // Group 1: begin recording once audio exceeds threshold for 0.3 s
        // Group 2: stop recording once audio drops below threshold for 1.5 s
        'silence', '1', '0.3', SILENCE_THRESHOLD,
                   '1', '1.5', SILENCE_THRESHOLD,
      ],
      { shell: false },
    );

    currentSoxPid = proc.pid;

    // Watchdog: force-stop the recording if silence detection never fires
    const watchdog = setTimeout(() => {
      console.log('[VoiceListener] max duration reached — stopping recording');
      killListenerRecording();
    }, MAX_RECORD_SECS * 1000);

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (currentSoxPid === proc.pid) currentSoxPid = undefined;

      const errText = Buffer.concat(stderrChunks).toString().trim();
      if (errText) console.warn('[VoiceListener] SoX stderr:', errText);

      // null = process was killed (watchdog or stopVoiceListener) — treat as
      // normal end so we still attempt to transcribe whatever was captured.
      if (code !== 0 && code !== null) {
        reject(new Error(`SoX exited with code ${code}`));
        return;
      }

      try {
        const stats = fs.statSync(outPath);
        console.log('[VoiceListener] recorded file size:', stats.size, 'bytes');
        resolve(outPath);
      } catch {
        reject(new Error('SoX output file missing'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(watchdog);
      if (currentSoxPid === proc.pid) currentSoxPid = undefined;
      reject(err);
    });
  });
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
  // Kill the currently running SoX recording immediately so the audio device
  // is released before the conversation's own SoX tries to open it.
  killListenerRecording();
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function loop(onWakeWord: () => void, setOrbState: StateCallback): Promise<void> {
  console.log('[VoiceListener] wake-word loop started (Whisper + silence detection)');
  console.log(`[VoiceListener] silence threshold: ${SILENCE_THRESHOLD}, max duration: ${MAX_RECORD_SECS}s`);

  while (!stopFlag) {
    try {
      const filePath = await recordUntilSilence();

      let transcript = '';
      try {
        transcript = await transcribeFile(filePath);
      } finally {
        fs.unlink(filePath, () => {}); // always clean up temp file
      }

      if (!transcript) continue;
      console.log('[VoiceListener] heard:', transcript);

      if (isJunk(transcript)) {
        console.log('[VoiceListener] junk/hallucination — skipping');
        continue;
      }

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

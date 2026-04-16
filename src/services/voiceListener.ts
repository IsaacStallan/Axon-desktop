import OpenAI from 'openai';
import { spawn, exec } from 'child_process';
import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setPendingUtterance } from '../utils/utteranceQueue';

console.log('[VoiceListener] module loaded');

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH           = process.env.SOX_PATH ?? (process.platform === 'darwin' ? 'sox' : 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe');
const SAMPLE_RATE        = 24000;
const WINDOW_MS          = 3000;                          // transcription window (ms)
const WINDOW_BYTES       = SAMPLE_RATE * 2 * (WINDOW_MS / 1000);  // PCM16 bytes per window
const SPEECH_RMS_MIN     = 500;                           // skip Whisper if RMS below this

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// ── Types ─────────────────────────────────────────────────────────────────────

type StateCallback = (state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent') => void;

// ── Module state ──────────────────────────────────────────────────────────────

let stopFlag         = false;
let sessionGen       = 0;          // incremented on every start; old sessions self-abort
let activeSoxPid:    number | undefined;
let orbWin:          BrowserWindow | null = null;
let rendererMicReady = false;

ipcMain.on('mic:ready', () => {
  rendererMicReady = true;
  console.log('[VoiceListener] renderer mic ready');
});

export function setOrbWindow(win: BrowserWindow): void {
  orbWin = win;
}

// ── Wake-word patterns ────────────────────────────────────────────────────────

// Dynamic custom wake word (from .env or updated at runtime)
let customWakeWord: string | null = process.env.AXON_WAKE_WORD?.toLowerCase().trim() ?? null;

const BASE_WAKE_VARIATIONS = ['hey axon', 'axon', 'hey ax', 'okay axon', 'action', 'ax on', 'jackson'];

function getWakeVariations(): string[] {
  if (customWakeWord && !BASE_WAKE_VARIATIONS.includes(customWakeWord)) {
    return [customWakeWord, ...BASE_WAKE_VARIATIONS];
  }
  return BASE_WAKE_VARIATIONS;
}

export function updateWakeWord(word: string): void {
  customWakeWord = word.toLowerCase().trim();
  console.log(`[VoiceListener] wake word updated to: "${customWakeWord}"`);
}

function isWakeWord(transcript: string): boolean {
  if (transcript.trim().length < 2) return false;
  const t = transcript.toLowerCase().replace(/[^\w\s]/g, ' ');
  return getWakeVariations().some(p => t.includes(p));
}

function extractCommandAfterWakeWord(transcript: string): string {
  const lower = transcript.toLowerCase().replace(/[^\w\s]/g, ' ');
  for (const pattern of getWakeVariations()) {
    const idx = lower.indexOf(pattern);
    if (idx !== -1) {
      return transcript.slice(idx + pattern.length).replace(/^[\s,]+/, '').trim();
    }
  }
  return '';
}

// ── Directed speech confidence scoring ───────────────────────────────────────

const QUESTION_WORDS = /\b(what|how|when|where|why|can|could|should|will|do|is|are)\b/i;
const COMMAND_VERBS  = /\b(play|open|search|tell|show|find|help|stop|set|need|wake)\b/i;
const HALLUCINATION_PATTERNS = [
  'thank you', 'thanks', 'bye bye', 'goodbye', 'see you',
  "you're welcome", 'welcome back', 'have a great day',
];

/**
 * Returns a confidence score [0–1] that the transcript is genuine directed
 * speech intended for Axon, not accidental noise or a hallucination.
 *
 * Scoring:
 *   auto  short phrase (≤8 words) containing wake word → 0.7
 *   +0.5  contains "axon" or the custom wake word
 *   +0.25 contains a question word
 *   +0.25 contains a direct command verb
 *   +0.15 transcript is over 3 words
 *   -0.2  under 3 words total
 *   -0.8  matches a known hallucination pattern
 */
function scoreDirectedSpeech(transcript: string): number {
  const lower     = transcript.toLowerCase();
  const words     = transcript.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const wakeWord  = customWakeWord ?? 'axon';

  // Short phrases containing the wake word are almost always directed at Axon
  if (wordCount <= 8 && (lower.includes('axon') || lower.includes(wakeWord))) {
    return 0.7;
  }

  let score = 0;

  if (lower.includes('axon') || lower.includes(wakeWord))                      score += 0.5;
  if (/\?|what|how|when|where|why|can|could|should|will|do |is |are /.test(lower)) score += 0.25;
  if (/play|open|search|tell|show|find|help|stop|set|wake|need|hey/.test(lower))   score += 0.25;
  if (wordCount > 3)                                                            score += 0.15;
  if (wordCount < 3)                                                            score -= 0.2;
  if (HALLUCINATION_PATTERNS.some(p => lower.includes(p)))                     score -= 0.8;

  return Math.max(0, Math.min(1, score));
}

const CONFIDENCE_THRESHOLD = 0.45;

// ── Sleep-word detection ──────────────────────────────────────────────────────

const SLEEP_WORDS = [
  'stop', 'sleep', 'bye', 'goodbye', 'cancel',
  'never mind', 'go to sleep', 'stop listening',
];

export function isSleepWord(transcript: string): boolean {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount >= 10) return false;
  const t = transcript.toLowerCase().replace(/[^\w\s]/g, ' ');
  return SLEEP_WORDS.some(s => t.includes(s));
}

// ── SoX management ────────────────────────────────────────────────────────────

function killSox(pid: number | undefined): void {
  if (!pid) return;
  if (activeSoxPid === pid) activeSoxPid = undefined;
  if (process.platform === 'darwin') {
    exec(`kill -9 ${pid}`, () => {});
  } else {
    exec(`taskkill /F /T /PID ${pid}`, () => {});
  }
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

/** Build a WAV file from raw PCM16LE mono audio at SAMPLE_RATE. */
function buildWav(pcm: Buffer): Buffer {
  const channels   = 1;
  const bitDepth   = 16;
  const byteRate   = SAMPLE_RATE * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF',  0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE',  8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16,          16);
  header.writeUInt16LE(1,           20);
  header.writeUInt16LE(channels,    22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate,    28);
  header.writeUInt16LE(blockAlign,  32);
  header.writeUInt16LE(bitDepth,    34);
  header.write('data',             36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Returns true if the PCM buffer contains audio above the speech threshold. */
function hasSpeech(pcm: Buffer): boolean {
  if (pcm.length < 2) return false;
  let sumSq = 0;
  const samples = pcm.length >> 1;  // 2 bytes per sample
  for (let i = 0; i < pcm.length - 1; i += 2) {
    const s = pcm.readInt16LE(i);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples);
  return rms > SPEECH_RMS_MIN;
}

/** Submit a PCM buffer to Whisper REST API; returns '' on any failure. */
async function transcribeBuffer(pcm: Buffer): Promise<string> {
  if (pcm.length < 1000) return '';

  const wav     = buildWav(pcm);
  const tmpPath = path.join(os.tmpdir(), `axon-wake-${Date.now()}.wav`);

  try {
    fs.writeFileSync(tmpPath, wav);
    const wakeHint = customWakeWord ? `${customWakeWord}, Axon, hey Axon` : 'Axon, hey Axon, action';
    const response = await client.audio.transcriptions.create({
      file:   fs.createReadStream(tmpPath),
      model:  'whisper-1',
      prompt: wakeHint,  // bias towards wake word, reduces hallucinations
    });
    return response.text.trim();
  } catch (e) {
    console.warn('[VoiceListener] Whisper REST error:', e);
    return '';
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startVoiceListener(
  onWakeWord:  () => void,
  setOrbState: StateCallback,
): void {
  stopFlag = false;
  const gen = ++sessionGen;
  void sessionLoop(onWakeWord, setOrbState, gen);
}

export function stopVoiceListener(): void {
  stopFlag = true;
  killSox(activeSoxPid);
  // Immediately stop the renderer mic — don't wait up to WINDOW_MS for the
  // timer to fire.  This prevents the renderer from sending stale audio into
  // the next session after a sleep/wake cycle.
  if (orbWin && !orbWin.isDestroyed()) {
    orbWin.webContents.send('mic:stop');
  }
}

// ── Session loop (reconnects on errors) ───────────────────────────────────────

async function sessionLoop(
  onWakeWord:  () => void,
  setOrbState: StateCallback,
  gen:         number,
): Promise<void> {
  console.log(`[VoiceListener] wake-word loop started (gen ${gen})`);

  while (!stopFlag && gen === sessionGen) {
    try {
      if (process.platform === 'darwin') {
        await runMacSession(onWakeWord, gen);
      } else {
        await runWindowsSession(onWakeWord);
      }
    } catch (e) {
      if (stopFlag || gen !== sessionGen) break;
      console.warn('[VoiceListener] session error — reconnecting in 2 s:', e);
      await sleep(2000);
    }
  }

  console.log(`[VoiceListener] loop stopped (gen ${gen})`);
}

// ── macOS session: IPC mic → periodic Whisper chunks ─────────────────────────

function runMacSession(onWakeWord: () => void, gen: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!orbWin || orbWin.isDestroyed()) {
      return reject(new Error('[VoiceListener] orbWindow not set'));
    }

    const audioChunks: Buffer[] = [];
    let settled        = false;
    let checkTimer:    NodeJS.Timeout | undefined;
    let isTranscribing = false;

    function cleanup(): void {
      if (checkTimer) { clearInterval(checkTimer); checkTimer = undefined; }
      ipcMain.removeListener('mic:chunk', chunkHandler);
      ipcMain.removeListener('mic:error', errorHandler);
      ipcMain.removeListener('mic:ready', sendMicStart);
      if (orbWin && !orbWin.isDestroyed()) {
        orbWin.webContents.send('mic:stop');
      }
    }

    function settle(fn: () => void): void {
      if (!settled) { settled = true; cleanup(); fn(); }
    }

    const chunkHandler = (_e: unknown, data: unknown) => {
      if (stopFlag || gen !== sessionGen) return;
      audioChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array));
    };

    const errorHandler = (_e: unknown, msg: string) => {
      console.warn('[VoiceListener] renderer mic error:', msg);
      settle(() => reject(new Error(`mic error: ${msg}`)));
    };

    ipcMain.on('mic:chunk', chunkHandler);
    ipcMain.on('mic:error', errorHandler);

    const sendMicStart = () => {
      if (orbWin && !orbWin.isDestroyed()) {
        orbWin.webContents.send('mic:start');
        console.log(`[VoiceListener] renderer ready — sent mic:start (gen ${gen})`);
      }
    };

    if (rendererMicReady) {
      sendMicStart();
    } else {
      console.log('[VoiceListener] waiting for mic:ready from renderer...');
      ipcMain.once('mic:ready', sendMicStart);
    }

    // Every WINDOW_MS, take the accumulated audio, run VAD + Whisper
    checkTimer = setInterval(async () => {
      if (stopFlag || gen !== sessionGen) { settle(() => resolve()); return; }
      if (isTranscribing || audioChunks.length === 0) return;

      // Need at least ~half a window of data before attempting transcription
      const totalBytes = audioChunks.reduce((s, c) => s + c.length, 0);
      if (totalBytes < WINDOW_BYTES / 2) return;

      isTranscribing = true;
      const pcm = Buffer.concat(audioChunks.splice(0));  // take all, clear array

      if (!hasSpeech(pcm)) {
        isTranscribing = false;
        return;
      }

      try {
        const transcript = await transcribeBuffer(pcm);
        if (transcript) {
          console.log('[VoiceListener] heard:', transcript);
        }

        if (!stopFlag && gen === sessionGen && isSleepWord(transcript)) {
          console.log(`[VoiceListener] sleep word detected: "${transcript}" — returning to idle`);
          stopFlag = true;
          settle(() => resolve());
        } else if (!stopFlag && gen === sessionGen && isWakeWord(transcript)) {
          const confidence = scoreDirectedSpeech(transcript);
          const decision   = confidence >= CONFIDENCE_THRESHOLD ? 'triggered' : 'ignored';
          console.log(`[VoiceListener] directed speech confidence: ${confidence.toFixed(2)} — ${decision} (${transcript})`);

          if (confidence >= CONFIDENCE_THRESHOLD) {
            console.log('[VoiceListener] WAKE WORD DETECTED:', transcript);

            const command = extractCommandAfterWakeWord(transcript);
            if (command.length > 3) {
              console.log('[VoiceListener] queuing post-wake command:', command);
              setPendingUtterance(command);
            }

            stopFlag = true;
            onWakeWord();
            settle(() => resolve());
          }
        }
      } catch (e) {
        console.warn('[VoiceListener] transcription error:', e);
      } finally {
        isTranscribing = false;
      }
    }, WINDOW_MS);
  });
}

// ── Windows session: SoX chunk loop ──────────────────────────────────────────

async function runWindowsSession(onWakeWord: () => void): Promise<void> {
  console.log('[VoiceListener] Windows SoX chunk loop starting');

  while (!stopFlag) {
    let pcm: Buffer;
    try {
      pcm = await recordSoxChunk(WINDOW_MS / 1000);
    } catch (e) {
      if (stopFlag) break;
      console.warn('[VoiceListener] SoX record error:', e);
      await sleep(1000);
      continue;
    }

    if (stopFlag) break;
    if (!hasSpeech(pcm)) continue;

    const transcript = await transcribeBuffer(pcm);
    if (!transcript) continue;

    console.log('[VoiceListener] heard:', transcript);

    if (isSleepWord(transcript)) {
      console.log(`[VoiceListener] sleep word detected: "${transcript}" — returning to idle`);
      stopFlag = true;
      return;
    }

    if (isWakeWord(transcript)) {
      const confidence = scoreDirectedSpeech(transcript);
      const decision   = confidence >= CONFIDENCE_THRESHOLD ? 'triggered' : 'ignored';
      console.log(`[VoiceListener] directed speech confidence: ${confidence.toFixed(2)} — ${decision} (${transcript})`);

      if (confidence >= CONFIDENCE_THRESHOLD) {
        console.log('[VoiceListener] WAKE WORD DETECTED:', transcript);

        const command = extractCommandAfterWakeWord(transcript);
        if (command.length > 3) {
          console.log('[VoiceListener] queuing post-wake command:', command);
          setPendingUtterance(command);
        }

        stopFlag = true;
        onWakeWord();
        return;
      }
    }
  }
}

/** Record `secs` seconds of raw PCM16 audio from the default input device. */
function recordSoxChunk(secs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const soxArgs = process.platform === 'win32'
      ? ['-t', 'waveaudio', 'default', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-']
      : ['-d', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', 'vol', '0.5', '-t', 'raw', '-'];

    console.log('[VoiceListener] spawning SoX with args:', JSON.stringify(soxArgs));
    const sox = spawn(SOX_PATH, soxArgs, { shell: false });

    activeSoxPid = sox.pid;
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => {
      if (activeSoxPid === sox.pid) killSox(activeSoxPid);
    }, secs * 1000);

    sox.stdout?.on('data', (c: Buffer) => chunks.push(c));
    sox.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) console.warn('[VoiceListener] SoX:', msg);
    });
    sox.on('close', () => {
      clearTimeout(timer);
      if (activeSoxPid === sox.pid) activeSoxPid = undefined;
      resolve(Buffer.concat(chunks));
    });
    sox.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

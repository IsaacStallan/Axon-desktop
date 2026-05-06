import axios from 'axios';
import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserWindow } from 'electron';
import * as homeAssistant from './homeAssistant';

// ── Connection pre-warm ───────────────────────────────────────────────────────

export async function prewarmElevenLabs(): Promise<void> {
  if (!process.env.ELEVENLABS_API_KEY) return;
  try {
    await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    console.log('[ElevenLabs] connection pre-warmed');
  } catch { /* ignore — startup is not blocked by this */ }
}

const API_KEY  = process.env.ELEVENLABS_API_KEY  ?? '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '';

let orbWin: BrowserWindow | null = null;
export function setOrbWindow(win: BrowserWindow): void { orbWin = win; }

// ── AirPods / audio device detection ─────────────────────────────────────────

function getActiveAudioDevice(): string {
  if (process.platform !== 'darwin') return '';
  try {
    const result = execSync(
      'SwitchAudioSource -c 2>/dev/null || system_profiler SPAudioDataType 2>/dev/null | grep "Default Output" | head -1',
      { encoding: 'utf8', timeout: 2_000 },
    ).trim();
    return result.toLowerCase();
  } catch { return ''; }
}

export function isAirPodsConnected(): boolean {
  const device = getActiveAudioDevice();
  return device.includes('airpods') || device.includes('airpod') || device.includes('beats');
}

export function getPreferredOutputDevice(): 'airpods' | 'mac_speakers' | 'external' {
  const device = getActiveAudioDevice();
  if (device.includes('airpods') || device.includes('airpod')) return 'airpods';
  if (device.includes('external') || device.includes('hdmi'))  return 'external';
  return 'mac_speakers';
}

// Windows only — macOS uses afplay (built-in)
const SOX_PATH      = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';
const SOX_AUDIO_OUT = 'waveaudio';

const SAMPLE_RATE = 22050;
const TMP_FILE    = join(tmpdir(), 'axon_tts.wav');

export let isSpeaking = false;

// ── Interrupt state ───────────────────────────────────────────────────────────

let currentPlayback:  { kill: () => void } | null = null;
let interruptedText:  string | null = null;
let speakInterrupted: boolean = false;

/** Store the full text currently being spoken (called before each speak()). */
export function setCurrentSpeechText(text: string): void {
  interruptedText = text;
}

/**
 * Immediately kill current TTS playback.
 * Returns the text that was being spoken so callers can save it as context.
 * Returns null if nothing was playing.
 */
export function interruptSpeech(): string | null {
  speakInterrupted = true;
  if (currentPlayback) {
    currentPlayback.kill();
    currentPlayback = null;
  }
  const wasSaying = interruptedText;
  interruptedText  = null;
  return wasSaying;
}

// ── Streaming TTS queue ───────────────────────────────────────────────────────
// Sentences generated from Claude streaming are enqueued here and played
// sequentially. Non-blocking from the caller's perspective.

let speakQueue: Promise<void> = Promise.resolve();

/**
 * Enqueue a text segment for immediate TTS. Returns immediately; audio plays
 * in the background via the shared promise chain so segments never overlap.
 */
export function speakStreaming(text: string): void {
  if (!text.trim()) return;
  speakQueue = speakQueue
    .then(async () => {
      if (speakInterrupted) return;
      const sanitised = sanitiseForTTS(text);
      if (!sanitised.trim()) return;
      // Flip orb state on the first chunk of a streaming response
      if (!isSpeaking) {
        isSpeaking = true;
        orbWin?.webContents.send('orb:state', 'speaking');
      }
      await speakChunk(sanitised);
    })
    .catch(e => {
      if (!speakInterrupted) console.warn('[ElevenLabs] speakStreaming error:', e);
    });
}

/** Resolves when all currently-queued speech has finished playing, then resets isSpeaking. */
export function waitForSpeakQueue(): Promise<void> {
  return speakQueue.then(() => { isSpeaking = false; });
}

/**
 * Clear the queue and reset isSpeaking immediately.
 * Call this on interrupt so pending sentences don't play after the kill.
 */
export function resetSpeakQueue(): void {
  speakQueue = Promise.resolve();
}

// Build a minimal 44-byte WAV header for 16-bit mono PCM
function buildWavHeader(dataByteLength: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataByteLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);               // PCM chunk size
  h.writeUInt16LE(1, 20);                // format: PCM
  h.writeUInt16LE(1, 22);                // channels: mono
  h.writeUInt32LE(SAMPLE_RATE, 24);      // sample rate
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);  // byte rate (22050 * 1ch * 2B)
  h.writeUInt16LE(2, 32);                // block align
  h.writeUInt16LE(16, 34);               // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataByteLength, 40);
  return h;
}

// ── Symbol sanitisation ───────────────────────────────────────────────────────

/** Remove/replace symbols Claude commonly produces before sending to TTS. */
function sanitiseForTTS(text: string): string {
  return text
    .replace(/—/g, ', ')                           // em dash → pause
    .replace(/–/g, ', ')                           // en dash → pause
    .replace(/\*\*(.*?)\*\*/g, '$1')               // bold markdown → plain
    .replace(/\*(.*?)\*/g, '$1')                   // italic markdown → plain
    .replace(/`(.*?)`/g, '$1')                     // inline code → plain
    .replace(/```[\s\S]*?```/g, '')                // code blocks → remove
    .replace(/#{1,6}\s/g, '')                      // markdown headers → remove
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // links → just text
    .replace(/[•·]/g, ', ')                        // bullets → pause
    .replace(/\n{2,}/g, '. ')                      // double newlines → sentence break
    .replace(/\n/g, ' ')                           // single newlines → space
    .trim();
}

// ── Sentence-boundary splitting ───────────────────────────────────────────────

/** Split text into chunks no larger than maxChars, breaking at sentence ends. */
function splitOnSentences(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length > 0 && (current + sentence).length > maxChars) {
      chunks.push(current.trimEnd());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text];
}

// ── Single-chunk TTS call + playback ─────────────────────────────────────────

async function speakChunk(text: string): Promise<void> {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=pcm_22050`,
    {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
    },
    {
      headers: {
        'xi-api-key':   API_KEY,
        'Content-Type': 'application/json',
        Accept:         'audio/pcm',
      },
      responseType: 'arraybuffer',
    },
  );

  if (response.status !== 200) {
    console.warn('[ElevenLabs] API error status:', response.status);
    return;
  }

  const pcmData = Buffer.from(response.data as ArrayBuffer);
  console.log('[ElevenLabs] received', pcmData.byteLength, 'bytes');

  if (pcmData.byteLength < 200) {
    console.warn('[ElevenLabs] suspiciously small response:', pcmData.toString('utf8', 0, Math.min(300, pcmData.byteLength)));
    return;
  }

  const wav = Buffer.concat([buildWavHeader(pcmData.byteLength), pcmData]);
  writeFileSync(TMP_FILE, wav);

  // Fire-and-forget HA broadcast so local playback is not blocked
  if (process.env.AXON_CORE_MODE === 'true' && process.env.HOME_ASSISTANT_URL) {
    const speakers = homeAssistant.getConfiguredSpeakers();
    if (speakers.length > 0) {
      const roomName = isAirPodsConnected() ? 'living_room' : 'office';
      const haTarget = speakers.find(s => s.room === roomName) ?? speakers[0];
      homeAssistant.speakWithElevenLabsOnSpeaker(haTarget, wav)
        .catch(e => console.error('[ElevenLabs] HA broadcast failed:', e));
    }
  }

  await new Promise<void>((resolve) => {
    const airpods = process.env.AXON_CORE_MODE === 'true' && isAirPodsConnected();
    const volume  = airpods ? '0.85' : '1.0';
    const [playerPath, playerArgs]: [string, string[]] =
      process.platform === 'darwin'
        ? ['afplay', ['-v', volume, TMP_FILE]]
        : [SOX_PATH, ['-t', 'wav', TMP_FILE, '-t', SOX_AUDIO_OUT, 'default']];

    const player = spawn(playerPath, playerArgs, { shell: false });

    // Track for interrupt
    currentPlayback = { kill: () => player.kill() };

    const timer = setTimeout(() => {
      console.warn('[ElevenLabs] playback hard cap — killing player');
      player.kill();
      resolve();
    }, 60_000);

    player.on('close', (code) => {
      clearTimeout(timer);
      currentPlayback = null;
      if (code !== 0 && code !== null && !speakInterrupted) {
        console.warn('[ElevenLabs] player exited with code:', code);
      }
      resolve();
    });

    player.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[ElevenLabs] player error:', err.message);
      resolve();
    });

    const stderrBuf: Buffer[] = [];
    player.stderr?.on('data', (b: Buffer) => stderrBuf.push(b));
    player.on('close', () => {
      if (speakInterrupted) return; // suppress noise from intentional kill
      const msg = Buffer.concat(stderrBuf).toString().trim();
      if (msg) console.warn('[ElevenLabs] player stderr:', msg);
    });
  });

  try { unlinkSync(TMP_FILE); } catch { /* ignore cleanup errors */ }
}

// ── Single-file audio playback ────────────────────────────────────────────────

async function playAudioFile(filePath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const airpods = process.env.AXON_CORE_MODE === 'true' && isAirPodsConnected();
    const volume  = airpods ? '0.85' : '1.0';

    const [playerPath, playerArgs]: [string, string[]] =
      process.platform === 'darwin'
        ? ['afplay', ['-v', volume, filePath]]
        : [SOX_PATH, ['-t', 'mp3', filePath, '-t', SOX_AUDIO_OUT, 'default']];

    const player = spawn(playerPath, playerArgs, { shell: false });
    currentPlayback = { kill: () => player.kill() };

    const timer = setTimeout(() => {
      console.warn('[ElevenLabs] playback hard cap — killing player');
      player.kill();
      resolve();
    }, 60_000);

    player.on('close', (code) => {
      clearTimeout(timer);
      currentPlayback = null;
      if (code !== 0 && code !== null && !speakInterrupted) {
        console.warn('[ElevenLabs] player exited with code:', code);
      }
      resolve();
    });

    player.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[ElevenLabs] player error:', err.message);
      resolve();
    });
  });
}

// ── Public speak() — single API call → one MP3 → one playback ────────────────
// Sends the full sanitised text as one request so there are no inter-chunk gaps.

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 80));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  speakInterrupted = false;
  setCurrentSpeechText(text);

  const sanitised = sanitiseForTTS(text);
  if (!sanitised.trim()) return;

  isSpeaking = true;
  orbWin?.webContents.send('orb:state', 'speaking');

  const tempFile = join(tmpdir(), `axon_speech_${Date.now()}.mp3`);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
        method:  'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:          sanitised,
          model_id:      'eleven_turbo_v2_5',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
        }),
      },
    );

    if (!response.ok) {
      console.warn('[ElevenLabs] API error:', response.status);
      return;
    }

    // Collect all streaming chunks into one contiguous buffer before playing
    const parts: Buffer[] = [];
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(Buffer.from(value));
    }

    const audioBuffer = Buffer.concat(parts);
    console.log('[ElevenLabs] received', audioBuffer.byteLength, 'bytes');

    if (audioBuffer.byteLength < 200) {
      console.warn('[ElevenLabs] suspiciously small response — skipping playback');
      return;
    }

    writeFileSync(tempFile, audioBuffer);

    // HA broadcast (fire-and-forget, Core mode only)
    if (process.env.AXON_CORE_MODE === 'true' && process.env.HOME_ASSISTANT_URL) {
      const speakers = homeAssistant.getConfiguredSpeakers();
      if (speakers.length > 0) {
        const roomName = isAirPodsConnected() ? 'living_room' : 'office';
        const haTarget = speakers.find(s => s.room === roomName) ?? speakers[0];
        homeAssistant.speakWithElevenLabsOnSpeaker(haTarget, audioBuffer)
          .catch(e => console.error('[ElevenLabs] HA broadcast failed:', e));
      }
    }

    if (!speakInterrupted) {
      await playAudioFile(tempFile);
    }
  } catch (e) {
    if (!speakInterrupted) console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
    if (!speakInterrupted) {
      orbWin?.webContents.send('orb:state', 'idle');
    }
    interruptedText  = null;
    speakInterrupted = false;
    try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
  }
}

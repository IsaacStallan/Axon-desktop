import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { spawn } from 'child_process';

const API_KEY  = process.env.ELEVENLABS_API_KEY  ?? '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '';

// SoX plays WAV natively on Windows — no libmad needed (libmad is only for MP3)
const SOX_PATH = 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

// PCM spec from ElevenLabs pcm_22050 format
const SAMPLE_RATE  = 22050;
const CHANNELS     = 1;     // ElevenLabs PCM is always mono
const BITS         = 16;

function ttsCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'tts_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── PCM → WAV conversion ──────────────────────────────────────────────────────
// ElevenLabs pcm_22050 returns raw headerless 16-bit signed LE PCM.
// Prepend a standard 44-byte RIFF/WAV header so SoX can read the file type.

function pcmToWav(pcm: Buffer): Buffer {
  const dataSize   = pcm.length;
  const byteRate   = SAMPLE_RATE * CHANNELS * (BITS / 8);
  const blockAlign = CHANNELS * (BITS / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF',  0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE',  8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16,          16); // fmt chunk size
  header.writeUInt16LE(1,           20); // PCM = 1
  header.writeUInt16LE(CHANNELS,    22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate,    28);
  header.writeUInt16LE(blockAlign,  32);
  header.writeUInt16LE(BITS,        34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize,    40);

  return Buffer.concat([header, pcm]);
}

// ── SoX playback ──────────────────────────────────────────────────────────────
// spawn() gives us a direct process handle — we can kill it cleanly if needed.
// SoX blocks until playback is complete, so the Promise resolves at the right time.

function playWav(wavPath: string, durationSecs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      SOX_PATH,
      [wavPath, '-t', 'waveaudio', 'default'],
      { shell: false },
    );

    // Hard cap: kill SoX if playback takes 3× the expected duration + 10s
    const maxMs  = (durationSecs * 3 + 10) * 1000;
    const timer  = setTimeout(() => {
      console.warn('[ElevenLabs] playback timeout — killing SoX');
      proc.kill();
      resolve(); // don't reject; let the conversation continue
    }, maxMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        // Non-zero exit still resolves — a playback glitch shouldn't freeze the loop
        console.warn(`[ElevenLabs] SoX exited with code ${code}`);
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[ElevenLabs] SoX spawn error:', err.message);
      resolve(); // same — always resolve so the conversation keeps going
    });

    // Log SoX stderr only if it contains something unexpected
    const stderr: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('close', () => {
      const msg = Buffer.concat(stderr).toString().trim();
      if (msg && !msg.startsWith('Input File')) {
        console.warn('[ElevenLabs] SoX stderr:', msg);
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export let isSpeaking = false;

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 60));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  isSpeaking = true;

  try {
    // Request raw PCM audio — ElevenLabs pcm_22050 = 22 050 Hz 16-bit mono PCM
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=pcm_22050`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.5 },
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

    const pcm = Buffer.from(response.data as ArrayBuffer);
    const wav = pcmToWav(pcm);

    const stamp   = Date.now();
    const wavPath = path.join(ttsCacheDir(), `tts_${stamp}.wav`);
    fs.writeFileSync(wavPath, wav);

    // Estimate duration so the SoX hard-cap timeout is proportional
    const durationSecs = pcm.length / (SAMPLE_RATE * CHANNELS * (BITS / 8));
    console.log(`[ElevenLabs] playing ${durationSecs.toFixed(1)}s of audio`);

    await playWav(wavPath, durationSecs);

    fs.unlink(wavPath, () => {});
  } catch (e) {
    console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
  }
}

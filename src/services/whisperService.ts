import { exec } from 'child_process';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { toFile } from 'openai';

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH = 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// ── Record a WAV chunk via SoX directly ──────────────────────────────────────
// Drives SoX as a child process so it owns the audio device and writes a
// well-formed WAV file itself — avoids the broken-header issue that comes from
// piping raw PCM through node-record-lpcm16.
//
// SoX flags:
//   -t waveaudio default   Windows audio input (default device)
//   -r 16000               sample rate Whisper prefers
//   -c 1                   mono
//   -b 16                  16-bit PCM
//   trim 0 <secs>          record for exactly <secs> seconds then stop

function recordChunk(durationSecs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `axon_${Date.now()}.wav`);
    const cmd     = `"${SOX_PATH}" -t waveaudio default -r 16000 -c 1 -b 16 "${outPath}" trim 0 ${durationSecs}`;

    exec(cmd, { timeout: (durationSecs + 5) * 1000 }, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Debug: log file size so we can tell immediately if SoX recorded anything
      try {
        const stats = fs.statSync(outPath);
        console.log('[Whisper] recorded file size:', stats.size, 'bytes');
      } catch {
        console.warn('[Whisper] could not stat output file:', outPath);
      }

      resolve(outPath);
    });
  });
}

// ── Transcribe via Whisper ────────────────────────────────────────────────────

export async function transcribe(durationSecs = 4): Promise<string> {
  console.log('[Whisper] recording...');

  try {
    const filePath = await recordChunk(durationSecs);

    let result = '';
    try {
      const buffer   = fs.readFileSync(filePath);
      const file     = await toFile(buffer, 'audio.wav', { type: 'audio/wav' });

      const response = await openai.audio.transcriptions.create({
        file,
        model:    'whisper-1',
        language: 'en',
      });

      result = response.text.trim();
      console.log('[Whisper] transcript:', result);
    } finally {
      fs.unlink(filePath, () => {}); // always clean up temp file
    }

    return result;
  } catch (e) {
    console.warn('[Whisper] error:', e);
    return '';
  }
}

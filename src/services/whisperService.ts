import { spawn, exec } from 'child_process';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { toFile } from 'openai';

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH = 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// ── SoX process tracking ──────────────────────────────────────────────────────
// We use spawn() instead of exec() so we hold a direct reference to the SoX
// process (not a cmd.exe wrapper).  This lets killCurrentRecording() reliably
// terminate SoX and release the audio device via taskkill /F /T.

let currentSoxPid: number | undefined;

/**
 * Kill the currently running SoX recording process immediately.
 * Called by stopVoiceListener() and by transcribeWithTimeout() on timeout,
 * so the audio device is released before the next SoX instance tries to open it.
 */
export function killCurrentRecording(): void {
  if (!currentSoxPid) return;
  const pid = currentSoxPid;
  currentSoxPid = undefined;
  console.log(`[Whisper] killing SoX PID ${pid}`);
  // taskkill /F /T kills the process and its entire child tree on Windows
  exec(`taskkill /F /T /PID ${pid}`, () => {});
}

// ── Record a WAV chunk via SoX directly ──────────────────────────────────────

function recordChunk(durationSecs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `axon_${Date.now()}.wav`);

    // Spawn SoX directly — no cmd.exe shell — so currentSoxPid IS the SoX PID
    const proc = spawn(
      SOX_PATH,
      [
        '-t', 'waveaudio', 'default',
        '-r', '16000',
        '-c', '1',
        '-b', '16',
        outPath,
        'trim', '0', String(durationSecs),
      ],
      { shell: false },
    );

    currentSoxPid = proc.pid;

    // Safety net: if SoX hasn't exited on its own, force-kill it
    const watchdog = setTimeout(() => {
      killCurrentRecording();
      reject(new Error(`SoX timed out after ${durationSecs + 5}s`));
    }, (durationSecs + 5) * 1000);

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (currentSoxPid === proc.pid) currentSoxPid = undefined;

      if (code !== 0 && code !== null) {
        // Non-zero exit — usually means audio device was unavailable
        reject(new Error(`SoX exited with code ${code}`));
        return;
      }

      try {
        const stats = fs.statSync(outPath);
        console.log('[Whisper] recorded file size:', stats.size, 'bytes');
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

    // Collect stderr for debugging without blocking resolution
    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('close', () => {
      const errText = Buffer.concat(stderrChunks).toString().trim();
      if (errText) console.warn('[Whisper] SoX stderr:', errText);
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

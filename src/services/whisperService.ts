import OpenAI from 'openai';
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { popPendingUtterance } from '../utils/utteranceQueue';

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH    = process.env.SOX_PATH ?? (process.platform === 'darwin' ? 'sox' : 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe');
const SAMPLE_RATE = 24000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// ── Process tracking ──────────────────────────────────────────────────────────

let currentSoxPid: number | undefined;

export function killCurrentRecording(): void {
  if (currentSoxPid) {
    const pid     = currentSoxPid;
    currentSoxPid = undefined;
    console.log(`[Whisper] killing SoX PID ${pid}`);
    if (process.platform === 'darwin') {
      exec(`kill -9 ${pid}`, () => {});
    } else {
      exec(`taskkill /F /T /PID ${pid}`, () => {});
    }
  }
}

// ── WAV builder ───────────────────────────────────────────────────────────────

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
  header.writeUInt16LE(1,           20);  // PCM format
  header.writeUInt16LE(channels,    22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate,    28);
  header.writeUInt16LE(blockAlign,  32);
  header.writeUInt16LE(bitDepth,    34);
  header.write('data',             36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// ── Whisper REST transcription ────────────────────────────────────────────────

async function transcribeBuffer(pcm: Buffer): Promise<string> {
  if (pcm.length < 1000) return '';   // too short to contain speech

  const wav     = buildWav(pcm);
  const tmpPath = path.join(os.tmpdir(), `axon-whisper-${Date.now()}.wav`);

  try {
    fs.writeFileSync(tmpPath, wav);
    const response = await client.audio.transcriptions.create({
      file:  fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });
    return response.text.trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ── File-based transcription ──────────────────────────────────────────────────

async function transcribeFile(filePath: string): Promise<string> {
  const response = await client.audio.transcriptions.create({
    file:  fs.createReadStream(filePath),
    model: 'whisper-1',
  });
  return response.text.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Records audio via SoX (with VAD silence detection) then transcribes via
 * the standard Whisper REST API.  Much cheaper than the Realtime API.
 *
 * Returns '' on any error so the caller's silence-streak logic works normally.
 */
export async function transcribe(durationSecs = 4): Promise<string> {
  // Fast path: voiceListener may have already captured the user's first command
  const pending = popPendingUtterance();
  if (pending) {
    console.log('[Whisper] using queued post-wake utterance:', pending);
    return pending;
  }

  console.log('[Whisper] recording via SoX + Whisper REST for', durationSecs, 's...');

  try {
    return await transcribeViaWhisper(durationSecs);
  } catch (e) {
    console.warn('[Whisper] error:', e);
    return '';
  }
}

// ── Recording + transcription ─────────────────────────────────────────────────

function transcribeViaWhisper(durationSecs: number): Promise<string> {
  return new Promise((resolve) => {
    const soxArgs = process.platform === 'win32'
      ? ['-t', 'waveaudio', 'default', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-',
         'silence', '1', '0.1', '1%', '1', '0.8', '1%']
      : ['-d', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-',
         // VAD: start after 0.1 s of audio above 1%; stop after 0.8 s silence below 1%
         'silence', '1', '0.1', '1%', '1', '0.8', '1%'];

    const sox = spawn(SOX_PATH, soxArgs, { shell: false });

    currentSoxPid = sox.pid;

    const audioChunks: Buffer[] = [];
    let settled = false;

    function doResolve(value: string): void {
      if (!settled) {
        settled = true;
        if (currentSoxPid === sox.pid) currentSoxPid = undefined;
        resolve(value);
      }
    }

    // Kill SoX after durationSecs (max recording window)
    const recordingTimer = setTimeout(() => {
      if (currentSoxPid === sox.pid) {
        console.log('[Whisper] recording duration reached — stopping SoX');
        killCurrentRecording();
      }
    }, durationSecs * 1000);

    // Hard safety net: recording time + transcription headroom
    const overallTimer = setTimeout(() => {
      console.warn('[Whisper] overall timeout — returning empty transcript');
      doResolve('');
    }, (durationSecs + 15) * 1000);

    function clearTimers(): void {
      clearTimeout(recordingTimer);
      clearTimeout(overallTimer);
    }

    sox.stdout?.on('data', (chunk: Buffer) => {
      audioChunks.push(chunk);
    });

    sox.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn('[Whisper] SoX:', msg);
    });

    sox.on('close', async () => {
      clearTimeout(recordingTimer);
      if (currentSoxPid === sox.pid) currentSoxPid = undefined;

      const pcm = Buffer.concat(audioChunks);
      console.log('[Whisper] SoX closed, PCM bytes:', pcm.length, '— transcribing...');

      try {
        const transcript = await transcribeBuffer(pcm);
        console.log('[Whisper] transcript:', transcript);
        clearTimers();
        doResolve(transcript);
      } catch (e) {
        console.warn('[Whisper] transcription failed:', e);
        clearTimers();
        doResolve('');
      }
    });

    sox.on('error', (err) => {
      clearTimers();
      console.warn('[Whisper] SoX spawn error:', err.message);
      doResolve('');
    });
  });
}

// ── Silence-based recording + transcription ───────────────────────────────────

/**
 * Records until the user stops speaking (silence detection via SoX), then
 * transcribes via Whisper. Replaces fixed-duration recording for conversation
 * turns so long explanations are never cut off mid-sentence.
 */
export async function recordUntilSilence(params: {
  maxDuration?:      number;   // absolute max seconds (default 120)
  silenceThreshold?: number;   // seconds of silence before stopping (default 1.8)
  initialTimeout?:   number;   // seconds to wait for speech to start (default 8)
}): Promise<string> {
  const {
    maxDuration      = 120,
    silenceThreshold = 1.8,
    initialTimeout   = 8,
  } = params;

  // Fast path: voiceListener may have already captured the post-wake utterance
  const pending = popPendingUtterance();
  if (pending) {
    console.log('[Whisper] using queued post-wake utterance:', pending);
    return pending;
  }

  const tempFile = path.join(os.tmpdir(), `axon_recording_${Date.now()}.wav`);

  console.log(`[Whisper] listening... (silence detection active, max ${maxDuration}s)`);

  return new Promise((resolve) => {
    const inputArgs = process.platform === 'win32'
      ? ['-t', 'waveaudio', 'default']
      : ['-d'];

    const soxArgs = [
      ...inputArgs,
      '-t', 'wav',
      tempFile,
      'silence',
      '1', '0.1', '1%',
      '1', String(silenceThreshold), '1%',
    ];

    const sox = spawn(SOX_PATH, soxArgs, { shell: false });
    currentSoxPid = sox.pid;

    let speechStarted = false;
    let settled       = false;

    function doResolve(value: string): void {
      if (!settled) {
        settled = true;
        if (currentSoxPid === sox.pid) currentSoxPid = undefined;
        resolve(value);
      }
    }

    const forceStopTimer = setTimeout(() => {
      console.log(`[Whisper] max duration ${maxDuration}s reached — stopping`);
      if (currentSoxPid === sox.pid) killCurrentRecording();
    }, maxDuration * 1000);

    const initialTimeoutTimer = setTimeout(() => {
      if (!speechStarted) {
        console.log(`[Whisper] no speech detected in ${initialTimeout}s — stopping`);
        if (currentSoxPid === sox.pid) killCurrentRecording();
      }
    }, initialTimeout * 1000);

    function clearTimers(): void {
      clearTimeout(forceStopTimer);
      clearTimeout(initialTimeoutTimer);
    }

    sox.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (output.includes('In:') && !speechStarted) {
        speechStarted = true;
        clearTimeout(initialTimeoutTimer);
        console.log('[Whisper] speech detected — listening...');
      }
    });

    sox.on('close', async (code) => {
      clearTimers();
      if (currentSoxPid === sox.pid) currentSoxPid = undefined;

      console.log(`[Whisper] recording stopped (code ${code})`);

      if (!fs.existsSync(tempFile)) {
        doResolve('');
        return;
      }

      const stats = fs.statSync(tempFile);
      if (stats.size < 1000) {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        doResolve('');
        return;
      }

      try {
        const transcript = await transcribeFile(tempFile);
        console.log('[Whisper] transcript:', transcript);
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        doResolve(transcript);
      } catch (err) {
        console.warn('[Whisper] transcription failed:', err);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* ignore */ }
        doResolve('');
      }
    });

    sox.on('error', (err) => {
      clearTimers();
      console.warn('[Whisper] SoX spawn error (recordUntilSilence):', err.message);
      doResolve('');
    });
  });
}

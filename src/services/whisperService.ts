import WebSocket from 'ws';
import { spawn, exec } from 'child_process';
import { popPendingUtterance } from '../utils/utteranceQueue';

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH     = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

// ── Process tracking ──────────────────────────────────────────────────────────
// Both currentSoxPid and currentWs are tracked so killCurrentRecording() can
// abort both the capture and the WebSocket in one call, matching the contract
// expected by conversationService's transcribeWithTimeout() hard limit.

let currentSoxPid: number | undefined;
let currentWs:     WebSocket | undefined;

/**
 * Kill the currently running SoX recording and close its WebSocket session.
 * Called by conversationService's transcribeWithTimeout() hard-limit guard to
 * release the audio device when a recording hangs.
 */
export function killCurrentRecording(): void {
  if (currentSoxPid) {
    const pid   = currentSoxPid;
    currentSoxPid = undefined;
    console.log(`[Whisper] killing SoX PID ${pid}`);
    exec(`taskkill /F /T /PID ${pid}`, () => {});
  }
  if (currentWs) {
    const ws  = currentWs;
    currentWs = undefined;
    try { ws.close(); } catch { /* already closed */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Records durationSecs of audio via SoX and returns a transcript from the
 * OpenAI Realtime API.  If voiceListener captured a post-wake-word command in
 * the same breath as the wake word, that string is returned immediately
 * without recording, so the first conversation turn is instant.
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

  console.log('[Whisper] recording via Realtime API for', durationSecs, 's...');

  try {
    return await transcribeViaRealtime(durationSecs);
  } catch (e) {
    console.warn('[Whisper] error:', e);
    return '';
  }
}

// ── Realtime API transcription ────────────────────────────────────────────────

/**
 * Opens a Realtime API WebSocket in manual-commit mode, streams durationSecs
 * of PCM audio from SoX stdout, then commits the buffer and waits for the
 * input_audio_transcription.completed event.
 *
 * Flow:
 *  1. WS open → send session.update (manual turn detection, transcription on)
 *  2. SoX stdout data → buffer until session.updated, then stream directly
 *  3. Internal timer kills SoX after durationSecs
 *  4. SoX close → input_audio_buffer.commit
 *  5. Wait for conversation.item.input_audio_transcription.completed
 *  6. Close WS, return transcript
 */
function transcribeViaRealtime(durationSecs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY ?? '';

    // ── WebSocket ───────────────────────────────────────────────────────────

    const ws = new WebSocket(REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta':   'realtime=v1',
      },
    });

    currentWs = ws;

    // ── SoX — stream raw PCM16 at 24 kHz to stdout ─────────────────────────

    const sox = spawn(
      SOX_PATH,
      [
        '-t', 'waveaudio', 'default',
        '-r', '24000',
        '-c', '1',
        '-b', '16',
        '-e', 'signed-integer',
        '-t', 'raw', '-',
      ],
      { shell: false },
    );

    currentSoxPid = sox.pid;

    // ── State flags ─────────────────────────────────────────────────────────

    let sessionReady = false;
    let audioQueue:  Buffer[] = [];
    let soxDone      = false;
    let committed    = false;

    // Settle helpers — guards against double-resolve/reject after ws.close()
    let settled = false;

    function doResolve(value: string): void {
      if (!settled) {
        settled = true;
        if (currentWs === ws) currentWs = undefined;
        try { ws.close(); } catch { /* already closed */ }
        resolve(value);
      }
    }

    function doReject(err: Error): void {
      if (!settled) {
        settled = true;
        if (currentWs === ws) currentWs = undefined;
        killCurrentRecording();
        reject(err);
      }
    }

    // ── Timers ──────────────────────────────────────────────────────────────

    // Stop recording after durationSecs (internal limit)
    const recordingTimer = setTimeout(() => {
      if (currentSoxPid === sox.pid) {
        console.log('[Whisper] recording duration reached — stopping SoX');
        const pid   = currentSoxPid;
        currentSoxPid = undefined;
        exec(`taskkill /F /T /PID ${pid}`, () => {});
      }
    }, durationSecs * 1000);

    // Hard safety net — gives transcription 15 s headroom beyond the recording
    const overallTimer = setTimeout(() => {
      console.warn('[Whisper] overall timeout — returning empty transcript');
      doResolve('');
    }, (durationSecs + 15) * 1000);

    function clearTimers(): void {
      clearTimeout(recordingTimer);
      clearTimeout(overallTimer);
    }

    // ── Commit helper ───────────────────────────────────────────────────────

    function commitAudio(): void {
      if (committed || !sessionReady) return;
      committed = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        console.log('[Whisper] audio buffer committed, awaiting transcript...');
      }
    }

    // ── SoX event handlers ──────────────────────────────────────────────────

    sox.stdout?.on('data', (chunk: Buffer) => {
      if (!sessionReady) { audioQueue.push(chunk); return; }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type:  'input_audio_buffer.append',
          audio: chunk.toString('base64'),
        }));
      }
    });

    sox.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn('[Whisper] SoX:', msg);
    });

    sox.on('close', () => {
      clearTimeout(recordingTimer);
      if (currentSoxPid === sox.pid) currentSoxPid = undefined;
      soxDone = true;
      // Commit whatever was recorded; if session isn't ready yet the
      // session.updated handler will call commitAudio() once it is.
      if (sessionReady) commitAudio();
    });

    sox.on('error', (err) => {
      clearTimeout(recordingTimer);
      console.warn('[Whisper] SoX spawn error:', err.message);
      soxDone = true;
      if (sessionReady) commitAudio();
    });

    // ── WebSocket event handlers ────────────────────────────────────────────

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities:  ['text'],
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: null,   // manual commit — we control when audio ends
        },
      }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(raw.toString()) as typeof event;
      } catch {
        return;
      }

      // Session ready — flush buffered audio then switch to direct streaming
      if (event.type === 'session.updated') {
        sessionReady = true;
        console.log('[Whisper] Realtime session ready');

        for (const chunk of audioQueue) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type:  'input_audio_buffer.append',
              audio: chunk.toString('base64'),
            }));
          }
        }
        audioQueue = [];

        // SoX may have already closed while we were waiting for session setup
        if (soxDone) commitAudio();
      }

      // Transcription of the committed audio is complete
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = (event.transcript as string | undefined)?.trim() ?? '';
        console.log('[Whisper] transcript:', transcript);
        clearTimers();
        doResolve(transcript);
      }

      if (event.type === 'error') {
        const msg = (event.error as { message?: string } | undefined)?.message
          ?? JSON.stringify(event.error);
        console.warn('[Whisper] Realtime API error:', msg);
        clearTimers();
        doResolve('');
      }
    });

    ws.on('close', () => {
      clearTimers();
      // If we reach here without settling, the WS was closed externally
      // (e.g. killCurrentRecording() called by transcribeWithTimeout hard limit)
      doResolve('');
    });

    ws.on('error', (err) => {
      clearTimers();
      doReject(err);
    });
  });
}

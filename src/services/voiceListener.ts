import WebSocket from 'ws';
import { spawn, exec } from 'child_process';
import { setPendingUtterance } from '../utils/utteranceQueue';

console.log('[VoiceListener] module loaded');

// ── Config ────────────────────────────────────────────────────────────────────

const SOX_PATH     = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

// ── Types ─────────────────────────────────────────────────────────────────────

type StateCallback = (state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'urgent') => void;

// ── Module state ──────────────────────────────────────────────────────────────

let stopFlag   = false;
let activeSoxPid: number | undefined;
let activeWs:    WebSocket | undefined;

// ── Wake-word patterns ────────────────────────────────────────────────────────
// Fuzzy matching covers common mishearings of "hey axon" by Windows SR:
//   "action"  — SR mishears the 'x' as 'ction'
//   "ax on"   — SR splits the word
//   "Jackson" — SR maps the sound to a known name

const WAKE_PATTERNS = ['axon', 'hey ax', 'action', 'ax on', 'jackson'];

function isWakeWord(transcript: string): boolean {
  if (transcript.trim().length < 3) return false;
  const t = transcript.toLowerCase();
  return WAKE_PATTERNS.some(p => t.includes(p));
}

/**
 * Returns any text that follows the wake word in the same utterance.
 * e.g. "Hey axon, what time is it?" → "what time is it?"
 * Used to seed the utterance queue so the first conversation turn is instant.
 */
function extractCommandAfterWakeWord(transcript: string): string {
  const lower = transcript.toLowerCase();
  for (const pattern of WAKE_PATTERNS) {
    const idx = lower.indexOf(pattern);
    if (idx !== -1) {
      return transcript.slice(idx + pattern.length).replace(/^[\s,]+/, '').trim();
    }
  }
  return '';
}

// ── SoX management ────────────────────────────────────────────────────────────

function killSox(pid: number | undefined): void {
  if (!pid) return;
  if (activeSoxPid === pid) activeSoxPid = undefined;
  console.log(`[VoiceListener] killing SoX PID ${pid}`);
  exec(`taskkill /F /T /PID ${pid}`, () => {});
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startVoiceListener(
  onWakeWord:  () => void,
  setOrbState: StateCallback,
): void {
  stopFlag = false;
  void sessionLoop(onWakeWord, setOrbState);
}

export function stopVoiceListener(): void {
  stopFlag = true;
  try { activeWs?.close(); } catch { /* already closed */ }
  activeWs = undefined;
  killSox(activeSoxPid);
}

// ── Session loop (reconnects on errors) ───────────────────────────────────────

async function sessionLoop(
  onWakeWord:  () => void,
  setOrbState: StateCallback,
): Promise<void> {
  console.log('[VoiceListener] wake-word loop started (Realtime API)');

  while (!stopFlag) {
    try {
      await runSession(onWakeWord);
    } catch (e) {
      if (stopFlag) break;
      console.warn('[VoiceListener] session error — reconnecting in 2 s:', e);
      await sleep(2000);
    }
  }

  console.log('[VoiceListener] loop stopped');
}

// ── Single Realtime session ───────────────────────────────────────────────────

/**
 * Opens one WebSocket session + SoX process.
 * Streams raw PCM from SoX stdout → Realtime API as base64 chunks.
 * Server-side VAD segments the stream; each completed segment produces a
 * conversation.item.input_audio_transcription.completed event which we check
 * for the wake word.
 *
 * Resolves when the wake word is detected (stopFlag already set to true) or
 * when stopVoiceListener() closes the WebSocket.
 * Rejects on unexpected network / process errors so sessionLoop can reconnect.
 */
function runSession(onWakeWord: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY ?? '';

    // ── WebSocket ───────────────────────────────────────────────────────────

    const ws = new WebSocket(REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta':   'realtime=v1',
      },
    });

    activeWs = ws;

    // ── SoX — stream raw PCM16 at 24 kHz to stdout ─────────────────────────
    // The Realtime API expects pcm16 at 24 000 Hz, 1 channel, little-endian.

    const sox = spawn(
      SOX_PATH,
      [
        '-t', 'waveaudio', 'default',
        '-r', '24000',
        '-c', '1',
        '-b', '16',
        '-e', 'signed-integer',
        '-t', 'raw', '-',          // output raw PCM to stdout
      ],
      { shell: false },
    );

    const soxPid = sox.pid;
    activeSoxPid = soxPid;

    // ── Settle helpers ──────────────────────────────────────────────────────

    let settled = false;

    function settle(fn: () => void): void {
      if (!settled) { settled = true; fn(); }
    }

    // ── Audio buffering ─────────────────────────────────────────────────────
    // Buffer SoX output until the WS session is confirmed ready, then stream
    // directly.  This avoids losing the first ~200 ms of audio during setup.

    let wsReady   = false;
    let audioQueue: Buffer[] = [];

    function sendChunk(chunk: Buffer): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type:  'input_audio_buffer.append',
          audio: chunk.toString('base64'),
        }));
      }
    }

    sox.stdout?.on('data', (chunk: Buffer) => {
      if (stopFlag) return;
      if (!wsReady) { audioQueue.push(chunk); return; }
      sendChunk(chunk);
    });

    sox.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn('[VoiceListener] SoX:', msg);
    });

    sox.on('close', (code) => {
      if (activeSoxPid === soxPid) activeSoxPid = undefined;
      if (!stopFlag) {
        console.warn('[VoiceListener] SoX exited unexpectedly, code:', code);
        ws.close();
      }
    });

    sox.on('error', (err) => {
      console.warn('[VoiceListener] SoX spawn error:', err.message);
      ws.close();
    });

    // ── WebSocket event handlers ────────────────────────────────────────────

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities:  ['text'],
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type:                  'server_vad',
            threshold:             0.7,
            prefix_padding_ms:     500,
            silence_duration_ms:   2000,
          },
        },
      }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      if (stopFlag) return;

      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(raw.toString()) as typeof event;
      } catch {
        return;
      }

      // Session configured — flush buffered audio and switch to direct streaming
      if (event.type === 'session.updated') {
        wsReady = true;
        console.log('[VoiceListener] Realtime session ready — streaming audio');
        for (const chunk of audioQueue) sendChunk(chunk);
        audioQueue = [];
      }

      // Each server-VAD speech segment produces this event
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = (event.transcript as string | undefined)?.trim() ?? '';
        if (!transcript) return;

        console.log('[VoiceListener] heard:', transcript);

        if (isWakeWord(transcript)) {
          console.log('[VoiceListener] WAKE WORD DETECTED:', transcript);

          // If the user included a command after the wake word, queue it for
          // the first conversationService transcribe() call.
          const command = extractCommandAfterWakeWord(transcript);
          if (command.length > 3) {
            console.log('[VoiceListener] queuing post-wake command:', command);
            setPendingUtterance(command);
          }

          stopFlag = true;
          killSox(soxPid);
          try { ws.close(); } catch { /* already closed */ }
          onWakeWord();
          settle(() => resolve());
        }
      }

      if (event.type === 'error') {
        const msg = (event.error as { message?: string } | undefined)?.message
          ?? JSON.stringify(event.error);
        console.warn('[VoiceListener] Realtime API error:', msg);
      }
    });

    ws.on('close', (code, reason) => {
      if (activeWs === ws) activeWs = undefined;
      killSox(soxPid);
      if (stopFlag) {
        settle(() => resolve());
      } else {
        settle(() => reject(new Error(
          `WebSocket closed unexpectedly: ${code} ${reason.toString()}`,
        )));
      }
    });

    ws.on('error', (err) => {
      killSox(soxPid);
      settle(() => reject(err));
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

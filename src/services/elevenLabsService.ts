import axios from 'axios';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserWindow } from 'electron';

const API_KEY  = process.env.ELEVENLABS_API_KEY  ?? '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '';

let orbWin: BrowserWindow | null = null;
export function setOrbWindow(win: BrowserWindow): void { orbWin = win; }

// Windows only — macOS uses afplay (built-in)
const SOX_PATH      = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';
const SOX_AUDIO_OUT = 'waveaudio';

const SAMPLE_RATE = 22050;
const TMP_FILE    = join(tmpdir(), 'axon_tts.wav');

export let isSpeaking = false;

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
      model_id: 'eleven_flash_v2_5',
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

  await new Promise<void>((resolve) => {
    const [playerPath, playerArgs]: [string, string[]] =
      process.platform === 'darwin'
        ? ['afplay', [TMP_FILE]]
        : [SOX_PATH, ['-t', 'wav', TMP_FILE, '-t', SOX_AUDIO_OUT, 'default']];

    const player = spawn(playerPath, playerArgs, { shell: false });

    const timer = setTimeout(() => {
      console.warn('[ElevenLabs] playback hard cap — killing player');
      player.kill();
      resolve();
    }, 60_000);

    player.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) console.warn('[ElevenLabs] player exited with code:', code);
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
      const msg = Buffer.concat(stderrBuf).toString().trim();
      if (msg) console.warn('[ElevenLabs] player stderr:', msg);
    });
  });

  try { unlinkSync(TMP_FILE); } catch { /* ignore cleanup errors */ }
}

// ── Public speak() — splits long text, speaks all chunks sequentially ─────────

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 80));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  // Sanitise markdown/symbols before sending to ElevenLabs.
  const sanitised = sanitiseForTTS(text);

  // Buffer the full response before playing — streaming PCM to SoX stdin
  // causes premature EOF on macOS after the first chunk.
  const chunks = splitOnSentences(sanitised, 1800);
  if (chunks.length > 1) {
    console.log(`[ElevenLabs] text split into ${chunks.length} chunks for sequential delivery`);
  }

  isSpeaking = true;
  orbWin?.webContents.send('orb:state', 'speaking');

  try {
    for (const chunk of chunks) {
      if (chunk.trim().length === 0) continue;
      await speakChunk(chunk);
    }
  } catch (e) {
    console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
    orbWin?.webContents.send('orb:state', 'idle');
  }
}

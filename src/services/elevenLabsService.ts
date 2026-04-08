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

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 60));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  isSpeaking = true;
  orbWin?.webContents.send('orb:state', 'speaking');

  try {
    // Buffer the full response before playing — streaming PCM to SoX stdin
    // causes premature EOF on macOS after the first chunk.
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

    // Small response → likely an API error JSON, not audio
    if (pcmData.byteLength < 200) {
      console.warn('[ElevenLabs] suspiciously small response:', pcmData.toString('utf8', 0, Math.min(300, pcmData.byteLength)));
      return;
    }

    // Wrap raw PCM in a WAV container so any player can handle it
    const wav = Buffer.concat([buildWavHeader(pcmData.byteLength), pcmData]);
    writeFileSync(TMP_FILE, wav);

    await new Promise<void>((resolve) => {
      // macOS: afplay is built-in and reliably handles WAV files.
      // Windows: fall back to SoX.
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
  } catch (e) {
    console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
    orbWin?.webContents.send('orb:state', 'idle');
  }
}

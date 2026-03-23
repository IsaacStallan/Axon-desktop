import axios from 'axios';
import { spawn } from 'child_process';

const API_KEY  = process.env.ELEVENLABS_API_KEY  ?? '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '';

// SoX plays raw PCM from stdin natively — no libmad, no file on disk, no PowerShell.
const SOX_PATH = 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

// PCM spec matching the ElevenLabs pcm_22050 output format
const SAMPLE_RATE = 22050;

export let isSpeaking = false;

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 60));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  isSpeaking = true;

  try {
    // ── Streaming request ────────────────────────────────────────────────────
    // ElevenLabs starts sending audio chunks within ~300 ms of the request.
    // We pipe the response stream directly into SoX stdin so playback begins
    // as soon as the first bytes arrive — no waiting for the full download,
    // no writing to disk.
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=pcm_22050`,
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
        responseType: 'stream',
      },
    );

    // ── SoX reads raw PCM from stdin ─────────────────────────────────────────
    // -t raw  : headerless input
    // -r 22050: sample rate matching pcm_22050
    // -c 1    : mono
    // -b 16   : 16-bit
    // -e signed-integer : two's complement LE (ElevenLabs PCM default)
    // -       : read from stdin
    // -t waveaudio default : Windows audio output
    await new Promise<void>((resolve) => {
      const sox = spawn(
        SOX_PATH,
        [
          '-t', 'raw',
          '-r', String(SAMPLE_RATE),
          '-c', '1',
          '-b', '16',
          '-e', 'signed-integer',
          '-',                           // stdin
          '-t', 'waveaudio', 'default',  // Windows speaker output
        ],
        { shell: false },
      );

      // Hard cap — no response should ever take more than 60 seconds
      const timer = setTimeout(() => {
        console.warn('[ElevenLabs] playback hard cap — killing SoX');
        sox.kill();
        resolve();
      }, 60_000);

      sox.on('close', () => { clearTimeout(timer); resolve(); });
      sox.on('error', (err) => {
        clearTimeout(timer);
        console.warn('[ElevenLabs] SoX error:', err.message);
        resolve();
      });

      // Suppress normal SoX progress output; surface only real warnings
      const stderrBuf: Buffer[] = [];
      sox.stderr?.on('data', (b: Buffer) => stderrBuf.push(b));
      sox.on('close', () => {
        const msg = Buffer.concat(stderrBuf).toString().trim();
        if (msg && !msg.startsWith('Input File') && !msg.includes('WARN rate') && !msg.includes('WARN dither')) {
          console.warn('[ElevenLabs] SoX stderr:', msg);
        }
      });

      // Pipe ElevenLabs stream → SoX stdin
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (response.data as NodeJS.ReadableStream).pipe(sox.stdin!);

      (response.data as NodeJS.ReadableStream).on('error', (err: Error) => {
        console.warn('[ElevenLabs] stream error:', err.message);
        sox.stdin?.destroy();
        sox.kill();
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (e) {
    console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
  }
}

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { app } from 'electron';

const API_KEY  = process.env.ELEVENLABS_API_KEY  ?? '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '';

// Lazy — only called after app is ready, so getPath('userData') is safe
function ttsCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'tts_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export let isSpeaking = false;

export async function speak(text: string): Promise<void> {
  console.log('[ElevenLabs] speak:', text.slice(0, 60));

  if (!API_KEY || !VOICE_ID) {
    console.warn('[ElevenLabs] missing credentials — skipping TTS');
    return;
  }

  isSpeaking = true;

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.5 },
      },
      {
        headers: {
          'xi-api-key':   API_KEY,
          'Content-Type': 'application/json',
          Accept:         'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );

    const stamp   = Date.now();
    const mp3Path = path.join(ttsCacheDir(), `tts_${stamp}.mp3`);
    fs.writeFileSync(mp3Path, response.data);

    await playFile(mp3Path);

    fs.unlink(mp3Path, () => {});
  } catch (e) {
    console.warn('[ElevenLabs] TTS failed:', e);
  } finally {
    isSpeaking = false;
  }
}

// ---------------------------------------------------------------------------
// Silent playback via WPF MediaPlayer running in STA mode.
// The script is written to a .ps1 file so no inline quoting is needed — the
// file path and URI are both clean strings with no escaping required.
// ---------------------------------------------------------------------------
function playFile(mp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Convert Windows backslashes → forward slashes for the file:/// URI
    const fileUri    = 'file:///' + mp3Path.replace(/\\/g, '/');
    const scriptPath = mp3Path.replace('.mp3', '.ps1');

    const script = [
      'Add-Type -AssemblyName PresentationCore',
      '$mp = New-Object System.Windows.Media.MediaPlayer',
      `$mp.Open([System.Uri]::new('${fileUri}'))`,
      '$mp.Play()',
      // Wait until NaturalDuration is known (stream has buffered)
      'Start-Sleep -Milliseconds 500',
      'while ($mp.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }',
      // Sleep for the full duration plus a 1-second tail to avoid cutting off
      '$secs = [Math]::Ceiling($mp.NaturalDuration.TimeSpan.TotalSeconds) + 1',
      'Start-Sleep -Seconds $secs',
      '$mp.Close()',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, script, 'utf8');

    exec(
      `powershell -ExecutionPolicy Bypass -STA -NoProfile -NonInteractive -File "${scriptPath}"`,
      { timeout: 300_000 },
      (err, _stdout, stderr) => {
        fs.unlink(scriptPath, () => {});   // clean up .ps1 regardless
        if (stderr) console.warn('[ElevenLabs] ps stderr:', stderr.trim());
        if (err) {
          console.warn('[ElevenLabs] playback error:', err.message);
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

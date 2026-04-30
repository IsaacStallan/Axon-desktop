import { execSync } from 'child_process';
import * as http    from 'http';
import * as fs      from 'fs';

// ── Config ─────────────────────────────────────────────────────────────────────

const HA_URL        = process.env.HOME_ASSISTANT_URL  ?? '';
const HA_TOKEN      = process.env.HOME_ASSISTANT_TOKEN ?? '';
const HA_AUDIO_PORT = 47832;
const HA_AUDIO_PATH = '/tmp/axon_ha_audio.wav';

// ── Speaker types ──────────────────────────────────────────────────────────────

export interface Speaker {
  entityId: string;
  name:     string;
  room:     string;
  priority: number;   // 1 = highest priority room (first in env list)
}

// HOME_ASSISTANT_SPEAKERS=office:media_player.office,living_room:media_player.living_room
export function getConfiguredSpeakers(): Speaker[] {
  const raw = process.env.HOME_ASSISTANT_SPEAKERS ?? '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((s, i) => {
      const [room, entityId] = s.trim().split(':');
      return { entityId: entityId?.trim(), name: room?.trim(), room: room?.trim(), priority: i + 1 };
    })
    .filter(s => s.entityId && s.room);
}

// ── Google TTS via Home Assistant (no local audio needed) ──────────────────────

export async function speakOnSpeaker(
  speaker: Speaker,
  text:    string,
  volume  = 0.6,
): Promise<void> {
  if (!HA_TOKEN || !HA_URL) {
    console.log('[HomeAssistant] not configured — skipping');
    return;
  }

  try {
    await fetch(`${HA_URL}/api/services/media_player/volume_set`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ entity_id: speaker.entityId, volume_level: volume }),
    });

    await fetch(`${HA_URL}/api/services/tts/google_translate_say`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ entity_id: speaker.entityId, message: text, language: 'en' }),
    });

    console.log(`[HomeAssistant] spoke on ${speaker.name}: "${text.slice(0, 50)}"`);
  } catch (err) {
    console.error('[HomeAssistant] speak failed:', err);
  }
}

export async function speakOnAllSpeakers(text: string): Promise<void> {
  const speakers = getConfiguredSpeakers();
  if (speakers.length === 0) return;
  await Promise.all(speakers.map(s => speakOnSpeaker(s, text)));
}

export async function speakOnNearestSpeaker(text: string, preferredRoom?: string): Promise<void> {
  const speakers = getConfiguredSpeakers();
  if (speakers.length === 0) return;
  const target = (preferredRoom ? speakers.find(s => s.room === preferredRoom) : null) ?? speakers[0];
  await speakOnSpeaker(target, text);
}

// ── Room inference ─────────────────────────────────────────────────────────────

export function inferCurrentRoom(obs: {
  macIdleMinutes:   number;
  timeOfDay:        string;
  airpodsConnected: boolean;
}): string {
  if (obs.macIdleMinutes < 3)                                  return 'office';
  if (obs.airpodsConnected)                                    return 'living_room';
  if (obs.timeOfDay === 'evening' && obs.macIdleMinutes > 5)   return 'living_room';
  return 'office';
}

// ── ElevenLabs audio served via local HTTP → HA plays URL ─────────────────────

let haServerRunning = false;

function getMacLocalIP(): string {
  try {
    return execSync(
      'ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null',
      { encoding: 'utf8', timeout: 1_000 },
    ).trim() || '192.168.1.100';
  } catch { return '192.168.1.100'; }
}

function startHAAudioServer(): void {
  if (haServerRunning) return;
  haServerRunning = true;

  const server = http.createServer((_req, res) => {
    try {
      const audio = fs.readFileSync(HA_AUDIO_PATH);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(audio);
    } catch {
      res.writeHead(404).end();
    }
  });

  server.listen(HA_AUDIO_PORT, '0.0.0.0', () => {
    console.log(`[HomeAssistant] audio server listening on port ${HA_AUDIO_PORT}`);
  });

  server.on('error', (e) => {
    console.warn('[HomeAssistant] audio server error:', e);
    haServerRunning = false;
  });
}

/**
 * Serve locally-generated ElevenLabs audio over HTTP so HA can play it on a speaker.
 * Non-blocking from the caller's perspective — fire and forget.
 */
export async function speakWithElevenLabsOnSpeaker(
  speaker:     Speaker,
  audioBuffer: Buffer,
): Promise<void> {
  if (!HA_TOKEN || !HA_URL) return;

  try {
    fs.writeFileSync(HA_AUDIO_PATH, audioBuffer);
    startHAAudioServer();

    const macIP = getMacLocalIP();
    const url   = `http://${macIP}:${HA_AUDIO_PORT}/axon_ha_audio.wav`;

    // Brief pause to ensure file is written and server is ready
    await new Promise(r => setTimeout(r, 300));

    await fetch(`${HA_URL}/api/services/media_player/play_media`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        entity_id:          speaker.entityId,
        media_content_id:   url,
        media_content_type: 'music',
      }),
    });

    console.log(`[HomeAssistant] ElevenLabs audio playing on ${speaker.name}`);
  } catch (err) {
    console.error('[HomeAssistant] ElevenLabs speaker failed:', err);
  }
}

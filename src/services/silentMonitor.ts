import { startWindowMonitor, getCurrentApp, getProductivityScore } from './windowMonitor';
import { startHeartbeat } from './deviceCoordinator';
import { initCloudSync, getClient, getDeviceId, getDeviceName } from './cloudSync';

/**
 * Lightweight monitoring-only mode — enabled when DEVICE_ROLE=monitor.
 *
 * Runs only:
 *   • windowMonitor  — tracks the active app and productivity score
 *   • deviceCoordinator.startHeartbeat() — pushes status to Supabase every 30 s
 *   • sendRichMetadata() — posts drift score + idle time to axon_devices.metadata every 60 s
 *     (Mac reads this via pcNodeSync to factor PC state into cognitive decisions)
 *
 * No voice listener, no decision loop, no ElevenLabs, no conversation pipeline.
 */

// ── Module state for idle tracking ────────────────────────────────────────────

let lastKnownApp    = '';
let lastAppChangedAt = Date.now();

// ── Rich metadata heartbeat ────────────────────────────────────────────────────

function sendRichMetadata(): void {
  const supabase = getClient();
  if (!supabase) return;

  const curr  = getCurrentApp();
  const score = getProductivityScore();

  // Track last app change to estimate workstation idle time
  if (curr.name && curr.name !== lastKnownApp) {
    lastKnownApp    = curr.name;
    lastAppChangedAt = Date.now();
  }
  const idleMins = Math.round((Date.now() - lastAppChangedAt) / 60_000);

  const metadata = {
    active_app:     curr.name,
    idle_minutes:   idleMins,
    drift_score:    Math.max(0, 100 - score),
    screen_summary: curr.name,
  };

  void supabase
    .from('axon_devices')
    .upsert(
      {
        device_id:   getDeviceId(),
        device_name: getDeviceName(),
        last_seen:   new Date().toISOString(),
        metadata,
      },
      { onConflict: 'device_id' },
    )
    .then(({ error }) => {
      if (error) console.warn('[Monitor] metadata upsert failed:', error.message);
    });

  console.log(`[Monitor] metadata: app="${curr.name}" idle=${idleMins}min drift=${metadata.drift_score}`);
}

// ── Startup ────────────────────────────────────────────────────────────────────

export function startSilentMonitor(): void {
  console.log('[Monitor] PC monitoring active — sending heartbeat to Supabase');

  startWindowMonitor();

  // Pull shared data so Supabase tables stay warm
  void initCloudSync();

  // Basic heartbeat every 30 s (app + productivity score)
  startHeartbeat();

  // Rich metadata heartbeat every 60 s (drift score + idle time for Mac's pcNodeSync)
  void sendRichMetadata();
  setInterval(sendRichMetadata, 60_000);

  // Local status log — mirrors basic heartbeat cadence
  setInterval(() => {
    const curr  = getCurrentApp();
    const score = getProductivityScore();
    console.log(`[Monitor] active app: ${curr.name}, score: ${score}%`);
  }, 30_000);
}

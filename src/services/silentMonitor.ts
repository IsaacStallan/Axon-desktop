import { startWindowMonitor, getCurrentApp, getProductivityScore } from './windowMonitor';
import { startHeartbeat } from './deviceCoordinator';
import { initCloudSync }  from './cloudSync';

/**
 * Lightweight monitoring-only mode — enabled when DEVICE_ROLE=monitor.
 *
 * Runs only:
 *   • windowMonitor  — tracks the active app and productivity score
 *   • deviceCoordinator.startHeartbeat() — pushes status to Supabase every 30 s
 *
 * No voice listener, no decision loop, no ElevenLabs, no conversation pipeline.
 */
export function startSilentMonitor(): void {
  console.log('[Monitor] PC monitoring active — sending heartbeat to Supabase');

  startWindowMonitor();

  // Pull shared data (goals, commitments, profile) so Supabase tables stay warm
  void initCloudSync();

  // Push this device's status every 30 seconds
  startHeartbeat();

  // Local status log — mirrors heartbeat cadence
  setInterval(() => {
    const curr  = getCurrentApp();
    const score = getProductivityScore();
    console.log(`[Monitor] active app: ${curr.name}, score: ${score}%`);
  }, 30_000);
}

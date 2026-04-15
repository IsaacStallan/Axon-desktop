import { getClient, getDeviceId, getDeviceName } from './cloudSync';
import { getCurrentApp, getProductivityScore }   from './windowMonitor';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DeviceStatus {
  deviceId:          string;
  deviceName:        string;
  lastSeen:          Date;
  isActive:          boolean;
  currentApp:        string;
  productivityScore: number;
  platform:          string;
}

export interface CrossDeviceContext {
  hasOtherDevices:  boolean;
  otherDevices:     DeviceStatus[];
  formattedSummary: string;  // ready for prompt injection; '' if no relevant context
}

// ── Constants ──────────────────────────────────────────────────────────────────

const ACTIVE_THRESHOLD_MS = 5 * 60_000;   // device is "active" if seen < 5 min ago
const IDLE_THRESHOLD_MS   = 10 * 60_000;  // device is "idle" if last seen > 10 min ago

// ── Heartbeat ──────────────────────────────────────────────────────────────────

async function sendHeartbeat(): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  const curr  = getCurrentApp();
  const score = getProductivityScore();

  // A device is "active" if the window changed in the last 5 minutes
  const isActive = (Date.now() - curr.startedAt) < ACTIVE_THRESHOLD_MS * 5 &&
                   curr.name !== 'unknown';

  try {
    const { error } = await sb.from('axon_devices').upsert({
      device_id:         getDeviceId(),
      device_name:       getDeviceName(),
      last_seen:         new Date().toISOString(),
      is_active:         isActive,
      current_app:       curr.name,
      productivity_score:score,
      platform:          process.platform === 'darwin' ? 'mac' : 'windows',
    }, { onConflict: 'device_id' });

    if (error) console.warn('[DeviceCoordinator] heartbeat failed:', error.message);
  } catch (e) {
    console.warn('[DeviceCoordinator] heartbeat error:', e);
  }
}

export function startHeartbeat(): void {
  void sendHeartbeat();
  setInterval(() => { void sendHeartbeat(); }, 30_000);
  console.log('[DeviceCoordinator] heartbeat started (30s)');
}

// ── Device status queries ──────────────────────────────────────────────────────

export async function getAllDeviceStatuses(): Promise<DeviceStatus[]> {
  const sb = getClient();
  if (!sb) return [];

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // seen in last 24h
    const { data, error } = await sb
      .from('axon_devices')
      .select('*')
      .gte('last_seen', cutoff)
      .order('last_seen', { ascending: false });

    if (error || !data) return [];

    return (data as Record<string, unknown>[]).map(d => ({
      deviceId:          d.device_id as string,
      deviceName:        d.device_name as string,
      lastSeen:          new Date(d.last_seen as string),
      isActive:          d.is_active as boolean,
      currentApp:        d.current_app as string,
      productivityScore: d.productivity_score as number,
      platform:          d.platform as string,
    }));
  } catch (e) {
    console.warn('[DeviceCoordinator] getAllDeviceStatuses error:', e);
    return [];
  }
}

export async function getPrimaryDevice(): Promise<string | null> {
  const devices = await getAllDeviceStatuses();
  const active  = devices.filter(
    d => d.isActive && (Date.now() - d.lastSeen.getTime()) < ACTIVE_THRESHOLD_MS,
  );

  if (active.length === 0) return null;
  return active[0].deviceId;  // most recently seen (ordered by last_seen DESC)
}

// ── Speaker lock ───────────────────────────────────────────────────────────────

/**
 * Attempt to acquire the speaker lock for `durationMs`.
 * Returns true if acquired (or if Supabase is unavailable — always allow offline).
 */
export async function acquireSpeakerLock(durationMs: number): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true;  // offline: allow intervention

  const deviceId  = getDeviceId();
  const now       = new Date();
  const expiresAt = new Date(Date.now() + durationMs);

  try {
    // Read current lock state
    const { data } = await sb
      .from('axon_speaker_lock')
      .select('*')
      .eq('id', 1)
      .single();

    const lock = data as Record<string, string | null> | null;

    // Another device holds an unexpired lock
    if (
      lock &&
      lock.held_by &&
      lock.held_by !== deviceId &&
      lock.expires_at &&
      new Date(lock.expires_at) > now
    ) {
      console.log(
        `[DeviceCoordinator] lock held by ${lock.held_by} until ${lock.expires_at} — skipping`,
      );
      return false;
    }

    // Acquire the lock
    const { error } = await sb.from('axon_speaker_lock').upsert({
      id:         1,
      held_by:    deviceId,
      locked_at:  now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }, { onConflict: 'id' });

    if (error) {
      console.warn('[DeviceCoordinator] acquireSpeakerLock failed:', error.message);
      return true;  // on error, allow locally (don't block interventions)
    }

    console.log(`[DeviceCoordinator] speaker lock acquired (${Math.round(durationMs / 1000)}s)`);
    return true;
  } catch (e) {
    console.warn('[DeviceCoordinator] acquireSpeakerLock error:', e);
    return true;  // network error: allow locally
  }
}

export async function releaseSpeakerLock(): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  try {
    const { error } = await sb.from('axon_speaker_lock').upsert({
      id:         1,
      held_by:    null,
      locked_at:  null,
      expires_at: new Date(0).toISOString(),  // expired
    }, { onConflict: 'id' });

    if (error) console.warn('[DeviceCoordinator] releaseSpeakerLock failed:', error.message);
    else console.log('[DeviceCoordinator] speaker lock released');
  } catch (e) {
    console.warn('[DeviceCoordinator] releaseSpeakerLock error:', e);
  }
}

export async function holdsLock(): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;

  try {
    const { data } = await sb
      .from('axon_speaker_lock')
      .select('held_by, expires_at')
      .eq('id', 1)
      .single();

    const lock = data as Record<string, string | null> | null;
    return (
      !!lock &&
      lock.held_by === getDeviceId() &&
      !!lock.expires_at &&
      new Date(lock.expires_at) > new Date()
    );
  } catch {
    return false;
  }
}

// ── Cross-device context ───────────────────────────────────────────────────────

const NEGATIVE_APP_FRAGMENTS = [
  'steam', 'youtube', 'netflix', 'crunchyroll', 'instagram',
  'tiktok', 'twitter', 'reddit', 'discord', 'twitch',
];

function isDriftApp(appName: string): boolean {
  const lower = appName.toLowerCase();
  return NEGATIVE_APP_FRAGMENTS.some(f => lower.includes(f));
}

function formatIdleTime(lastSeen: Date): string {
  const mins = Math.round((Date.now() - lastSeen.getTime()) / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'}`;
}

export async function getCrossDeviceContext(): Promise<CrossDeviceContext> {
  const devices    = await getAllDeviceStatuses();
  const myDeviceId = getDeviceId();
  const others     = devices.filter(d => d.deviceId !== myDeviceId);

  if (others.length === 0) {
    return { hasOtherDevices: false, otherDevices: [], formattedSummary: '' };
  }

  const lines: string[] = [];
  const now = Date.now();

  for (const d of others) {
    const msSinceLastSeen = now - d.lastSeen.getTime();
    const name            = d.deviceName || d.platform || d.deviceId.slice(0, 8);

    if (msSinceLastSeen < ACTIVE_THRESHOLD_MS && d.isActive) {
      const durationMins = Math.round((now - d.lastSeen.getTime()) / 60_000);

      if (isDriftApp(d.currentApp)) {
        const duration = durationMins > 0 ? `, ${durationMins}+ min` : '';
        lines.push(`${name} is active — current app: ${d.currentApp}${duration} (drift app).`);
      } else {
        lines.push(`${name} is active — current app: ${d.currentApp}.`);
      }
    } else if (msSinceLastSeen > IDLE_THRESHOLD_MS) {
      lines.push(`${name} has been idle for ${formatIdleTime(d.lastSeen)}.`);
    }
  }

  const formattedSummary = lines.join(' ');

  return {
    hasOtherDevices:  true,
    otherDevices:     others,
    formattedSummary,
  };
}

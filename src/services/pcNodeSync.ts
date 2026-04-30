import { getClient } from './cloudSync';

/*
 * Supabase SQL — run once to add metadata support to axon_devices:
 *
 * ALTER TABLE axon_devices ADD COLUMN IF NOT EXISTS metadata jsonb default '{}';
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PCNodeState {
  device_id:      string;
  device_name:    string;
  active_app:     string;
  idle_minutes:   number;
  drift_score:    number;
  is_active:      boolean;
  screen_summary: string;
  timestamp:      string;
}

// ── PC state reader ────────────────────────────────────────────────────────────

export async function readPCState(): Promise<PCNodeState | null> {
  try {
    const supabase = getClient();
    if (!supabase) return null;

    const { data } = await supabase
      .from('axon_devices')
      .select('*')
      .eq('device_name', 'pc')
      .order('last_seen', { ascending: false })
      .limit(1);

    if (!data || data.length === 0) return null;

    const device      = data[0] as Record<string, unknown>;
    const lastSeen    = new Date(device.last_seen as string);
    const minutesSince = (Date.now() - lastSeen.getTime()) / 60_000;

    // PC data older than 3 minutes is stale
    if (minutesSince > 3) return null;

    const meta = (device.metadata as Record<string, unknown> | null) ?? {};

    return {
      device_id:      device.device_id as string,
      device_name:    device.device_name as string,
      active_app:     (meta.active_app  as string) ?? (device.current_app as string) ?? 'unknown',
      idle_minutes:   (meta.idle_minutes as number) ?? 0,
      drift_score:    (meta.drift_score  as number) ?? Math.max(0, 100 - ((device.productivity_score as number) ?? 50)),
      is_active:      minutesSince < 2,
      screen_summary: (meta.screen_summary as string) ?? (device.current_app as string) ?? '',
      timestamp:      device.last_seen as string,
    };
  } catch { return null; }
}

// ── State helpers ──────────────────────────────────────────────────────────────

export function isPCActive(state: PCNodeState | null): boolean {
  if (!state) return false;
  return state.is_active && state.idle_minutes < 5;
}

export function getPCDriftContext(state: PCNodeState | null): string {
  if (!state || !isPCActive(state)) return '';
  return `PC is active — app: ${state.active_app}, drift score: ${state.drift_score}`;
}

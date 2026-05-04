import { getClient, getDeviceId } from './cloudSync';
import { isPhoneActive as mdmPhoneActive, getPhoneIdleMinutes } from './mdmServer';

// ── Distraction app list ───────────────────────────────────────────────────────

const DISTRACTION_APPS = [
  'Instagram', 'TikTok', 'YouTube', 'Twitter', 'X',
  'Reddit', 'Snapchat', 'Facebook', 'BeReal', 'Twitch',
  'Netflix', 'Disney+', 'Spotify',
  'Messages',
  'Games',
];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PhoneActivity {
  id:         string;
  user_id:    string;
  app_name:   string;
  timestamp:  string;
  device:     string;
}

// ── Fetch activity ─────────────────────────────────────────────────────────────

export async function getRecentPhoneActivity(windowMinutes = 10): Promise<PhoneActivity[]> {
  const supabase = getClient();
  if (!supabase) return [];

  try {
    const cutoff   = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const deviceId = getDeviceId();

    const { data, error } = await supabase
      .from('phone_activity')
      .select('*')
      .eq('user_id', deviceId)
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: false });

    if (error) throw error;
    return (data ?? []) as PhoneActivity[];
  } catch (err) {
    console.error('[PhoneMonitor] failed to fetch activity:', err);
    return [];
  }
}

// ── Distraction check ──────────────────────────────────────────────────────────

export async function isOnPhoneDistraction(): Promise<{
  confirmed:   boolean;
  app:         string | null;
  minutesAgo:  number | null;
}> {
  // MDM check-in is the highest-confidence phone presence signal (AXON_CORE_MODE only)
  if (process.env.AXON_CORE_MODE === 'true' && mdmPhoneActive()) {
    return { confirmed: true, app: 'iPhone (MDM)', minutesAgo: Math.round(getPhoneIdleMinutes()) };
  }

  const activity    = await getRecentPhoneActivity(5);
  const distraction = activity.find(a =>
    DISTRACTION_APPS.some(d => a.app_name.toLowerCase().includes(d.toLowerCase())),
  );

  if (!distraction) return { confirmed: false, app: null, minutesAgo: null };

  const minutesAgo = Math.round(
    (Date.now() - new Date(distraction.timestamp).getTime()) / 60_000,
  );

  return { confirmed: true, app: distraction.app_name, minutesAgo };
}

// ── Session summary ────────────────────────────────────────────────────────────

export async function getPhoneSessionSummary(): Promise<string> {
  const activity = await getRecentPhoneActivity(30);
  if (activity.length === 0) return 'No phone activity detected in last 30 minutes';

  const appCounts = activity.reduce<Record<string, number>>((acc, a) => {
    acc[a.app_name] = (acc[a.app_name] ?? 0) + 1;
    return acc;
  }, {});

  const summary = Object.entries(appCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([app, count]) => `${app} (${count} opens)`)
    .join(', ');

  return `Phone activity last 30min: ${summary}`;
}

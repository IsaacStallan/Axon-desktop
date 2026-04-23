// Receives phone activity from iOS Shortcut via Supabase
// iOS Shortcut posts to phone_activity table when distraction apps open

const SUPABASE_URL  = process.env.SUPABASE_URL  ?? '';
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY ?? '';

const DISTRACTION_APPS = [
  'Instagram', 'TikTok', 'YouTube', 'Twitter', 'Reddit',
  'Snapchat', 'X', 'BeReal', 'Reels',
];

export interface PhoneActivity {
  id?:        string;
  user_id?:   string;
  app_name:   string;
  timestamp:  string;
  device:     string;
}

export async function getRecentPhoneActivity(windowMins = 30): Promise<PhoneActivity[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    const since = new Date(Date.now() - windowMins * 60_000).toISOString();
    const url   = `${SUPABASE_URL}/rest/v1/phone_activity?timestamp=gte.${since}&order=timestamp.desc&limit=50`;
    const resp  = await fetch(url, {
      headers: {
        apikey:        SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!resp.ok) return [];
    return (await resp.json()) as PhoneActivity[];
  } catch {
    return [];
  }
}

export async function isOnPhoneDistraction(): Promise<boolean> {
  const activity = await getRecentPhoneActivity(5);
  const cutoff   = Date.now() - 5 * 60_000;
  return activity.some(
    a => DISTRACTION_APPS.includes(a.app_name) &&
         new Date(a.timestamp).getTime() > cutoff,
  );
}

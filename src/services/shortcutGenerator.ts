export function generateiOSShortcutInstructions(): string {
  const supabaseUrl = process.env.SUPABASE_URL ?? 'YOUR_SUPABASE_URL';
  const anonKey     = process.env.SUPABASE_ANON_KEY ?? 'YOUR_SUPABASE_ANON_KEY';

  return `To connect your iPhone to Axon:

1. Open the Shortcuts app on your iPhone
2. Tap Automation → New Automation
3. Trigger: App → Opens → Select: Instagram, TikTok, YouTube (any you want Axon to know about)
4. Add Action: Get Contents of URL
   URL: ${supabaseUrl}/rest/v1/phone_activity
   Method: POST
   Headers:
     apikey: ${anonKey}
     Content-Type: application/json
   Body (JSON):
     {
       "app_name": "Shortcut Input",
       "timestamp": "Current Date"
     }
5. Save — this runs automatically when you open those apps

Axon will now know when you step away to your phone during work hours.
The Mac idle detector combined with this gives Axon real-time phone drift awareness.`;
}

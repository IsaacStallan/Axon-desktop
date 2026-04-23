import { getDeviceId } from './cloudSync';

export function generateiOSShortcutInstructions(): string {
  const supabaseUrl = process.env.SUPABASE_URL  ?? 'YOUR_SUPABASE_URL';
  const supabaseKey = process.env.SUPABASE_ANON_KEY ?? 'YOUR_SUPABASE_ANON_KEY';
  const userId      = getDeviceId();

  return `
CONNECT YOUR IPHONE TO AXON
════════════════════════════

This lets Axon know when you pick up your phone during work hours.

STEP 1 — Open Shortcuts app on your iPhone

STEP 2 — Tap Automation → New Automation

STEP 3 — Choose trigger: "App" → "Is Opened"
  Select these apps: Instagram, TikTok, YouTube, Reddit, Twitter/X, Snapchat
  (add any others you drift to)

STEP 4 — Add action: "Get Contents of URL"
  URL: ${supabaseUrl}/rest/v1/phone_activity
  Method: POST
  Headers:
    apikey: ${supabaseKey}
    Authorization: Bearer ${supabaseKey}
    Content-Type: application/json
  Request body (JSON):
    {
      "user_id": "${userId}",
      "app_name": "Shortcut Input",
      "device": "iphone"
    }

STEP 5 — Disable "Ask Before Running"

STEP 6 — Save

Test it: open Instagram on your phone, then say "Hey Axon, what have I been doing on my phone?"

════════════════════════════
Note: Axon only receives the app name and timestamp.
No content, no messages, no personal data is ever sent.
  `.trim();
}

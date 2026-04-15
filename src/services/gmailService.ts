import axios from 'axios';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { app, shell } from 'electron';

// ── Config ────────────────────────────────────────────────────────────────────

const REDIRECT_PORT = 9876;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const API_BASE      = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

// ── Token storage ─────────────────────────────────────────────────────────────

interface TokenData {
  access_token:  string;
  refresh_token: string;
  expiry_date:   number;
}

function tokenPath(): string {
  const dir = path.join(app.getPath('userData'), 'credentials');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'gmail_token.json');
}

function loadToken(): TokenData | null {
  try {
    const p = tokenPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function saveToken(token: TokenData): void {
  fs.writeFileSync(tokenPath(), JSON.stringify(token, null, 2), 'utf8');
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function refreshAccessToken(token: TokenData): Promise<TokenData> {
  const res = await axios.post(TOKEN_URL, {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type:    'refresh_token',
  });

  return {
    access_token:  res.data.access_token,
    refresh_token: token.refresh_token,   // refresh token doesn't change
    expiry_date:   Date.now() + res.data.expires_in * 1000,
  };
}

async function getAccessToken(): Promise<string> {
  let token = loadToken();

  if (!token) throw new Error('Gmail not connected — call gmail_connect first');

  // Refresh if expiring within 2 minutes
  if (token.expiry_date < Date.now() + 120_000) {
    try {
      token = await refreshAccessToken(token);
      saveToken(token);
    } catch {
      // Refresh failed — force re-auth
      fs.unlinkSync(tokenPath());
      throw new Error('Gmail token expired — call gmail_connect to re-authenticate');
    }
  }

  return token.access_token;
}

// ── Public: OAuth flow ────────────────────────────────────────────────────────

export function isGmailConnected(): boolean {
  return loadToken() !== null;
}

/**
 * Opens the browser for Google OAuth consent, starts a local redirect server,
 * exchanges the auth code for tokens, and saves them to disk.
 * Returns a success message for TTS.
 */
export async function connectGmail(): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file first, then try again.';
  }

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         SCOPES);
  authUrl.searchParams.set('access_type',   'offline');
  authUrl.searchParams.set('prompt',        'consent');

  await shell.openExternal(authUrl.toString());
  console.log('[Gmail] browser opened for auth');

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;

      const parsed = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code   = parsed.searchParams.get('code');
      const error  = parsed.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Axon: Gmail connected. You can close this tab.</h2></body></html>');
      server.close();

      if (error || !code) {
        resolve(`Gmail auth failed: ${error ?? 'no code received'}`);
        return;
      }

      try {
        const tokenRes = await axios.post(TOKEN_URL, {
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  REDIRECT_URI,
          grant_type:    'authorization_code',
        });

        saveToken({
          access_token:  tokenRes.data.access_token,
          refresh_token: tokenRes.data.refresh_token,
          expiry_date:   Date.now() + tokenRes.data.expires_in * 1000,
        });

        console.log('[Gmail] authenticated');
        resolve('Gmail connected successfully. You can now read and send emails.');
      } catch (e) {
        resolve(`Gmail auth error: ${(e as Error).message}`);
      }
    });

    server.listen(REDIRECT_PORT);
    server.on('error', (e) => resolve(`Server error: ${e.message}`));

    // Auto-timeout after 5 minutes
    setTimeout(() => {
      server.close();
      resolve('Gmail auth timed out — try again.');
    }, 5 * 60_000);
  });
}

// ── Public: Email operations ──────────────────────────────────────────────────

export interface EmailSummary {
  id:      string;
  from:    string;
  subject: string;
  date:    string;
  snippet: string;
}

/** Read recent emails from inbox (or matching a search query). */
export async function readEmails(maxResults = 5, query = 'in:inbox'): Promise<EmailSummary[]> {
  const token = await getAccessToken();

  const listRes = await axios.get(`${API_BASE}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { maxResults, q: query },
  });

  const messages: Array<{ id: string }> = listRes.data.messages ?? [];
  if (messages.length === 0) return [];

  return Promise.all(
    messages.slice(0, maxResults).map(async (msg) => {
      const detail = await axios.get(`${API_BASE}/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
      });

      const headers: Array<{ name: string; value: string }> =
        detail.data.payload?.headers ?? [];
      const get = (name: string) => headers.find(h => h.name === name)?.value ?? '';

      return {
        id:      msg.id,
        from:    get('From'),
        subject: get('Subject'),
        date:    get('Date'),
        snippet: (detail.data.snippet as string | undefined) ?? '',
      };
    }),
  );
}

export interface DraftResult {
  draftId:  string;
  to:       string;
  subject:  string;
  body:     string;
}

/** Create a Gmail draft (saves to Drafts folder) and return the draft ID. */
export async function createDraft(to: string, subject: string, body: string): Promise<DraftResult> {
  const token = await getAccessToken();

  const raw = buildRawEmail(to, subject, body);

  const res = await axios.post(
    `${API_BASE}/drafts`,
    { message: { raw } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );

  return { draftId: res.data.id as string, to, subject, body };
}

/** Send a previously created draft. */
export async function sendDraft(draftId: string): Promise<void> {
  const token = await getAccessToken();

  await axios.post(
    `${API_BASE}/drafts/send`,
    { id: draftId },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
}

// ── RFC 2822 email builder ────────────────────────────────────────────────────

function buildRawEmail(to: string, subject: string, body: string): string {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

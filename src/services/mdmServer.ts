import * as https from 'https';
import * as fs    from 'fs';
import * as path  from 'path';
import * as os    from 'os';

const MDM_DIR  = path.join(os.homedir(), '.axon-mdm');
const MDM_PORT = 8443;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DeviceCheckIn {
  udid:         string;
  messageType:  string;
  topic:        string;
  lastSeen:     string;
  screenOn?:    boolean;
  batteryLevel?: number;
}

// ── State ──────────────────────────────────────────────────────────────────────

let lastCheckIn:     DeviceCheckIn | null = null;
let checkInHistory:  DeviceCheckIn[]      = [];

// ── Server ─────────────────────────────────────────────────────────────────────

export function startMDMServer(): void {
  if (process.env.AXON_CORE_MODE !== 'true') return;

  const certPath = path.join(MDM_DIR, 'server.crt');
  const keyPath  = path.join(MDM_DIR, 'server.key');

  if (!fs.existsSync(certPath)) {
    console.log('[MDM] No certificate found — run: npm run setup-mdm');
    return;
  }

  const options = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  };

  const server = https.createServer(options, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk as string; });
    req.on('end', () => {
      if (req.url === '/checkin' || req.url === '/mdm') {
        const checkIn: DeviceCheckIn = {
          udid:        (req.headers['x-apple-mdm-udid'] as string) ?? 'unknown',
          messageType: 'CheckIn',
          topic:       'ai.aretica.axon',
          lastSeen:    new Date().toISOString(),
        };

        lastCheckIn = checkIn;
        checkInHistory.push(checkIn);
        if (checkInHistory.length > 100) checkInHistory.shift();

        console.log(`[MDM] iPhone checked in — ${checkIn.udid} at ${checkIn.lastSeen}`);

        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>');
      } else {
        res.writeHead(404).end();
      }
    });
  });

  server.listen(MDM_PORT, '0.0.0.0', () => {
    console.log(`[MDM] Server listening on port ${MDM_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[MDM] Port ${MDM_PORT} already in use — server not started`);
    } else {
      console.error('[MDM] Server error:', err);
    }
  });
}

// ── Public helpers ─────────────────────────────────────────────────────────────

export function getLastCheckIn(): DeviceCheckIn | null {
  return lastCheckIn;
}

export function isPhoneActive(): boolean {
  if (!lastCheckIn) return false;
  const minutesSince = (Date.now() - new Date(lastCheckIn.lastSeen).getTime()) / 60_000;
  return minutesSince < 2;
}

export function getPhoneIdleMinutes(): number {
  if (!lastCheckIn) return 999;
  return (Date.now() - new Date(lastCheckIn.lastSeen).getTime()) / 60_000;
}

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const execAsync = promisify(exec);

// ── Binary paths ──────────────────────────────────────────────────────────────

const AXON_DIR = join(homedir(), '.axon');
const BIN_PATH = join(AXON_DIR, 'cal_query_v2');   // v2: accepts days arg + outputs date
const SRC_PATH = join(AXON_DIR, 'cal_query_v2.swift');

// ── Swift source ──────────────────────────────────────────────────────────────
// Single-quoted JS strings so Swift's \(interpolation) escapes stay clean.
// Output format per event:  title|hour|minute

// Output format per event: title|YYYY-MM-DD|hour|minute
// Accepts one optional CLI argument: number of days to query (default 1)
const SWIFT_LINES = [
  'import Foundation',
  'import EventKit',
  '',
  'let store = EKEventStore()',
  'let sem = DispatchSemaphore(value: 0)',
  '',
  'let days = Int(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "1") ?? 1',
  '',
  'func queryAndPrint() {',
  '    let cal = Calendar.current',
  '    let start = cal.startOfDay(for: Date())',
  '    guard let end = cal.date(byAdding: .day, value: days, to: start) else { sem.signal(); return }',
  '    let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)',
  '    let fmt = DateFormatter()',
  '    fmt.dateFormat = "yyyy-MM-dd"',
  '    for evt in store.events(matching: pred).sorted(by: { $0.startDate < $1.startDate }) {',
  '        let c = cal.dateComponents([.hour, .minute], from: evt.startDate)',
  '        let title = evt.title ?? ""',
  '        let dateStr = fmt.string(from: evt.startDate)',
  '        let h = c.hour ?? 0',
  '        let m = c.minute ?? 0',
  '        print("\\(title)|\\(dateStr)|\\(h)|\\(m)")',
  '    }',
  '    sem.signal()',
  '}',
  '',
  'if #available(macOS 14.0, *) {',
  '    store.requestFullAccessToEvents { granted, _ in',
  '        guard granted else { sem.signal(); return }',
  '        queryAndPrint()',
  '    }',
  '} else {',
  '    store.requestAccess(to: .event) { granted, _ in',
  '        guard granted else { sem.signal(); return }',
  '        queryAndPrint()',
  '    }',
  '}',
  '',
  'sem.wait()',
];

const SWIFT_SOURCE = SWIFT_LINES.join('\n');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  title:   string;
  date:    string;   // YYYY-MM-DD
  hour:    number;
  minute:  number;
  startMs: number;   // epoch ms
}

// ── Compile once ──────────────────────────────────────────────────────────────

let compilePromise: Promise<boolean> | null = null;

function ensureCompiled(): Promise<boolean> {
  if (compilePromise) return compilePromise;

  compilePromise = (async () => {
    if (!existsSync(AXON_DIR)) mkdirSync(AXON_DIR, { recursive: true });

    if (existsSync(BIN_PATH)) {
      console.log('[Calendar] using cached binary');
      return true;
    }

    console.log('[Calendar] compiling EventKit query binary (one-time ~25 s)...');
    writeFileSync(SRC_PATH, SWIFT_SOURCE, 'utf8');

    try {
      await execAsync(`swiftc "${SRC_PATH}" -o "${BIN_PATH}"`, { timeout: 90_000 });
      console.log('[Calendar] binary ready at', BIN_PATH);
      return true;
    } catch (e) {
      console.warn('[Calendar] swiftc compile failed:', (e as Error).message);
      return false;
    }
  })();

  return compilePromise;
}

// Start compiling in the background immediately on module load
if (process.platform === 'darwin') {
  void ensureCompiled();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getTodayEvents(days = 1): Promise<CalendarEvent[]> {
  if (process.platform !== 'darwin') return [];

  const ready = await ensureCompiled();
  if (!ready) return [];

  try {
    const { stdout } = await execAsync(`"${BIN_PATH}" ${days}`, { timeout: 15_000 });

    const events: CalendarEvent[] = stdout
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split('|');
        if (parts.length < 4) return null;
        const title  = parts[0].trim();
        const date   = parts[1].trim();          // YYYY-MM-DD
        const hour   = parseInt(parts[2], 10);
        const minute = parseInt(parts[3], 10);
        if (!title || !date || isNaN(hour) || isNaN(minute)) return null;
        const [y, mo, d] = date.split('-').map(Number);
        const startMs = new Date(y, mo - 1, d, hour, minute).getTime();
        return { title, date, hour, minute, startMs };
      })
      .filter((e): e is CalendarEvent => e !== null);

    return events.sort((a, b) => a.startMs - b.startMs);
  } catch (e) {
    console.warn('[Calendar] query failed:', (e as Error).message);
    return [];
  }
}

export function getUpcomingEvent(events: CalendarEvent[], withinMins = 30): CalendarEvent | null {
  const now       = Date.now();
  const windowEnd = now + withinMins * 60_000;
  return events.find(e => e.startMs > now && e.startMs <= windowEnd) ?? null;
}

export function formatEventTime(event: CalendarEvent): string {
  const period = event.hour < 12 ? 'AM' : 'PM';
  const h      = event.hour === 0 ? 12 : event.hour > 12 ? event.hour - 12 : event.hour;
  const m      = event.minute === 0 ? '' : `:${String(event.minute).padStart(2, '0')}`;
  return `${h}${m} ${period}`;
}

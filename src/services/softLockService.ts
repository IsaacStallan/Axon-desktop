import { exec }    from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoftLockState {
  active:       boolean;
  reason:       string;          // "Gym time", "Wind down", "Sleep"
  startTime:    string;          // ISO
  endTime:      string;          // ISO
  canOverride:  boolean;
  overrideUsed: boolean;
}

// ── Module state ──────────────────────────────────────────────────────────────

let lockState:    SoftLockState | null = null;
let lockTimer:    NodeJS.Timeout | null = null;
let savedWindows: string[] = [];

// Callbacks registered by main.ts
let onActivateCb:   ((state: SoftLockState) => void) | null = null;
let onDeactivateCb: (() => void) | null = null;

// ── Callback registration ─────────────────────────────────────────────────────

export function setSoftLockCallbacks(
  onActivate:   (state: SoftLockState) => void,
  onDeactivate: () => void,
): void {
  onActivateCb   = onActivate;
  onDeactivateCb = onDeactivate;
}

// ── Public state accessor ─────────────────────────────────────────────────────

export function getSoftLockState(): SoftLockState | null {
  return lockState;
}

// ── Window management ─────────────────────────────────────────────────────────

async function saveAndMinimizeWindows(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get name of every process whose visible is true'`,
      { timeout: 5_000 },
    );
    savedWindows = stdout.trim().split(', ').map(n => n.trim()).filter(Boolean);
    await execAsync(
      `osascript -e 'tell application "System Events" to set visible of every process to false'`,
      { timeout: 5_000 },
    );
    console.log('[SoftLock] minimized windows, saved:', savedWindows.join(', '));
  } catch (e) {
    console.warn('[SoftLock] could not minimize windows:', e);
  }
}

async function restoreWindows(): Promise<void> {
  if (process.platform !== 'darwin' || savedWindows.length === 0) return;
  for (const appName of savedWindows) {
    const safe = appName.replace(/"/g, '\\"');
    await execAsync(
      `osascript -e 'tell application "${safe}" to activate'`,
      { timeout: 3_000 },
    ).catch(() => {});
  }
  console.log('[SoftLock] windows restored');
  savedWindows = [];
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function activateSoftLock(reason: string, durationMinutes: number): Promise<void> {
  if (lockState?.active) {
    console.log('[SoftLock] already active — ignoring duplicate activate');
    return;
  }

  const now     = new Date();
  const endTime = new Date(now.getTime() + durationMinutes * 60_000).toISOString();

  lockState = {
    active:       true,
    reason,
    startTime:    now.toISOString(),
    endTime,
    canOverride:  true,
    overrideUsed: false,
  };

  console.log(`[SoftLock] activating: "${reason}" for ${durationMinutes}min`);

  await saveAndMinimizeWindows();
  onActivateCb?.(lockState);

  lockTimer = setTimeout(() => {
    void deactivateSoftLock();
  }, durationMinutes * 60_000);
}

export async function deactivateSoftLock(): Promise<void> {
  if (!lockState) return;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  lockState = null;
  onDeactivateCb?.();
  await restoreWindows();
  console.log('[SoftLock] deactivated');
}

export function logSoftLockOverride(): void {
  if (lockState) {
    lockState.overrideUsed = true;
    console.log('[SoftLock] override logged');
  }
}

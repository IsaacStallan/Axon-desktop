import { exec } from 'child_process';
import { promisify } from 'util';

console.log('[AppControl] module loaded');

const execAsync = promisify(exec);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Run an AppleScript. Only available on macOS. */
async function osa(script: string): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('AppControl is macOS only');
  }
  // Escape single quotes for shell embedding
  const safe = script.replace(/'/g, "'\\''");
  const { stdout, stderr } = await execAsync(`osascript -e '${safe}'`, { timeout: 15_000 });
  return (stdout + stderr).trim();
}

/** Parse "cmd+shift+p" → { key: "p", modifiers: "{command down, shift down}" } */
function parseShortcut(keys: string): { key: string; usingClause: string } {
  const modMap: Record<string, string> = {
    cmd:     'command down', command: 'command down',
    shift:   'shift down',
    alt:     'option down',  option:  'option down',
    ctrl:    'control down', control: 'control down',
  };
  const parts     = keys.toLowerCase().replace(/\s/g, '').split('+');
  const key       = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map(p => modMap[p] ?? `${p} down`);
  const usingClause = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  return { key, usingClause };
}

/** Escape a string value for use inside AppleScript double-quoted strings. */
function asStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Accessibility permission guard ────────────────────────────────────────────

let permissionWarned = false;

async function ensureAccessibility(): Promise<void> {
  if (process.platform !== 'darwin' || permissionWarned) return;
  try {
    // Quick probe — if this succeeds, permissions are granted
    await execAsync(
      `osascript -e 'tell application "System Events" to get name of processes'`,
      { timeout: 3_000 },
    );
  } catch {
    permissionWarned = true;
    console.warn(
      '[AppControl] Accessibility permission needed. ' +
      'Go to System Settings → Privacy & Security → Accessibility → enable Axon.',
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function appFocus(appName: string): Promise<string> {
  await osa(`tell application "${asStr(appName)}" to activate`);
  return `Focused ${appName}`;
}

export async function appClick(appName: string, elementDescription: string): Promise<string> {
  await ensureAccessibility();
  const desc = asStr(elementDescription);
  const app  = asStr(appName);
  // Try by name first, then by description, then by value
  const script = `
tell application "System Events"
  tell process "${app}"
    set frontmost to true
    try
      click (first UI element of window 1 whose name contains "${desc}")
      return "clicked by name"
    end try
    try
      click (first UI element of window 1 whose description contains "${desc}")
      return "clicked by description"
    end try
    try
      click (first button whose title contains "${desc}")
      return "clicked by title"
    end try
    return "element not found"
  end tell
end tell`;
  const result = await osa(script);
  if (result === 'element not found') throw new Error(`Element "${elementDescription}" not found in ${appName}`);
  return `Clicked "${elementDescription}" in ${appName}`;
}

export async function appType(appName: string, text: string): Promise<string> {
  await ensureAccessibility();
  const script = `
tell application "${asStr(appName)}" to activate
tell application "System Events"
  keystroke "${asStr(text)}"
end tell`;
  await osa(script);
  return `Typed text in ${appName}`;
}

export async function appRead(appName: string, elementDescription: string): Promise<string> {
  await ensureAccessibility();
  const desc = asStr(elementDescription);
  const app  = asStr(appName);
  const script = `
tell application "System Events"
  tell process "${app}"
    try
      return value of (first UI element of window 1 whose name contains "${desc}")
    end try
    try
      return value of text field 1 of window 1
    end try
    return ""
  end tell
end tell`;
  const result = await osa(script);
  return result || `No readable content for "${elementDescription}" in ${appName}`;
}

export async function appMenu(appName: string, menuPath: string[]): Promise<string> {
  if (menuPath.length < 2) return 'Need at least two items: ["Menu", "Item"]';
  await ensureAccessibility();
  const app  = asStr(appName);
  const root = asStr(menuPath[0]);

  let script = `tell application "${app}" to activate\n`;
  script += `tell application "System Events"\n  tell process "${app}"\n`;
  script += `    click menu bar item "${root}" of menu bar 1\n`;

  for (let i = 1; i < menuPath.length; i++) {
    const item = asStr(menuPath[i]);
    script += `    click menu item "${item}" of menu 1 of menu bar item "${root}" of menu bar 1\n`;
  }
  script += `  end tell\nend tell`;
  await osa(script);
  return `Menu: ${menuPath.join(' → ')} in ${appName}`;
}

export async function appShortcut(appName: string, keys: string): Promise<string> {
  await ensureAccessibility();
  const { key, usingClause } = parseShortcut(keys);
  const script = `
tell application "${asStr(appName)}" to activate
tell application "System Events"
  keystroke "${asStr(key)}"${usingClause}
end tell`;
  await osa(script);
  return `Sent ${keys} to ${appName}`;
}

export async function appSpotifyPlay(query?: string): Promise<string> {
  if (!query) {
    const script = `
tell application "Spotify"
  activate
  if player state is playing then
    pause
    return "paused"
  else
    play
    return "resumed"
  end if
end tell`;
    const result = await osa(script);
    return `Spotify ${result}`;
  }

  const encoded = encodeURIComponent(query);
  const script  = `
tell application "Spotify"
  activate
  open location "spotify:search:${encoded}"
end tell`;
  await osa(script);
  return `Spotify: searching for "${query}"`;
}

export async function appVscodeOpen(filePath: string): Promise<string> {
  const safe = filePath.replace(/"/g, '\\"');
  await execAsync(`code "${safe}"`, { timeout: 10_000 });
  return `Opened in VS Code: ${filePath}`;
}

export async function appVscodeCommand(command: string): Promise<string> {
  await ensureAccessibility();
  const script = `
tell application "Visual Studio Code" to activate
delay 0.3
tell application "System Events"
  keystroke "p" using {command down, shift down}
  delay 0.5
  keystroke "${asStr(command)}"
  delay 0.2
  key code 36
end tell`;
  await osa(script);
  return `VS Code command: ${command}`;
}

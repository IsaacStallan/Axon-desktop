import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateSoul } from './memoryService';

const execAsync = promisify(exec);

// ── Tool definitions (sent to Claude on every turn) ───────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name:        'open_url',
    description: 'Open a specific website or URL in the default browser. ' +
                 'Use when Isaac asks to open, go to, or visit a website.',
    input_schema: {
      type:       'object',
      properties: { url: { type: 'string', description: 'Full URL including https://' } },
      required:   ['url'],
    },
  },
  {
    name:        'web_search',
    description: 'Search the web for something — opens Google in the browser. ' +
                 'Use when Isaac asks to search for, look up, or find something online.',
    input_schema: {
      type:       'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required:   ['query'],
    },
  },
  {
    name:        'open_folder',
    description: 'Open a folder in Windows File Explorer. ' +
                 'Use when Isaac asks to open a folder, directory, or location on his PC. ' +
                 'Common paths: Desktop, Documents, Downloads are under C:\\Users\\isaac\\.',
    input_schema: {
      type:       'object',
      properties: { path: { type: 'string', description: 'Folder path, e.g. C:\\Users\\isaac\\Desktop' } },
      required:   ['path'],
    },
  },
  {
    name:        'open_app',
    description: 'Launch an application on Windows. ' +
                 'Use when Isaac asks to open, launch, or start a program. ' +
                 'Examples: "chrome", "spotify", "notepad", "calculator", "discord", "steam", "code" (VS Code).',
    input_schema: {
      type:       'object',
      properties: {
        name: { type: 'string', description: 'App executable name or registered app name, e.g. "chrome", "notepad"' },
      },
      required:   ['name'],
    },
  },
  {
    name:        'write_soul',
    description: 'Read all of Axon\'s memory — every conversation and learned fact — ' +
                 'and generate personality.md: a soul document that defines how Axon thinks, ' +
                 'communicates, and makes decisions when working with Isaac. ' +
                 'Use when Isaac asks Axon to define its personality, write its soul, ' +
                 'calibrate itself, or learn from past conversations.',
    input_schema: {
      type:       'object',
      properties: {},
      required:   [],
    },
  },
  {
    name:        'run_command',
    description: 'Run a PowerShell command on Isaac\'s PC. ' +
                 'Use for system tasks: creating files, moving things, checking system info, etc. ' +
                 'Do NOT use this for anything destructive unless Isaac explicitly asks.',
    input_schema: {
      type:       'object',
      properties: {
        command:     { type: 'string', description: 'PowerShell command to execute' },
        description: { type: 'string', description: 'One-line human description of what this command does' },
      },
      required:   ['command', 'description'],
    },
  },
];

// ── Execution ─────────────────────────────────────────────────────────────────

// All Windows shell operations go through PowerShell Start-Process or Invoke-Expression
// so URLs, paths, and app names with special characters are handled safely.

export async function executeTool(
  name:  string,
  input: Record<string, string>,
): Promise<string> {
  console.log(`[Tool] executing: ${name}`, input);

  try {
    switch (name) {

      case 'open_url': {
        // Start-Process hands the URL to the default browser via Windows shell association
        const safe = input.url.replace(/'/g, '%27');
        await execAsync(`powershell -NoProfile -Command "Start-Process '${safe}'"`, { timeout: 10_000 });
        return `Opened ${input.url}`;
      }

      case 'web_search': {
        const query = encodeURIComponent(input.query);
        const url   = `https://www.google.com/search?q=${query}`;
        await execAsync(`powershell -NoProfile -Command "Start-Process '${url}'"`, { timeout: 10_000 });
        return `Searched for "${input.query}"`;
      }

      case 'open_folder': {
        // explorer.exe expects backslashes; pass through PowerShell so the path is validated
        const safe = input.path.replace(/'/g, "''");
        await execAsync(`powershell -NoProfile -Command "Invoke-Item '${safe}'"`, { timeout: 10_000 });
        return `Opened folder: ${input.path}`;
      }

      case 'open_app': {
        const safe = input.name.replace(/'/g, "''");
        await execAsync(`powershell -NoProfile -Command "Start-Process '${safe}'"`, { timeout: 10_000 });
        return `Launched ${input.name}`;
      }

      case 'write_soul': {
        console.log('[Tool] generating soul from full memory corpus...');
        const result = await generateSoul();
        return result;
      }

      case 'run_command': {
        console.log(`[Tool] run_command: ${input.description} → ${input.command}`);
        const { stdout, stderr } = await execAsync(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "${input.command.replace(/"/g, '\\"')}"`,
          { timeout: 30_000 },
        );
        const out = (stdout + stderr).trim();
        return out.length > 0 ? out.slice(0, 500) : 'Command completed with no output.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Tool] ${name} failed:`, msg);
    return `Error: ${msg}`;
  }
}

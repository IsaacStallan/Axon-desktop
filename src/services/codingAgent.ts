import Anthropic from '@anthropic-ai/sdk';
import { spawn }  from 'child_process';
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { BrowserWindow } from 'electron';
import { speak } from './elevenLabsService';

console.log('[CodingAgent] module loaded');

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CodingTask {
  description: string;
  language?:   'python' | 'typescript' | 'javascript' | 'bash' | 'auto';
  outputFile?: string;
  context?:    string;
}

export interface CodingResult {
  success:   boolean;
  code:      string;
  output:    string;
  attempts:  number;
  savedTo?:  string;
  error?:    string;
}

type Language = 'python' | 'typescript' | 'javascript' | 'bash';

interface ExecResult {
  exitCode: number;
  stdout:   string;
  stderr:   string;
  timedOut: boolean;
}

interface CodingLogEntry {
  timestamp:   string;
  task:        string;
  language:    string;
  attempt:     number;
  exitCode:    number;
  output:      string;
  success:     boolean;
}

// ── Orb window reference ───────────────────────────────────────────────────────

let orbWin: BrowserWindow | null = null;
export function setOrbWindow(win: BrowserWindow): void { orbWin = win; }

// ── Anthropic client ───────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 2 });

// ── Directory helpers ──────────────────────────────────────────────────────────

function axonDir(): string {
  const dir = path.join(os.homedir(), '.axon');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempDir(): string {
  const dir = path.join(axonDir(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── IPC helpers ────────────────────────────────────────────────────────────────

function sendUpdate(label: string, status: 'running' | 'completed' | 'failed'): void {
  orbWin?.webContents.send('axon:agents', [{ id: 'coding', description: label, status }]);
  orbWin?.webContents.send('axon:activity', label);
}

// ── Attempt log ────────────────────────────────────────────────────────────────

function appendLog(entry: CodingLogEntry): void {
  const logPath = path.join(axonDir(), 'coding_log.json');
  let entries: CodingLogEntry[] = [];
  if (fs.existsSync(logPath)) {
    try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { entries = []; }
  }
  entries.push(entry);
  if (entries.length > 100) entries = entries.slice(-100);
  try { fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ── Language helpers ───────────────────────────────────────────────────────────

const EXT: Record<Language, string> = {
  python:     '.py',
  typescript: '.ts',
  javascript: '.js',
  bash:       '.sh',
};

function detectLanguage(code: string): Language {
  const head = code.slice(0, 400);
  if (/^#!.*python/m.test(head) || /\bdef \w+\s*\(/.test(code) || /\bimport \w/.test(code) && /print\(/.test(code))
    return 'python';
  if (/^#!.*\bbash\b/m.test(head) || /^#!.*\bsh\b/m.test(head) || /\$\{[^}]+\}/.test(code) || /\becho\b/.test(head))
    return 'bash';
  if (/\binterface\s+\w/.test(code) || /\btype\s+\w+\s*=/.test(code) || /:\s*(string|number|boolean|void)\b/.test(code))
    return 'typescript';
  return 'javascript';
}

function resolveLanguage(task: CodingTask, code = ''): Language {
  if (!task.language || task.language === 'auto') return detectLanguage(code);
  return task.language as Language;
}

// ── Network request scanner ────────────────────────────────────────────────────

function scanNetworkRequests(code: string): string[] {
  const urls = code.match(/https?:\/\/[^\s'"`,)]+/g) ?? [];
  return [...new Set(urls)];
}

// ── Error detection ────────────────────────────────────────────────────────────

const ERROR_KEYWORDS = [
  'Traceback', 'SyntaxError', 'TypeError', 'NameError', 'AttributeError',
  'ImportError', 'ModuleNotFoundError', 'IndentationError', 'ValueError',
  'ReferenceError', 'SyntaxError', 'Cannot find module', 'error TS',
  'ENOENT', 'EACCES', 'Error:', 'fatal error',
];

function isFailure(result: ExecResult): boolean {
  if (result.timedOut)   return true;
  if (result.exitCode !== 0) return true;
  // Exit 0 but stderr contains real errors (not just warnings)
  return ERROR_KEYWORDS.some(kw => result.stderr.includes(kw));
}

// ── Code executor ──────────────────────────────────────────────────────────────

async function executeFile(filePath: string, lang: Language): Promise<ExecResult> {
  const cmdMap: Record<Language, [string, string[]]> = {
    python:     ['python3', [filePath]],
    typescript: ['npx',     ['ts-node', '--skip-project', filePath]],
    javascript: ['node',    [filePath]],
    bash:       ['bash',    [filePath]],
  };

  const [cmd, args] = cmdMap[lang];

  return new Promise<ExecResult>((resolve) => {
    const proc    = spawn(cmd, args, { cwd: axonDir(), shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let   killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      console.warn(`[CodingAgent] execution timed out after 30s — killed`);
    }, 30_000);

    proc.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? -1 : (code ?? -1),
        stdout:   Buffer.concat(stdoutChunks).toString().trim(),
        stderr:   Buffer.concat(stderrChunks).toString().trim(),
        timedOut: killed,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: '', stderr: err.message, timedOut: false });
    });
  });
}

// ── Code extraction from Claude response ──────────────────────────────────────

function extractCode(text: string): string {
  // Prefer fenced code block
  const fenced = text.match(/```(?:\w+)?\n([\s\S]+?)```/);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

// ── Content writing helpers ────────────────────────────────────────────────────

function isContentWritingTask(description: string): boolean {
  const contentKeywords = [
    'write', 'create a document', 'write a script', 'draft',
    'create a report', 'write a story', 'generate content',
    'write a plan', 'create a one-pager', 'write an email',
  ];
  const codeKeywords = [
    'implement', 'fix', 'debug', 'code', 'function', 'class',
    'api', 'database', 'algorithm', 'parse', 'compile',
  ];

  const lowerDesc = description.toLowerCase();
  const hasContentKeyword = contentKeywords.some(k => lowerDesc.includes(k));
  const hasCodeKeyword    = codeKeywords.some(k => lowerDesc.includes(k));

  return hasContentKeyword && !hasCodeKeyword;
}

async function callHaiku(prompt: string): Promise<string> {
  const resp = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages:   [{ role: 'user', content: prompt }],
  });
  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return block?.text.trim() ?? '';
}

async function handleContentTask(description: string, outputFile: string): Promise<CodingResult> {
  console.log('[CodingAgent] content task detected — using direct generation');

  const response = await callHaiku(
    `${description}\n\nWrite the complete content now. Be thorough and detailed.\nOutput ONLY the content itself — no preamble, no explanation.`,
  );

  const resolved = path.resolve(outputFile);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, response, 'utf8');
  console.log(`[CodingAgent] content written to ${resolved}`);

  sendUpdate('✓ Coding agent — content written', 'completed');
  await speak(`Done — content written to ${path.basename(outputFile)}.`).catch(() => {});

  return {
    success:  true,
    code:     response,
    output:   `Content written to ${resolved}`,
    attempts: 1,
    savedTo:  resolved,
  };
}

// ── Planning call — returns language + code ────────────────────────────────────

interface Plan { language: Language; code: string }

async function planCode(task: CodingTask): Promise<Plan> {
  const langHint = task.language && task.language !== 'auto'
    ? `Language: ${task.language}.`
    : 'Choose the most appropriate language (python, typescript, javascript, or bash).';

  const resp = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role:    'user',
      content:
        `You are an expert developer. Write working code for this task.\n\n` +
        `Task: ${task.description}\n` +
        (task.context ? `\nContext:\n${task.context}\n` : '') +
        `\n${langHint}\n\n` +
        `Reply with ONLY the code. No explanation, no markdown prose outside the code block.\n` +
        `Start with the language on line 1 as a comment: # language: python  OR  // language: typescript\n` +
        `Then the complete, runnable code.\n\n` +
        `CRITICAL: If you need to write any text content to a file, use base64 encoding to avoid string escaping issues:\n\n` +
        `import base64\n` +
        `content = base64.b64decode("BASE64_ENCODED_CONTENT").decode('utf-8')\n` +
        `with open('output.md', 'w') as f:\n` +
        `    f.write(content)\n\n` +
        `Never use multi-line strings with triple quotes for content that contains apostrophes, quotes, or special characters.`,
    }],
  });

  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const raw   = block?.text.trim() ?? '';
  const code  = extractCode(raw);

  // Read language hint from the comment in the code, else auto-detect
  const langComment = code.match(/^(?:#|\/\/)\s*language:\s*(\w+)/i)?.[1]?.toLowerCase();
  const validLangs: Language[] = ['python', 'typescript', 'javascript', 'bash'];
  const lang = validLangs.includes(langComment as Language)
    ? (langComment as Language)
    : resolveLanguage(task, code);

  return { language: lang, code };
}

// ── Fix call — returns corrected code ─────────────────────────────────────────

async function fixCode(
  task:    CodingTask,
  code:    string,
  error:   string,
  attempt: number,
): Promise<string> {
  const resp = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role:    'user',
      content:
        `Task: ${task.description}\n\n` +
        `Previous code:\n\`\`\`\n${code}\n\`\`\`\n\n` +
        `Error output:\n${error.slice(0, 1500)}\n\n` +
        `Attempt: ${attempt} of 5\n\n` +
        `Fix the code. Return only the corrected code, no explanation.`,
    }],
  });

  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return extractCode(block?.text.trim() ?? code);
}

// ── Main loop ──────────────────────────────────────────────────────────────────

export async function runCodingLoop(task: CodingTask): Promise<CodingResult> {
  console.log(`[CodingAgent] task: ${task.description.slice(0, 80)}`);

  if (isContentWritingTask(task.description) && task.outputFile) {
    return handleContentTask(task.description, task.outputFile);
  }

  const MAX_ATTEMPTS = 5;
  const timestamp    = Date.now();

  // ── Plan ────────────────────────────────────────────────────────────────────
  sendUpdate(`⟳ Coding agent — writing ${task.language ?? 'auto'} code...`, 'running');

  let plan: Plan;
  try {
    plan = await planCode(task);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.warn('[CodingAgent] planning failed:', err);
    sendUpdate('✗ Coding agent — planning failed', 'failed');
    return { success: false, code: '', output: '', attempts: 0, error: err };
  }

  let { language, code } = plan;
  const filePath = path.join(tempDir(), `task_${timestamp}${EXT[language]}`);

  // Network request safety scan
  const urls = scanNetworkRequests(code);
  if (urls.length > 0) {
    console.log(`[CodingAgent] network requests detected: ${urls.join(', ')}`);
  }

  let lastOutput = '';
  let success    = false;

  // ── Execute + Fix loop ───────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Write file
    try {
      fs.writeFileSync(filePath, code, 'utf8');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      return { success: false, code, output: '', attempts: attempt, error: `Could not write temp file: ${err}` };
    }

    sendUpdate(`⟳ Coding agent — attempt ${attempt}: executing...`, 'running');
    console.log(`[CodingAgent] attempt ${attempt}/${MAX_ATTEMPTS} — executing ${filePath}`);

    const result = await executeFile(filePath, language);
    lastOutput   = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim();

    appendLog({
      timestamp: new Date().toISOString(),
      task:      task.description.slice(0, 200),
      language,
      attempt,
      exitCode:  result.exitCode,
      output:    lastOutput.slice(0, 500),
      success:   !isFailure(result),
    });

    if (!isFailure(result)) {
      success = true;
      console.log(`[CodingAgent] success on attempt ${attempt}`);
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      const errorDetail = result.timedOut
        ? 'Execution timed out after 30 seconds.'
        : (result.stderr || result.stdout || 'Non-zero exit code with no output.').slice(0, 1000);

      sendUpdate(`⟳ Coding agent — attempt ${attempt}: fixing error...`, 'running');
      console.log(`[CodingAgent] attempt ${attempt} failed — requesting fix`);

      try {
        code = await fixCode(task, code, errorDetail, attempt);
      } catch (e) {
        console.warn('[CodingAgent] fix call failed:', e);
        // Keep current code and try once more
      }
    }
  }

  // ── Report + save ────────────────────────────────────────────────────────────

  const attempts = success
    ? (appendLog as unknown as { callCount?: number }).callCount ?? MAX_ATTEMPTS
    : MAX_ATTEMPTS;

  // Count attempts from the log (simpler: just track with a counter)
  let attemptCount = 0;
  try {
    const logPath = path.join(axonDir(), 'coding_log.json');
    const entries: CodingLogEntry[] = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const relevant = entries.filter(
      e => e.timestamp > new Date(timestamp).toISOString() && e.task === task.description.slice(0, 200),
    );
    attemptCount = relevant.length;
  } catch {
    attemptCount = MAX_ATTEMPTS;
  }

  let savedTo: string | undefined;

  if (success && task.outputFile) {
    try {
      const outDir = path.dirname(path.resolve(task.outputFile));
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(filePath, path.resolve(task.outputFile));
      savedTo = path.resolve(task.outputFile);
      console.log(`[CodingAgent] saved to ${savedTo}`);
    } catch (e) {
      console.warn('[CodingAgent] could not save output file:', e);
    }
  }

  const outputSummary = lastOutput.slice(0, 200);

  if (success) {
    sendUpdate(`✓ Coding agent — completed in ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}`, 'completed');
    const msg = outputSummary
      ? `Done — ${task.description.split(' ').slice(0, 6).join(' ')}. Output: ${outputSummary}.`
      : `Done — ${task.description.split(' ').slice(0, 8).join(' ')}.`;
    await speak(msg).catch(() => {});
  } else {
    sendUpdate('✗ Coding agent — failed after 5 attempts', 'failed');
    const errSummary = lastOutput.slice(0, 120);
    await speak(`Couldn't get it working after 5 attempts — ${errSummary || 'check the coding log for details'}.`).catch(() => {});
  }

  // Clean up temp file on success (keep on failure for debugging)
  if (success && !task.outputFile) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }

  return {
    success,
    code,
    output:   lastOutput,
    attempts: attemptCount,
    savedTo,
    error:    success ? undefined : lastOutput.slice(0, 300),
  };
}

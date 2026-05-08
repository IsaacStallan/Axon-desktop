import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import {
  browserOpen, browserSearch, browserClick, browserType,
  browserExtract, browserScroll, browserWait,
} from './browserAgent';
import { checkFeatureAccess } from './rateLimiter';

console.log('[SubAgentOrchestrator] module loaded');

// ── Orb window reference (for axon:agents IPC) ────────────────────────────────

let orbWin: BrowserWindow | null = null;

export function setOrbWindow(win: BrowserWindow): void {
  orbWin = win;
}

const execAsync = promisify(exec);
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 3 });

// ── Agent state tracking ──────────────────────────────────────────────────────

interface AgentEntry {
  id:          string;
  description: string;
  status:      'running' | 'completed' | 'failed';
}

const liveAgents = new Map<string, AgentEntry>();

function broadcastAgents(): void {
  const agents = [...liveAgents.values()];
  orbWin?.webContents.send('axon:agents', agents);
}

function agentStart(id: string, description: string): void {
  liveAgents.set(id, { id, description, status: 'running' });
  orbWin?.webContents.send('axon:activity', `Running ${liveAgents.size} agent${liveAgents.size > 1 ? 's' : ''}…`);
  broadcastAgents();
}

function agentDone(id: string, success: boolean): void {
  const entry = liveAgents.get(id);
  if (entry) {
    entry.status = success ? 'completed' : 'failed';
    broadcastAgents();
    // Remove completed/failed agents after a short display window
    setTimeout(() => {
      liveAgents.delete(id);
      if (liveAgents.size === 0) {
        orbWin?.webContents.send('axon:agents', []);
        orbWin?.webContents.send('axon:activity', 'Monitoring your activity');
      } else {
        broadcastAgents();
      }
    }, 4000);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubTask {
  id:          string;
  type:        'browser' | 'file' | 'research' | 'write' | 'code';
  instruction: string;
  tools:       string[];
  dependsOn?:  string[];
}

export interface AgentResult {
  taskId:  string;
  success: boolean;
  output:  string;
  error?:  string;
}

// ── Tool definitions per agent type ───────────────────────────────────────────

const BROWSER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'browser_open',
    description: 'Navigate to a URL in the controlled browser.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_search',
    description: 'Search on Google, YouTube, or Reddit.',
    input_schema: {
      type: 'object',
      properties: {
        query:  { type: 'string' },
        engine: { type: 'string', description: '"google" | "youtube" | "reddit"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click a page element by CSS selector or visible text.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  },
  {
    name: 'browser_type',
    description: 'Type text into a page field.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract text content from the page or a CSS selector.',
    input_schema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or "body" for full page' } }, required: ['selector'] },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: '"up" | "down"' },
        amount:    { type: 'number', description: 'Pixels to scroll' },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a number of milliseconds.',
    input_schema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  },
];

const FILE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_cmd',
    description: 'Run a shell command to read or write files.',
    input_schema: {
      type: 'object',
      properties: {
        command:     { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command', 'description'],
    },
  },
];

const TOOLS_BY_TYPE: Record<SubTask['type'], Anthropic.Tool[]> = {
  browser:  BROWSER_TOOLS,
  research: BROWSER_TOOLS,
  file:     FILE_TOOLS,
  code:     FILE_TOOLS,
  write:    [],
};

// ── Tool executor (used inside sub-agents only — no import from toolService) ──

async function executeSubAgentTool(name: string, input: Record<string, string>): Promise<string> {
  try {
    switch (name) {
      case 'browser_open':    return await browserOpen(input.url ?? '');
      case 'browser_search':  return await browserSearch(input.query ?? '', (input.engine as 'google' | 'youtube' | 'reddit') ?? 'google');
      case 'browser_click':   return await browserClick(input.selector ?? '');
      case 'browser_type':    return await browserType(input.selector ?? '', input.text ?? '');
      case 'browser_extract': return await browserExtract(input.selector ?? 'body');
      case 'browser_scroll':  return await browserScroll((input.direction as 'up' | 'down') ?? 'down', Number(input.amount) || 300);
      case 'browser_wait':    return await browserWait(Number(input.ms) || 1000);
      case 'run_cmd': {
        const { stdout, stderr } = await execAsync(input.command, { timeout: 30_000 });
        return (stdout + stderr).trim().slice(0, 2000) || 'Command completed.';
      }
      default: return `Unknown agent tool: ${name}`;
    }
  } catch (e) {
    return `Tool error (${name}): ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Single agent runner ────────────────────────────────────────────────────────

async function executeAgent(task: SubTask, priorResults: AgentResult[]): Promise<AgentResult> {
  console.log(`[SubAgent] running task ${task.id}: ${task.instruction.slice(0, 60)}`);
  agentStart(task.id, task.instruction.slice(0, 60));

  const context = priorResults.length > 0
    ? `\n\nContext from completed tasks:\n${priorResults.map(r => `Task ${r.taskId}: ${r.output.slice(0, 500)}`).join('\n\n')}`
    : '';

  const messages: Anthropic.MessageParam[] = [{
    role:    'user',
    content: task.instruction + context,
  }];

  const tools = TOOLS_BY_TYPE[task.type] ?? [];

  try {
    let response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4000,
      tools:      tools.length > 0 ? tools : undefined,
      messages,
    });

    // Tool-use loop
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async block => ({
          type:        'tool_result' as const,
          tool_use_id: block.id,
          content:     await executeSubAgentTool(block.name, block.input as Record<string, string>),
        })),
      );

      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 4000,
        tools:      tools.length > 0 ? tools : undefined,
        messages,
      });
    }

    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    agentDone(task.id, true);
    return { taskId: task.id, success: true, output: text };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[SubAgent] task ${task.id} failed:`, error);
    agentDone(task.id, false);
    return { taskId: task.id, success: false, output: '', error };
  }
}

// ── Parallel + sequential execution ───────────────────────────────────────────

async function executeParallel(tasks: SubTask[], priorResults: AgentResult[]): Promise<AgentResult[]> {
  const MAX_PARALLEL = 3;
  const results: AgentResult[] = [];

  for (let i = 0; i < tasks.length; i += MAX_PARALLEL) {
    const batch        = tasks.slice(i, i + MAX_PARALLEL);
    const batchResults = await Promise.all(batch.map(t => executeAgent(t, priorResults)));
    results.push(...batchResults);
  }

  return results;
}

async function executeSequentialWithDelay(tasks: SubTask[], priorResults: AgentResult[]): Promise<AgentResult[]> {
  const results: AgentResult[] = [...priorResults];
  for (let i = 0; i < tasks.length; i++) {
    const result = await executeAgent(tasks[i], results);
    results.push(result);
    if (i < tasks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return results.slice(priorResults.length);
}

async function executeSequential(tasks: SubTask[], priorResults: AgentResult[]): Promise<AgentResult[]> {
  const results: AgentResult[] = [...priorResults];
  for (const task of tasks) {
    const result = await executeAgent(task, results);
    results.push(result);
  }
  return results.slice(priorResults.length);
}

// ── Planning ───────────────────────────────────────────────────────────────────

async function planTask(instruction: string): Promise<SubTask[]> {
  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    messages:   [{
      role:    'user',
      content: `Break this task into parallel sub-tasks. Return ONLY a raw JSON array — no markdown, no explanation.

Task: ${instruction}

Each item: {
  "id": "t1",
  "type": "browser"|"research"|"file"|"write"|"code",
  "instruction": "specific instruction for this sub-agent",
  "tools": ["tool names this agent can use"],
  "dependsOn": ["t1"] // optional, array of task IDs that must complete first
}

Rules:
- Max 8 tasks. Most tasks need only 2-4.
- Only add dependsOn when a task truly needs prior output.
- type "write" for drafting content (no tools needed).
- type "research" for web research (browser tools).
- type "browser" for direct browser interaction.
- type "file" or "code" for file/system operations.
- Return [] if this is a simple task that doesn't need sub-agents.`,
    }],
  });

  const text  = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as SubTask[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    console.warn('[SubAgent] failed to parse plan JSON');
    return [];
  }
}

// ── Synthesis ──────────────────────────────────────────────────────────────────

async function synthesiseResults(instruction: string, results: AgentResult[]): Promise<string> {
  const summary = results
    .map(r => `[${r.taskId}${r.success ? '' : ' FAILED'}] ${r.output || r.error}`)
    .join('\n\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1000,
    messages:   [{
      role:    'user',
      content: `Original task: ${instruction}\n\nAgent outputs:\n${summary}\n\nSynthesize into a concise, direct response. Plain text only — no markdown.`,
    }],
  });

  return response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
    ?? results.map(r => r.output).filter(Boolean).join('\n\n');
}

// ── Silent background task ────────────────────────────────────────────────────

export function runSilentTask(config: {
  task:       string;
  context:    string;
  model:      'groq' | 'haiku' | 'sonnet';
  onComplete: (result: string) => void;
}): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tierService = require('./tierService');
  if (!tierService.isFeatureEnabled('subAgentsEnabled')) {
    config.onComplete('Sub-agents require Pro. Upgrade at aretica.ai.');
    return;
  }

  const model = config.model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  void (async () => {
    try {
      console.log(`[SubAgent] silent task starting: ${config.task.slice(0, 80)}`);
      const resp = await client.messages.create({
        model,
        max_tokens: 500,
        messages: [{
          role:    'user',
          content: `Context: ${config.context}\nTask: ${config.task}\nComplete this task efficiently. Return only the result, no preamble.`,
        }],
      });
      const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      config.onComplete(text);
      console.log('[SubAgent] silent task complete');
    } catch (err) {
      console.error('[SubAgent] silent task failed:', err);
    }
  })();
}

// ── Public orchestration entry point ──────────────────────────────────────────

export async function orchestrate(instruction: string): Promise<string> {
  if (!(await checkFeatureAccess('subAgents'))) {
    return 'Sub-agents are not available on your current plan. Upgrade to Pro or Enterprise to use this feature.';
  }
  console.log('[SubAgent] orchestrating:', instruction.slice(0, 80));

  let tasks: SubTask[];
  try {
    tasks = await planTask(instruction);
  } catch (e) {
    console.warn('[SubAgent] planning failed:', e);
    return `Could not plan task: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (tasks.length === 0) {
    console.log('[SubAgent] plan returned empty — task too simple for sub-agents');
    return instruction; // caller should handle this as a regular task
  }

  console.log(`[SubAgent] plan: ${tasks.length} tasks`, tasks.map(t => `${t.id}:${t.type}`).join(', '));

  const estimatedCalls = tasks.length * 2;
  const runSequential  = estimatedCalls > 8;
  console.log(`[Agents] estimated ${estimatedCalls} calls — running ${runSequential ? 'sequential' : 'parallel'}`);

  let allResults: AgentResult[];

  if (runSequential) {
    allResults = await executeSequentialWithDelay(tasks, []);
  } else {
    // Split into independent tasks and those with dependencies
    const independent = tasks.filter(t => !t.dependsOn || t.dependsOn.length === 0);
    const dependent   = tasks.filter(t =>  t.dependsOn && t.dependsOn.length > 0);

    allResults = [];

    if (independent.length > 0) {
      const results = await executeParallel(independent, []);
      allResults = [...results];
    }

    if (dependent.length > 0) {
      const results = await executeSequential(dependent, allResults);
      allResults = [...allResults, ...results];
    }
  }

  return synthesiseResults(instruction, allResults);
}

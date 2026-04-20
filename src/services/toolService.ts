import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { generateSoul, getLearnedFacts, setLearnedFacts } from './memoryService';
import { addTask, getPendingTasks, markDone } from './taskStore';
import { addGoal, getActiveGoals, updateGoal, getLifeGoals, logGoalActivity, type Goal } from './goalService';
import { getWeeklyPlan } from './planningService';
import { activateSoftLock, deactivateSoftLock, getSoftLockState } from './softLockService';
import { addCommitment, getOpenCommitments, markDone as commitmentDone } from './commitmentTracker';
import { getTodayEvents, formatEventTime } from './calendarService';
import {
  isGmailConnected, connectGmail, readEmails,
  createDraft, sendDraft, type DraftResult,
} from './gmailService';
import { runOnboarding }   from './onboardingService';
import { runWeeklyReview } from './weeklyReview';
import {
  browserOpen, browserClick, browserType, browserExtract,
  browserScreenshot, browserSearch, browserScroll, browserWait, browserClose,
} from './browserAgent';
import {
  appFocus, appClick, appType, appRead, appMenu, appShortcut,
  appSpotifyPlay, appVscodeOpen, appVscodeCommand,
} from './appControl';
import { orchestrate } from './subAgentOrchestrator';
import { updateWakeWord } from './voiceListener';
import { analyseOnDemand } from './screenAwareness';
import { syncToObsidian } from './obsidianSync';

// Pending draft waiting for verbal confirmation before send
let pendingDraft: DraftResult | null = null;

const isMac = process.platform === 'darwin';

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
    description: 'Open a folder in Finder (macOS) or File Explorer (Windows). ' +
                 'Use when Isaac asks to open a folder, directory, or location on his PC. ' +
                 `Common paths: Desktop, Documents, Downloads are under ${os.homedir()}.`,
    input_schema: {
      type:       'object',
      properties: { path: { type: 'string', description: `Folder path, e.g. ${os.homedir()}/Desktop` } },
      required:   ['path'],
    },
  },
  {
    name:        'open_app',
    description: 'Launch an application. ' +
                 'Use when Isaac asks to open, launch, or start a program. ' +
                 'Examples: "chrome", "spotify", "terminal", "calculator", "discord", "steam", "code" (VS Code).',
    input_schema: {
      type:       'object',
      properties: {
        name: { type: 'string', description: 'App executable name or registered app name, e.g. "chrome", "notepad"' },
      },
      required:   ['name'],
    },
  },
  // ── Goal management ──────────────────────────────────────────────────────────
  {
    name:        'goal_add',
    description: 'Save a goal Isaac expresses. Use when he states something he wants to achieve, ' +
                 'build, or become — whether short-term or life-level. Assign an impact score ' +
                 'based on how central it is to his mission (financial freedom, House Stallan, legacy).',
    input_schema: {
      type:       'object',
      properties: {
        text:         { type: 'string',  description: 'The goal, written clearly. E.g. "Get GrantForge to $5k MRR"' },
        category:     { type: 'string',  description: '"financial" | "business" | "personal" | "health" | "other"' },
        impact_score: { type: 'number',  description: '1–10. 10 = core to his life mission. 5 = important but not critical.' },
        time_horizon: { type: 'string',  description: '"this week" | "this month" | "this year" | "life"' },
        notes:        { type: 'string',  description: 'Any context or constraints he mentioned (optional)' },
      },
      required: ['text'],
    },
  },
  {
    name:        'goal_list',
    description: 'Read all active goals, ranked by impact. Use when Isaac asks about his goals, ' +
                 'priorities, or what he should be working on.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'goal_update_progress',
    description: 'Update a goal\'s actual completion progress (0–100%). ' +
                 'Use when Isaac says he finished something, is halfway through, or gives a percentage. ' +
                 'E.g. "I finished the landing page" → progress 100, "I\'m about halfway done" → 50.',
    input_schema: {
      type:       'object',
      properties: {
        goal_number: { type: 'number', description: '1-based position from goal_list' },
        progress:    { type: 'number', description: 'Completion percentage 0–100' },
        reason:      { type: 'string', description: 'Brief reason for the update, e.g. "Isaac said he finished the landing page"' },
      },
      required: ['goal_number', 'progress'],
    },
  },
  {
    name:        'goal_update',
    description: 'Update a goal\'s status or impact score. Use when Isaac says a goal is done, ' +
                 'deprioritised, or wants to reprioritise.',
    input_schema: {
      type:       'object',
      properties: {
        goal_number:  { type: 'number', description: '1-based position from goal_list' },
        status:       { type: 'string', description: '"achieved" | "paused" | "active"' },
        impact_score: { type: 'number', description: 'New impact score 1–10 (optional)' },
      },
      required: ['goal_number'],
    },
  },

  // ── Commitment tracking ───────────────────────────────────────────────────────
  {
    name:        'commitment_log',
    description: 'Log something Isaac committed to doing — anything he said he will, plans to, or needs to do. ' +
                 'Use proactively when you hear "I\'ll do X", "I\'m going to X", "I need to get X done".',
    input_schema: {
      type:       'object',
      properties: {
        text:     { type: 'string', description: 'What he committed to. E.g. "send GrantForge cold outreach emails"' },
        due_date: { type: 'string', description: '"today" | "tomorrow" | "YYYY-MM-DD" — if he mentioned a deadline' },
      },
      required: ['text'],
    },
  },
  {
    name:        'commitment_done',
    description: 'Mark a commitment as completed. Use when Isaac says he finished or did something he previously committed to.',
    input_schema: {
      type:       'object',
      properties: {
        commitment_number: { type: 'number', description: '1-based position from the open commitments list' },
      },
      required: ['commitment_number'],
    },
  },

  // ── Autonomous actions ────────────────────────────────────────────────────────
  {
    name:        'schedule_block',
    description: 'Create a calendar event on Isaac\'s Mac. Use when he asks to block time, schedule something, ' +
                 'or when Axon proactively suggests blocking time for a priority.',
    input_schema: {
      type:       'object',
      properties: {
        title:         { type: 'string', description: 'Event title' },
        iso_datetime:  { type: 'string', description: 'Start time in format "YYYY-MM-DDTHH:MM", e.g. "2026-04-05T09:00"' },
        duration_mins: { type: 'number', description: 'Duration in minutes' },
        calendar_name: { type: 'string', description: 'Calendar name to add to (default: "Calendar")' },
      },
      required: ['title', 'iso_datetime', 'duration_mins'],
    },
  },
  {
    name:        'draft_email',
    description: 'Open Mail.app on Isaac\'s Mac with a pre-filled email draft ready to review and send. ' +
                 'Use when he asks to draft or send an email, or when Axon proactively drafts an outreach.',
    input_schema: {
      type:       'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address (optional — leave blank if unknown)' },
        subject: { type: 'string', description: 'Email subject line' },
        body:    { type: 'string', description: 'Email body text' },
      },
      required: ['subject', 'body'],
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────────
  {
    name:        'task_add',
    description: 'Save a task or to-do item to Isaac\'s list. ' +
                 'Use when Isaac says "add to my list", "remind me to", "remember to", ' +
                 'or any similar phrase indicating he wants something saved for later.',
    input_schema: {
      type:       'object',
      properties: {
        text: { type: 'string', description: 'The task text, written naturally. E.g. "Finish the proactivity layer"' },
      },
      required:   ['text'],
    },
  },
  {
    name:        'task_list',
    description: 'Read all pending (incomplete) tasks from Isaac\'s list. ' +
                 'Use when Isaac asks what\'s on his list, what he needs to do, or what he told you to remember.',
    input_schema: {
      type:       'object',
      properties: {},
      required:   [],
    },
  },
  {
    name:        'task_done',
    description: 'Mark a task as done and remove it from the active list. ' +
                 'Use when Isaac says he\'s finished something, crossed it off, or completed a task.',
    input_schema: {
      type:       'object',
      properties: {
        task_number: {
          type:        'number',
          description: 'The 1-based position of the task in the pending list (from task_list)',
        },
      },
      required:   ['task_number'],
    },
  },
  // ── Calendar ──────────────────────────────────────────────────────────────────
  {
    name:        'calendar_read',
    description: "Read Isaac's calendar. Use when he asks what's on today, upcoming meetings, " +
                 'or when you need to check his schedule before making a recommendation.',
    input_schema: {
      type:       'object',
      properties: {
        days_ahead: {
          type:        'number',
          description: 'How many days to look ahead (default 1 = today only, max 7)',
        },
      },
      required: [],
    },
  },

  // ── Gmail ─────────────────────────────────────────────────────────────────────
  {
    name:        'gmail_connect',
    description: 'Connect Axon to Gmail via OAuth. Use when Isaac asks to connect his email, ' +
                 'or when an email action fails because Gmail is not authenticated.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'email_read',
    description: "Read recent emails from Isaac's Gmail inbox. Use when he asks what emails " +
                 "he has, who's messaged him, or to find a specific email.",
    input_schema: {
      type:       'object',
      properties: {
        count: {
          type:        'number',
          description: 'Number of emails to fetch (default 5, max 10)',
        },
        search: {
          type:        'string',
          description: 'Gmail search query, e.g. "from:boss@work.com" or "subject:invoice" (optional)',
        },
      },
      required: [],
    },
  },
  {
    name:        'email_draft',
    description: 'Draft an email to send. Saves it to Gmail Drafts and returns a preview for Isaac to approve. ' +
                 'After calling this, read the draft aloud and ask "Should I send it?" before calling email_send.',
    input_schema: {
      type:       'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body:    { type: 'string', description: 'Email body — plain text, natural and direct' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name:        'email_send',
    description: 'Send the email that was just drafted. Only call this after Isaac has verbally confirmed ' +
                 'he wants to send it ("yes", "send it", "go ahead", etc.).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Weekly review ─────────────────────────────────────────────────────────────
  {
    name:        'weekly_review',
    description:
      'Generate and speak Isaac\'s weekly performance review. ' +
      'Use when he says "give me my weekly review", "how was my week", ' +
      '"weekly summary", or similar. Also runs automatically every Sunday at 6pm.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Onboarding ────────────────────────────────────────────────────────────────
  {
    name:        'start_onboarding',
    description:
      'Run the spoken setup interview to build Isaac\'s behavioural profile. ' +
      'Use when Isaac says "let\'s do setup", "run onboarding", "set up Axon", ' +
      'or any similar phrase indicating he wants to configure his profile.',
    input_schema: { type: 'object', properties: {}, required: [] },
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

  // ── Browser agent (Playwright controlled browser) ────────────────────────────
  {
    name:        'browser_open',
    description: 'Open a URL in a controlled headless browser that Axon can interact with programmatically. ' +
                 'Use this instead of open_url when you need to interact with the page (click, type, read).',
    input_schema: {
      type:       'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to navigate to' },
        headless: { type: 'boolean', description: 'false to show the browser window to Isaac (default true)' },
      },
      required: ['url'],
    },
  },
  {
    name:        'browser_search',
    description: 'Search the web using a controlled browser and return the results as text. ' +
                 'Use for research tasks where you need to read and extract content from results.',
    input_schema: {
      type:       'object',
      properties: {
        query:  { type: 'string', description: 'Search query' },
        engine: { type: 'string', description: '"google" | "youtube" | "reddit" (default: google)' },
      },
      required: ['query'],
    },
  },
  {
    name:        'browser_click',
    description: 'Click an element on the currently open browser page by CSS selector or visible text.',
    input_schema: {
      type:       'object',
      properties: { selector: { type: 'string', description: 'CSS selector or visible text of element' } },
      required:   ['selector'],
    },
  },
  {
    name:        'browser_extract',
    description: 'Extract text content from the current browser page. Use "body" for full page text.',
    input_schema: {
      type:       'object',
      properties: { selector: { type: 'string', description: 'CSS selector, or "body" for full page' } },
      required:   ['selector'],
    },
  },
  {
    name:        'browser_screenshot',
    description: 'Take a screenshot of the current browser page. Returns base64 image data.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── App control (macOS Accessibility API) ────────────────────────────────────
  {
    name:        'app_control',
    description: 'Control any macOS application using the Accessibility API. ' +
                 'Can click buttons, type text, read content, navigate menus, and send keyboard shortcuts. ' +
                 'Use when Isaac asks you to do something in a specific app.',
    input_schema: {
      type:       'object',
      properties: {
        app:       { type: 'string', description: 'Application name, e.g. "Safari", "Terminal", "Finder"' },
        action:    { type: 'string', description: '"click" | "type" | "read" | "menu" | "shortcut" | "focus"' },
        element:   { type: 'string', description: 'UI element name/description (for click and read)' },
        text:      { type: 'string', description: 'Text to type (for type action)' },
        menu_path: { type: 'string', description: 'Comma-separated menu path, e.g. "File,New File" (for menu action)' },
        keys:      { type: 'string', description: 'Shortcut keys, e.g. "cmd+shift+p" (for shortcut action)' },
      },
      required: ['app', 'action'],
    },
  },
  {
    name:        'app_spotify',
    description: 'Control Spotify. Without a query: toggles play/pause. With a query: searches and plays music.',
    input_schema: {
      type:       'object',
      properties: { query: { type: 'string', description: 'Song, artist, or playlist to search for (omit to toggle play/pause)' } },
      required:   [],
    },
  },
  {
    name:        'app_vscode',
    description: 'Control VS Code. Open a file or run a command palette command.',
    input_schema: {
      type:       'object',
      properties: {
        action:   { type: 'string', description: '"open_file" | "command"' },
        file:     { type: 'string', description: 'Absolute file path to open (for open_file action)' },
        command:  { type: 'string', description: 'Command palette command to run, e.g. "Git: Commit" (for command action)' },
      },
      required: ['action'],
    },
  },

  // ── System configuration ─────────────────────────────────────────────────────
  {
    name:        'set_wake_word',
    description: 'Set a custom wake word for Axon. After calling this, Axon will respond to the new word immediately (no restart needed). ' +
                 'Use when Isaac says "change your wake word to X" or "respond to X instead".',
    input_schema: {
      type:       'object',
      properties: {
        word: { type: 'string', description: 'The new wake word or phrase, e.g. "hey jarvis"' },
      },
      required: ['word'],
    },
  },

  // ── Screen awareness ──────────────────────────────────────────────────────────
  {
    name:        'analyse_screen',
    description: "Take a screenshot and analyse what is currently on Isaac's screen. " +
                 'Use when Isaac asks about something he\'s looking at, when screen context would help ' +
                 'answer a question, or when you want to understand what he\'s currently doing.',
    input_schema: {
      type:       'object',
      properties: {},
      required:   [],
    },
  },

  // ── Life goal activity ────────────────────────────────────────────────────────
  {
    name:        'goal_log_activity',
    description: 'Log a completed life goal activity — gym session, run, sleep, social event, learning. ' +
                 'Use when Isaac mentions going to the gym, finishing a run, completing a workout, ' +
                 'going to bed on time, finishing a book chapter, or any health/life goal activity.',
    input_schema: {
      type:       'object',
      properties: {
        goal_number:       { type: 'number', description: '1-based position from goal_list (pick the most relevant life goal)' },
        duration_minutes:  { type: 'number', description: 'Duration of the activity in minutes (optional)' },
      },
      required: ['goal_number'],
    },
  },

  // ── Weekly life plan ──────────────────────────────────────────────────────────
  {
    name:        'get_weekly_plan',
    description: 'Read the current weekly life plan — gym times, deep work windows, wind-down schedule, soft lock times. ' +
                 'Use when Isaac asks about his schedule, when to train, or when Axon needs to reference today\'s plan.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Soft lock ─────────────────────────────────────────────────────────────────
  {
    name:        'activate_soft_lock',
    description: 'Lock Isaac out of his computer — hides all windows and shows the soft lock screen. ' +
                 'Use when Isaac says "lock me out", "I\'m going to train", "time to go", or when ' +
                 'the weekly plan says it\'s gym/sleep time. Always confirm the reason and duration first.',
    input_schema: {
      type:       'object',
      properties: {
        reason:           { type: 'string', description: 'Reason for the lock, e.g. "Gym time", "Wind down", "Sleep"' },
        duration_minutes: { type: 'number', description: 'How long to lock in minutes' },
      },
      required: ['reason', 'duration_minutes'],
    },
  },
  {
    name:        'deactivate_soft_lock',
    description: 'Unlock the computer and restore all windows. Use when Isaac has returned from his commitment.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'get_soft_lock_state',
    description: 'Check whether a soft lock is currently active, how long remains, and what it was for.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Memory management ─────────────────────────────────────────────────────────
  {
    name:        'memory_review',
    description: 'Review all stored facts about Isaac, remove noise (song lyrics, hallucinations, contradictions), and speak a summary of what was cleaned. ' +
                 'Use when Isaac says "review your facts", "clean up your memory", "audit what you know", or similar.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'memory_delete',
    description: 'Delete any facts from memory that match a search query. ' +
                 'Use when Isaac says "forget that you think X", "delete facts about Y", or "remove anything about Z".',
    input_schema: {
      type:       'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase to match against facts. All matching facts are deleted.' },
      },
      required: ['query'],
    },
  },

  // ── Obsidian sync ─────────────────────────────────────────────────────────────
  {
    name:        'sync_obsidian',
    description: 'Sync all of Axon\'s memory, goals, weekly plan, intervention log, and behaviour patterns to the Obsidian vault. ' +
                 'Use when Isaac says "sync to Obsidian", "update Obsidian", or "sync my notes".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Sub-agent orchestration ───────────────────────────────────────────────────
  {
    name:        'spawn_agents',
    description: 'Break a large, multi-step task into parallel sub-agents and synthesise their results. ' +
                 'Use when a task requires: multiple sources of information, parallel research workstreams, ' +
                 'multi-step browser workflows, or any task too large for a single response. ' +
                 'Each sub-agent has access to browser and file tools. Returns a synthesised result.',
    input_schema: {
      type:       'object',
      properties: {
        task: { type: 'string', description: 'Full description of the task to orchestrate' },
      },
      required: ['task'],
    },
  },

  // ── Autonomous coding ─────────────────────────────────────────────────────────
  {
    name:        'run_coding_task',
    description: 'Write and execute code autonomously to complete a task. Use when Isaac asks to build ' +
                 'something, automate something, process data, or run a script. Axon will write the code, ' +
                 'run it, fix any errors, and repeat until it works.',
    input_schema: {
      type:       'object',
      properties: {
        description: { type: 'string', description: 'What the code should do' },
        language:    { type: 'string', enum: ['python', 'typescript', 'javascript', 'bash', 'auto'], description: 'Language to use (default: auto)' },
        output_file: { type: 'string', description: 'Optional path to save the final working code' },
        context:     { type: 'string', description: 'Any additional context, existing code, or file contents' },
      },
      required: ['description'],
    },
  },
];

// ── Execution ─────────────────────────────────────────────────────────────────

export async function executeTool(
  name:  string,
  input: Record<string, string>,
): Promise<string> {
  console.log(`[Tool] executing: ${name}`, input);

  try {
    switch (name) {

      case 'open_url': {
        const safe = input.url.replace(/'/g, '%27');
        if (isMac) {
          await execAsync(`open '${safe}'`, { timeout: 10_000 });
        } else {
          await execAsync(`powershell -NoProfile -Command "Start-Process '${safe}'"`, { timeout: 10_000 });
        }
        return `Opened ${input.url}`;
      }

      case 'web_search': {
        const query = encodeURIComponent(input.query);
        const url   = `https://www.google.com/search?q=${query}`;
        if (isMac) {
          await execAsync(`open '${url}'`, { timeout: 10_000 });
        } else {
          await execAsync(`powershell -NoProfile -Command "Start-Process '${url}'"`, { timeout: 10_000 });
        }
        return `Searched for "${input.query}"`;
      }

      case 'open_folder': {
        const safe = input.path.replace(/'/g, "\\'");
        if (isMac) {
          await execAsync(`open '${safe}'`, { timeout: 10_000 });
        } else {
          await execAsync(`powershell -NoProfile -Command "Invoke-Item '${input.path.replace(/'/g, "''")}'"`, { timeout: 10_000 });
        }
        return `Opened folder: ${input.path}`;
      }

      case 'open_app': {
        if (isMac) {
          const safe = input.name.replace(/'/g, "\\'");
          await execAsync(`open -a '${safe}'`, { timeout: 10_000 });
        } else {
          const safe = input.name.replace(/'/g, "''");
          await execAsync(`powershell -NoProfile -Command "Start-Process '${safe}'"`, { timeout: 10_000 });
        }
        return `Launched ${input.name}`;
      }

      case 'goal_add': {
        const goal = addGoal(
          input.text,
          (input.category as Goal['category']) || 'other',
          input.impact_score ? Number(input.impact_score) : 5,
          (input.time_horizon as Goal['timeHorizon']) || 'this year',
          input.notes ?? '',
        );
        return `Goal saved (impact ${goal.impactScore}/10): "${goal.text}"`;
      }

      case 'goal_list': {
        const goals = getActiveGoals();
        if (goals.length === 0) return 'No goals set yet.';
        return goals.map((g, i) =>
          `${i + 1}. [${g.impactScore}/10 · ${g.timeHorizon}] ${g.text}`
        ).join('\n');
      }

      case 'goal_update_progress': {
        const goals    = getActiveGoals();
        const idx      = Math.round(Number(input.goal_number)) - 1;
        if (idx < 0 || idx >= goals.length) return `No goal at position ${input.goal_number}.`;
        const progress = Math.max(0, Math.min(100, Math.round(Number(input.progress))));
        updateGoal(goals[idx].id, { progress });
        return `Goal progress updated to ${progress}%: "${goals[idx].text}"${input.reason ? ` (${input.reason})` : ''}`;
      }

      case 'goal_update': {
        const goals = getActiveGoals();
        const idx   = Math.round(Number(input.goal_number)) - 1;
        if (idx < 0 || idx >= goals.length) return `No goal at position ${input.goal_number}.`;
        const updates: Parameters<typeof updateGoal>[1] = {};
        if (input.status)       updates.status       = input.status as Goal['status'];
        if (input.impact_score) updates.impactScore   = Number(input.impact_score);
        updateGoal(goals[idx].id, updates);
        return `Updated goal: "${goals[idx].text}"`;
      }

      case 'commitment_log': {
        const c = addCommitment(input.text, input.due_date ?? null);
        return `Commitment logged: "${c.text}"`;
      }

      case 'commitment_done': {
        const open = getOpenCommitments();
        const idx  = Math.round(Number(input.commitment_number)) - 1;
        if (idx < 0 || idx >= open.length) return `No open commitment at position ${input.commitment_number}.`;
        commitmentDone(open[idx].id);
        return `Marked done: "${open[idx].text}"`;
      }

      case 'schedule_block': {
        if (process.platform !== 'darwin') return 'Calendar scheduling is macOS only.';
        const dt    = new Date(input.iso_datetime);
        const endDt = new Date(dt.getTime() + Number(input.duration_mins) * 60_000);
        const title = input.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        if (isNaN(dt.getTime())) {
          return `Invalid date: "${input.iso_datetime}". Use ISO format like "2026-04-07T09:00".`;
        }

        // If a calendar name was specified, target it; otherwise use the first writable calendar.
        // This avoids silent failure when "Calendar" doesn't match any real calendar name.
        const calSpec = input.calendar_name
          ? `first calendar whose name is "${input.calendar_name.replace(/"/g, '\\"')}"`
          : 'first calendar whose writable is true';

        // Build dates by setting individual numeric properties — locale-independent.
        const sy = dt.getFullYear(),    sm = dt.getMonth() + 1,    sd = dt.getDate();
        const st = dt.getHours() * 3600 + dt.getMinutes() * 60;
        const ey = endDt.getFullYear(), em = endDt.getMonth() + 1, ed = endDt.getDate();
        const et = endDt.getHours() * 3600 + endDt.getMinutes() * 60;

        const script = [
          'tell application "Calendar"',
          '  set startDate to current date',
          `  set year of startDate to ${sy}`,
          `  set month of startDate to ${sm}`,
          `  set day of startDate to ${sd}`,
          `  set time of startDate to ${st}`,
          '  set endDate to current date',
          `  set year of endDate to ${ey}`,
          `  set month of endDate to ${em}`,
          `  set day of endDate to ${ed}`,
          `  set time of endDate to ${et}`,
          `  set targetCal to ${calSpec}`,
          '  tell targetCal',
          `    make new event with properties {summary:"${title}", start date:startDate, end date:endDate}`,
          '  end tell',
          '  activate',
          '  return name of targetCal',
          'end tell',
        ].join('\n');

        const { stdout } = await execAsync(
          `osascript -e '${script.replace(/'/g, "'\\''")}'`,
          { timeout: 15_000 },
        );

        const usedCal = stdout.trim() || 'unknown calendar';
        const label   = dt.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
        const time    = dt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
        return `Scheduled "${input.title}" on ${label} at ${time} for ${input.duration_mins} mins in calendar "${usedCal}".`;
      }

      case 'draft_email': {
        if (process.platform !== 'darwin') return 'Email drafting is macOS only.';
        const to      = input.to ?? '';
        const subject = input.subject.replace(/"/g, '\\"').replace(/\n/g, ' ');
        const body    = input.body.replace(/"/g, '\\"').replace(/\n/g, '\\n');

        const toLine = to
          ? `make new to recipient at end of to recipients with properties {address:"${to}"}`
          : '';

        const script = [
          'tell application "Mail"',
          `  set newMsg to make new outgoing message with properties {subject:"${subject}", content:"${body}", visible:true}`,
          '  tell newMsg',
          toLine,
          '  end tell',
          '  activate',
          'end tell',
        ].filter(Boolean).join('\n');

        await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15_000 });
        return `Email draft opened in Mail: "${input.subject}"${to ? ` to ${to}` : ''}.`;
      }

      case 'task_add': {
        const task = addTask(input.text);
        return `Task saved: "${task.text}"`;
      }

      case 'task_list': {
        const pending = getPendingTasks();
        if (pending.length === 0) return 'No pending tasks.';
        return pending.map((t, i) => `${i + 1}. ${t.text}`).join('\n');
      }

      case 'task_done': {
        const pending = getPendingTasks();
        const idx     = Math.round(Number(input.task_number)) - 1;
        if (idx < 0 || idx >= pending.length) return `No task at position ${input.task_number}.`;
        markDone(pending[idx].id);
        return `Marked done: "${pending[idx].text}"`;
      }

      case 'calendar_read': {
        const daysAhead = Math.min(7, Math.max(1, Number(input.days_ahead) || 1));
        const events    = await getTodayEvents(daysAhead);

        if (events.length === 0) {
          return daysAhead === 1 ? 'No events today.' : `No events in the next ${daysAhead} days.`;
        }

        const todayStr    = new Date().toISOString().slice(0, 10);
        const tomorrowStr = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const now         = Date.now();

        const lines = events.map(e => {
          const time   = formatEventTime(e);
          const status = e.startMs < now ? ' (passed)' : e.startMs - now < 30 * 60_000 ? ' (soon)' : '';
          const dayLabel = e.date === todayStr    ? 'Today'
                         : e.date === tomorrowStr ? 'Tomorrow'
                         : new Date(e.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
          return `${dayLabel} ${time} — ${e.title}${status}`;
        });

        return lines.join('\n');
      }

      case 'gmail_connect': {
        const result = await connectGmail();
        return result;
      }

      case 'email_read': {
        if (!isGmailConnected()) {
          return 'Gmail is not connected. Ask me to connect Gmail first.';
        }

        const count  = Math.min(10, Math.max(1, Number(input.count) || 5));
        const query  = input.search ? `in:inbox ${input.search}` : 'in:inbox';
        const emails = await readEmails(count, query);

        if (emails.length === 0) return 'No emails found.';

        return emails.map((e, i) =>
          `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Preview: ${e.snippet.slice(0, 120)}`
        ).join('\n\n');
      }

      case 'email_draft': {
        if (!isGmailConnected()) {
          return 'Gmail is not connected. Ask Isaac to connect Gmail first.';
        }

        const draft = await createDraft(input.to, input.subject, input.body);
        pendingDraft = draft;

        return (
          `Draft saved to Gmail Drafts.\n` +
          `To: ${draft.to}\n` +
          `Subject: ${draft.subject}\n` +
          `Body: ${draft.body}\n\n` +
          `Read the above to Isaac and ask if he wants to send it.`
        );
      }

      case 'email_send': {
        if (!pendingDraft) {
          return 'No email draft is pending. Draft an email first with email_draft.';
        }

        if (!isGmailConnected()) {
          return 'Gmail is not connected.';
        }

        const { draftId, to, subject } = pendingDraft;
        pendingDraft = null;

        await sendDraft(draftId);
        return `Email sent to ${to} — subject: "${subject}".`;
      }

      case 'weekly_review': {
        const review = await runWeeklyReview();
        void syncToObsidian();
        return review;
      }

      case 'start_onboarding': {
        const result = await runOnboarding();
        return result;
      }

      case 'write_soul': {
        console.log('[Tool] generating soul from full memory corpus...');
        const result = await generateSoul();
        return result;
      }

      case 'run_command': {
        console.log(`[Tool] run_command: ${input.description} → ${input.command}`);
        const cmd = isMac
          ? `bash -c ${JSON.stringify(input.command)}`
          : `powershell -NoProfile -ExecutionPolicy Bypass -Command "${input.command.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
        const out = (stdout + stderr).trim();
        return out.length > 0 ? out.slice(0, 500) : 'Command completed with no output.';
      }

      // ── Browser agent ──────────────────────────────────────────────────────────

      case 'browser_open': {
        const headless = input.headless !== 'false' && input.headless !== false as unknown as string;
        return await browserOpen(input.url, headless);
      }

      case 'browser_search': {
        return await browserSearch(
          input.query,
          (input.engine as 'google' | 'youtube' | 'reddit') || 'google',
        );
      }

      case 'browser_click':      return await browserClick(input.selector);
      case 'browser_extract':    return await browserExtract(input.selector || 'body');
      case 'browser_screenshot': return await browserScreenshot();

      // ── App control ────────────────────────────────────────────────────────────

      case 'app_control': {
        if (!isMac) return 'app_control is macOS only.';
        const { app, action, element, text, menu_path, keys } = input;
        switch (action) {
          case 'focus':    return await appFocus(app);
          case 'click':    return await appClick(app, element ?? '');
          case 'type':     return await appType(app, text ?? '');
          case 'read':     return await appRead(app, element ?? '');
          case 'shortcut': return await appShortcut(app, keys ?? '');
          case 'menu': {
            const path = (menu_path ?? '').split(',').map(s => s.trim()).filter(Boolean);
            return await appMenu(app, path);
          }
          default: return `Unknown app_control action: ${action}`;
        }
      }

      case 'app_spotify': return await appSpotifyPlay(input.query || undefined);

      case 'app_vscode': {
        if (!isMac) return 'app_vscode is macOS only.';
        if (input.action === 'open_file') return await appVscodeOpen(input.file ?? '');
        if (input.action === 'command')   return await appVscodeCommand(input.command ?? '');
        return `Unknown app_vscode action: ${input.action}`;
      }

      case 'set_wake_word': {
        const word = (input.word ?? '').trim();
        if (!word) return 'No wake word provided.';
        // Update in-memory immediately
        updateWakeWord(word);
        // Persist to .env file
        const envPath = path.resolve(process.cwd(), '.env');
        try {
          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          if (envContent.includes('AXON_WAKE_WORD=')) {
            envContent = envContent.replace(/^AXON_WAKE_WORD=.*$/m, `AXON_WAKE_WORD=${word}`);
          } else {
            envContent += `\nAXON_WAKE_WORD=${word}\n`;
          }
          fs.writeFileSync(envPath, envContent, 'utf8');
        } catch (e) {
          console.warn('[Tool] set_wake_word: could not write .env:', e);
        }
        return `Done — I'll respond to "${word}" from now on.`;
      }

      // ── Screen awareness ───────────────────────────────────────────────────────

      case 'analyse_screen': {
        const ctx = await analyseOnDemand();
        if (!ctx.activeApp) return 'Screen capture unavailable — check screen recording permission in System Settings.';
        return (
          `Screen: ${ctx.activeApp} — ${ctx.activity}. ` +
          `Visible: ${ctx.visibleContent}. ` +
          `Signal: ${ctx.productivitySignal}.` +
          (ctx.notes ? ` Notes: ${ctx.notes}` : '')
        );
      }

      // ── Memory management ──────────────────────────────────────────────────────

      case 'memory_review': {
        const allFacts = getLearnedFacts();
        if (allFacts.length === 0) return 'No facts in memory to review.';

        const reviewClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
        const resp = await reviewClient.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role:    'user',
            content:
              `Review these ${allFacts.length} facts about Isaac stored in Axon's memory.\n\n` +
              `Flag any that:\n` +
              `(a) Sound like song lyrics, dialogue, poetry, or media content\n` +
              `(b) Are clearly hallucinated or inferred rather than explicitly stated\n` +
              `(c) Directly contradict another fact in the list\n` +
              `(d) Are nonsensical or obviously wrong\n\n` +
              `Return ONLY a JSON object: { "keepFacts": string[], "removeFacts": string[] }\n` +
              `Include every fact in exactly one array. Err on the side of keeping if uncertain.\n\n` +
              `Facts:\n${allFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
          }],
        });

        const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
        if (!block) return 'Memory review failed — no response from Claude.';

        const raw   = block.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return 'Memory review failed — could not parse response.';

        const result = JSON.parse(match[0]) as { keepFacts?: unknown[]; removeFacts?: unknown[] };
        const keep   = (result.keepFacts  ?? []).filter((f): f is string => typeof f === 'string');
        const remove = (result.removeFacts ?? []).filter((f): f is string => typeof f === 'string');

        if (remove.length === 0) return 'Reviewed all facts — nothing to remove. Memory is clean.';

        setLearnedFacts(keep);
        console.log(`[Tool] memory_review — removed ${remove.length} facts, kept ${keep.length}`);
        return `Removed ${remove.length} facts that looked like noise. Your memory is cleaner now. ${keep.length} facts remain.`;
      }

      case 'memory_delete': {
        const query = (input.query ?? '').trim().toLowerCase();
        if (!query) return 'No search query provided.';

        const allFacts = getLearnedFacts();
        const matching = allFacts.filter(f => f.toLowerCase().includes(query));
        if (matching.length === 0) return `No facts found matching "${input.query}".`;

        const remaining = allFacts.filter(f => !f.toLowerCase().includes(query));
        setLearnedFacts(remaining);
        console.log(`[Tool] memory_delete — removed ${matching.length} facts matching "${query}"`);
        return `Deleted ${matching.length} fact${matching.length === 1 ? '' : 's'} containing "${input.query}". ${remaining.length} facts remain.`;
      }

      // ── Obsidian sync ──────────────────────────────────────────────────────────

      case 'sync_obsidian': {
        await syncToObsidian();
        if (!process.env.OBSIDIAN_VAULT_PATH) {
          return 'Obsidian vault path not set. Add OBSIDIAN_VAULT_PATH to your .env file.';
        }
        return 'Synced to Obsidian. Profile, Goals, Weekly Plan, Intervention Log, and Behaviour Patterns updated.';
      }

      // ── Sub-agent orchestration ────────────────────────────────────────────────

      case 'spawn_agents': {
        console.log('[Tool] spawn_agents:', input.task?.slice(0, 80));
        return await orchestrate(input.task ?? '');
      }

      // ── Autonomous coding ──────────────────────────────────────────────────────

      case 'run_coding_task': {
        console.log('[Tool] run_coding_task:', input.description?.slice(0, 80));
        const { runCodingLoop } = require('./codingAgent');
        const result = await runCodingLoop({
          description: input.description ?? '',
          language:    (input.language as 'python' | 'typescript' | 'javascript' | 'bash' | 'auto') ?? 'auto',
          outputFile:  input.output_file || undefined,
          context:     input.context || undefined,
        });
        if (result.success) {
          return `Completed in ${result.attempts} attempt(s).${result.savedTo ? ` Saved to ${result.savedTo}.` : ''}\nOutput: ${result.output.slice(0, 300)}`;
        }
        return `Failed after ${result.attempts} attempt(s): ${result.error?.slice(0, 300) ?? 'unknown error'}`;
      }

      // ── Life goal activity ─────────────────────────────────────────────────────

      case 'goal_log_activity': {
        const lifeGoals = getLifeGoals();
        const idx       = Math.round(Number(input.goal_number)) - 1;
        if (idx < 0 || idx >= lifeGoals.length) {
          // Fall back to all active goals if index is out of life-goal range
          const allGoals = getActiveGoals();
          if (idx < 0 || idx >= allGoals.length) return `No goal at position ${input.goal_number}.`;
          const dur = input.duration_minutes ? Number(input.duration_minutes) : undefined;
          logGoalActivity(allGoals[idx].id, dur);
          return `Activity logged for "${allGoals[idx].text}"${dur ? ` (${dur} min)` : ''}.`;
        }
        const dur = input.duration_minutes ? Number(input.duration_minutes) : undefined;
        logGoalActivity(lifeGoals[idx].id, dur);
        return `Activity logged for "${lifeGoals[idx].text}"${dur ? ` (${dur} min)` : ''}.`;
      }

      // ── Weekly life plan ───────────────────────────────────────────────────────

      case 'get_weekly_plan': {
        const plan = getWeeklyPlan();
        if (!plan) return 'No weekly plan generated yet. It runs automatically every Sunday at 6pm, or ask me to generate one.';
        const today = new Date().toISOString().slice(0, 10);
        const todayPlan = plan.days.find(d => d.date === today);
        const lines: string[] = [`Weekly plan (${plan.weekStarting}):`, ''];
        if (todayPlan) {
          lines.push(`Today (${today}):`);
          lines.push(`  Deep work: ${todayPlan.deepWorkWindow}`);
          if (todayPlan.gymOrRunTime) lines.push(`  Gym/run: ${todayPlan.gymOrRunTime}`);
          lines.push(`  Wind-down: ${todayPlan.laptopWindDownTime}`);
          if (todayPlan.softLockStart) lines.push(`  Soft lock: ${todayPlan.softLockStart}–${todayPlan.softLockEnd ?? '?'}`);
          if (todayPlan.notes) lines.push(`  Notes: ${todayPlan.notes}`);
          lines.push('');
        }
        lines.push('Weekly goals:');
        for (const g of plan.weeklyGoals) lines.push(`  - ${g}`);
        return lines.join('\n');
      }

      // ── Soft lock ──────────────────────────────────────────────────────────────

      case 'activate_soft_lock': {
        const reason   = (input.reason ?? 'Focus time').trim();
        const duration = Math.max(1, Math.round(Number(input.duration_minutes) || 30));
        await activateSoftLock(reason, duration);
        return `Soft lock activated: "${reason}" for ${duration} minutes.`;
      }

      case 'deactivate_soft_lock': {
        await deactivateSoftLock();
        return 'Soft lock deactivated — windows restored.';
      }

      case 'get_soft_lock_state': {
        const state = getSoftLockState();
        if (!state || !state.active) return 'No soft lock is currently active.';
        const remaining = Math.max(0, new Date(state.endTime).getTime() - Date.now());
        const remMins   = Math.ceil(remaining / 60_000);
        return (
          `Soft lock active: "${state.reason}"\n` +
          `Started: ${new Date(state.startTime).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}\n` +
          `Ends: ${new Date(state.endTime).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} ` +
          `(${remMins} min remaining)\n` +
          `Override used: ${state.overrideUsed ? 'yes' : 'no'}`
        );
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

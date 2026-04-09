import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { generateSoul } from './memoryService';
import { addTask, getPendingTasks, markDone } from './taskStore';
import { addGoal, getActiveGoals, updateGoal, type Goal } from './goalService';
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

      // ── Sub-agent orchestration ────────────────────────────────────────────────

      case 'spawn_agents': {
        console.log('[Tool] spawn_agents:', input.task?.slice(0, 80));
        return await orchestrate(input.task ?? '');
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

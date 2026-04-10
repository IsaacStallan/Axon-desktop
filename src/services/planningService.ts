import Anthropic from '@anthropic-ai/sdk';
import type { CalendarEvent } from './calendarService';
import type { Goal } from './goalService';
import type { Commitment } from './commitmentTracker';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyPlan {
  /** Spoken briefing text — delivered by TTS in the morning */
  spoken:     string;
  /** Raw priority list for logging / memory */
  priorities: string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesises goals, calendar, open commitments, and pending tasks into
 * a spoken top-3 daily priority briefing.
 */
export async function getDailyPlan(
  events:      CalendarEvent[],
  goals:       Goal[],
  commitments: Commitment[],
  pendingTasks: string,
): Promise<DailyPlan> {
  const hour       = new Date().getHours();
  const dateStr    = new Date().toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric' });

  const eventLines = events.length === 0
    ? 'No calendar events today.'
    : events.map(e => {
        const period = e.hour < 12 ? 'AM' : 'PM';
        const h      = e.hour > 12 ? e.hour - 12 : e.hour || 12;
        const m      = e.minute ? `:${String(e.minute).padStart(2, '0')}` : '';
        return `${h}${m} ${period} — ${e.title}`;
      }).join('\n');

  const goalLines = goals.length === 0
    ? 'No goals set yet.'
    : goals.map((g, i) => `${i + 1}. [impact ${g.impactScore}/10] ${g.text}`).join('\n');

  const commitmentLines = commitments.length === 0
    ? ''
    : commitments.map((c, i) => {
        const age = Math.round((Date.now() - new Date(c.madeAt).getTime()) / 86_400_000);
        const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
        return `${i + 1}. "${c.text}" (said ${when})`;
      }).join('\n');

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system:
        `You are Axon — Isaac's AI. Isaac is 20, building House Stallan — a business empire. ` +
        `He is obsessed with execution and hates wasted days.\n\n` +
        `Generate a spoken morning briefing — 3–5 sharp sentences:\n` +
        `1. Greet him briefly (${hour < 12 ? 'morning' : 'afternoon'})\n` +
        `2. Name today's top 3 priorities — derived from his goals and calendar gaps, ` +
        `not just a list of events. Make each one specific and actionable.\n` +
        `3. If he has open commitments (things he said he'd do), call out the most overdue one.\n` +
        `Rules: no markdown, no lists, natural spoken sentences. Sharp and direct.\n` +
        `IMPORTANT: Keep the briefing under 400 words maximum — it must be completable in a single TTS call.`,
      messages: [{
        role:    'user',
        content:
          `Date: ${dateStr}\n` +
          `Time: ${hour}:00\n\n` +
          `GOALS (ranked by impact):\n${goalLines}\n\n` +
          `TODAY'S CALENDAR:\n${eventLines}\n\n` +
          (commitmentLines ? `OPEN COMMITMENTS:\n${commitmentLines}\n\n` : '') +
          (pendingTasks ? `PENDING TASKS:\n${pendingTasks}\n\n` : '') +
          `Write the briefing.`,
      }],
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const spoken = block?.text.trim() ?? '';

    // Extract the three priorities as raw strings for logging
    const priorities = goals.slice(0, 3).map(g => g.text);

    return { spoken, priorities };
  } catch (e) {
    console.warn('[Planning] generation failed:', e);
    const fallback = goals.length > 0
      ? `Good morning. Today focus on: ${goals.slice(0, 3).map(g => g.text).join(', ')}.`
      : "Good morning. No goals set yet — tell me what you're working toward.";
    return { spoken: fallback, priorities: [] };
  }
}

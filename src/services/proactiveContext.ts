// Shared in-memory store for the last message Axon spoke proactively.
// Written by interventionDecider, briefingService, and weeklyReview.
// Read by conversationService so Claude always knows what it just said.

export interface ProactiveMessage {
  text:     string;
  type:     string;   // 'intervention', 'break', 'briefing', 'reminder', 'weekly_review'
  spokenAt: number;   // epoch ms
}

let last: ProactiveMessage | null = null;

export function setLastProactiveMessage(text: string, type: string): void {
  last = { text: text.trim(), type, spokenAt: Date.now() };
}

export function getLastProactiveMessage(): ProactiveMessage | null {
  return last;
}

/**
 * Returns a ready-to-inject prompt string, or empty string if nothing was said.
 * Includes relative time so Claude can answer "what did you say just now?" naturally.
 */
export function formatProactiveContext(): string {
  if (!last) return '';

  const minsAgo = Math.round((Date.now() - last.spokenAt) / 60_000);
  const when    = minsAgo === 0 ? 'just now' : `${minsAgo} minute${minsAgo === 1 ? '' : 's'} ago`;

  return `Last thing you said proactively (${last.type}, ${when}):\n"${last.text}"`;
}

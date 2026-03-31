/**
 * Single-slot queue for passing the post-wake-word utterance captured in
 * voiceListener's Realtime session directly to whisperService's first
 * transcribe() call.
 *
 * When the user says "hey axon, set a timer" in one breath the Realtime
 * session transcribes the whole phrase.  voiceListener extracts "set a timer"
 * and stores it here so conversationService's first transcribeWithTimeout()
 * call returns it immediately instead of recording a fresh window and
 * potentially missing what was already said.
 */

let pending: string | null = null;

export function setPendingUtterance(text: string): void {
  pending = text;
}

export function popPendingUtterance(): string | null {
  const u = pending;
  pending = null;
  return u;
}

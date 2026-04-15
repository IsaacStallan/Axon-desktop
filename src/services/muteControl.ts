// ── Mute control ──────────────────────────────────────────────────────────────
// Shared flag checked by conversationService and briefingService before
// calling speak(). Keeps elevenLabsService.ts untouched.

let muted = false;

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): void {
  muted = !muted;
  console.log(`[ElevenLabs] ${muted ? 'muted — skipping speech' : 'unmuted'}`);
}

export function setMuted(value: boolean): void {
  muted = value;
}

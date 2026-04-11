import { getCurrentApp }                             from './windowMonitor';
import { getUserProfile, getRecentInterventions }    from './behaviourModel';
import { getCurrentEmotion }                         from './emotionEngine';
import type { PatternResult }                        from './patternEngine';
import type { InterventionRecord }                   from './behaviourModel';

// ── Types ──────────────────────────────────────────────────────────────────────

export type PsychTechnique =
  | 'implementation_intention'  // "When are you starting — now or after this video?"
  | 'identity_framing'          // "Is this what the person building Axon does?"
  | 'commitment_consistency'    // "Yesterday you said X. Has that changed?"
  | 'loss_aversion'             // "90 minutes until your energy drops. Use it."
  | 'autonomy_preservation'     // "Keep going or should I give you 20 more minutes?"
  | 'social_proof'              // "The version House Stallan sees — is this it?"
  | 'question_activation'       // "What would make today feel like a win?"
  | 'positive_reinforcement';   // "87 minutes locked in. Best block this week."

export interface FramingContext {
  pattern:           PatternResult;
  type:              InterventionRecord['type'];
  interventionCount: number;   // non-break interventions fired today
}

export interface PsychFraming {
  techniques:  PsychTechnique[];
  instruction: string;          // injected into the model system prompt
}

// ── Technique framing instructions ────────────────────────────────────────────
// These are injected as a suffix to the system prompt.
// They tell the model HOW to frame the message, not WHAT to say.

const TECHNIQUE_PROMPTS: Record<PsychTechnique, string> = {
  implementation_intention:
    'Frame using implementation intention. Force a concrete "when" — ' +
    '"When are you starting — now, or after this finishes?" ' +
    'Don\'t lecture. One sharp question is enough.',

  identity_framing:
    'Frame using identity. Contrast what he says he is with what he\'s doing. ' +
    '"Is this what the person building House Stallan does?" ' +
    'Keep it a question. Let the gap speak.',

  commitment_consistency:
    'Frame using commitment and consistency. Reference something he said he would do — ' +
    'name the commitment directly. "You said X. Has that changed, or are you just avoiding it?"',

  loss_aversion:
    'Frame using loss aversion. Quantify the loss in concrete, specific terms — time, opportunity, energy. ' +
    '"That\'s 40 minutes of peak energy gone. You won\'t get it back." No softening.',

  autonomy_preservation:
    'Frame by preserving autonomy. Give him the choice explicitly, but make the stakes clear. ' +
    '"Your call — but the window is closing." Never commanding. Always his decision.',

  social_proof:
    'Frame using social proof and external eyes. ' +
    '"The version House Stallan sees right now — is this it?" ' +
    'Invoke future legacy or the person he says he wants to become.',

  question_activation:
    'Frame using an open activating question. No accusation. No data. Just a grounding question ' +
    'that forces reflection: "What would make today feel like a real win?" ' +
    'Silence can follow. That\'s the point.',

  positive_reinforcement:
    'Frame using genuine positive reinforcement. Acknowledge the real work done first — ' +
    'be specific, not generic. "X minutes locked in" is specific. ' +
    '"Good work" is not. Then make the suggestion from a position of support, not critique.',
};

// ── Ignored intervention streak ────────────────────────────────────────────────

function getIgnoredStreak(): number {
  const resolved = getRecentInterventions(7)
    .filter(r => r.type !== 'break' && r.courseCorrected !== null)
    .reverse(); // most recent first

  let streak = 0;
  for (const r of resolved) {
    if (r.courseCorrected === false) streak++;
    else break;
  }
  return streak;
}

// ── Technique selection ────────────────────────────────────────────────────────

function selectTechniques(ctx: FramingContext): PsychTechnique[] {
  const { pattern, type, interventionCount } = ctx;
  const profile       = getUserProfile();
  const curr          = getCurrentApp();
  const appLower      = curr.name.toLowerCase();
  const ignoredStreak = getIgnoredStreak();
  const emotion       = getCurrentEmotion();

  // ── Break → always warm (not overridable by emotion) ─────────────────────
  if (type === 'break') {
    return ['positive_reinforcement'];
  }

  // ── 3+ ignored in a row → break the pattern entirely ─────────────────────
  if (ignoredStreak >= 3) {
    return ['social_proof', 'question_activation'];
  }

  // ── Tier 3 recovery → identity + war context ──────────────────────────────
  if (type === 'recovery') {
    return ['identity_framing', 'commitment_consistency'];
  }

  // ── Emotion-biased technique selection ────────────────────────────────────
  // Applied after fixed rules so recovery/ignored-streak always take priority.
  switch (emotion.state) {
    case 'frustrated':
      if (emotion.intensity >= 6) return ['commitment_consistency', 'identity_framing'];
      break;
    case 'concerned':
      return ['autonomy_preservation', 'question_activation'];
    case 'satisfied':
      return ['positive_reinforcement'];
    case 'playful':
      return ['social_proof'];
    // neutral / enthusiastic fall through to standard heuristics
  }

  // ── First intervention of the day → gentle question ───────────────────────
  if (interventionCount === 0) {
    return ['question_activation'];
  }

  // ── Post-focus drift: was working, now drifting → acknowledge before pushing
  if (pattern.continuousFocusMins > 30) {
    return ['positive_reinforcement', 'autonomy_preservation'];
  }

  // ── Known drift vector in known vulnerability window ───────────────────────
  const isKnownDriftApp = profile.driftVectors
    .some(v => appLower.includes(v.toLowerCase()));
  if (isKnownDriftApp && pattern.driftProbability >= 70) {
    return ['loss_aversion', 'implementation_intention'];
  }

  // ── Avoidance task context (commitment unmet + high drift) ─────────────────
  if (pattern.reason.toLowerCase().includes('commitment') || pattern.isCompoundVulnerable) {
    return ['identity_framing', 'commitment_consistency'];
  }

  // ── Early tier defaults ────────────────────────────────────────────────────
  if (type === 'early') {
    return ['loss_aversion', 'autonomy_preservation'];
  }

  // ── Predictive — softest touch ─────────────────────────────────────────────
  return ['implementation_intention'];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns framing instructions to be injected into the generation prompt.
 * Does not generate the message — it shapes how the model should frame it.
 */
export function buildFraming(ctx: FramingContext): PsychFraming {
  const profile    = getUserProfile();
  const techniques = selectTechniques(ctx);

  const techniqueText = techniques.map(t => TECHNIQUE_PROMPTS[t]).join('\n\n');

  // Always available: Isaac's personal context
  const context =
    `Isaac's identity context:\n` +
    `- What he's building: House Stallan (his empire — financial freedom, legacy, family wealth)\n` +
    `- At war with: unconscious living, dopamine distraction, the average life\n` +
    `- Known avoidance: ${profile.avoidanceTasks.join(', ')}\n` +
    `- Recovery message (his own words): "${profile.recoveryMessage.slice(0, 120)}..."`;

  const instruction = `${context}\n\nPsychological framing to use:\n${techniqueText}`;

  return { techniques, instruction };
}

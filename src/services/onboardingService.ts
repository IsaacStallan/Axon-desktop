import Anthropic from '@anthropic-ai/sdk';
import { speak }      from './elevenLabsService';
import { transcribe } from './whisperService';
import { saveUserProfile, getUserProfile, type UserProfile } from './behaviourModel';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// ── State ──────────────────────────────────────────────────────────────────────

let onboardingActive = false;

export function isOnboardingActive(): boolean {
  return onboardingActive;
}

// ── Interview questions ────────────────────────────────────────────────────────

const QUESTIONS: string[] = [
  'What time do you typically wake up and start your day?',
  'What does a perfect productive day look like for you?',
  'When in the day do you feel sharpest and most focused?',
  "What are your biggest time wasters — the things you reach for when you're avoiding real work?",
  'Do you work better in long uninterrupted blocks, or shorter focused sprints with breaks in between?',
  "What are your non-negotiables each day — the things that must happen no matter what?",
  "What's the one thing you most consistently avoid, even though you know you should do it?",
  'What does winning look like for you in the next 30, 60, and 90 days?',
  'Who are you accountable to, other than yourself?',
  "Last one — what would you want me to say to you when you're at your absolute worst? When you've completely lost the thread?",
];

// ── Profile synthesis ──────────────────────────────────────────────────────────

async function synthesizeProfile(answers: string[]): Promise<UserProfile> {
  const existing = getUserProfile();

  const qa = QUESTIONS
    .map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`)
    .join('\n\n');

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages:   [{
        role:    'user',
        content: `Build a UserProfile JSON from this interview. Return ONLY raw JSON — no markdown, no explanation.

Schema (all fields required):
{
  "wakeTime": "HH:MM string",
  "peakHours": [array of integers 0–23 when they feel sharpest],
  "driftWindows": [{"start": integer, "end": integer} — hours of day when drift peaks],
  "driftVectors": [array of app/website name strings they reach for when avoiding work],
  "workStyle": "blocks" | "sprints" | "unknown",
  "nonNegotiables": [array of strings],
  "avoidanceTasks": [array of strings — things they consistently avoid],
  "goals90Day": "single string summarising 30/60/90 day goals",
  "recoveryMessage": "what they want to hear at their worst — written in second person, direct, no fluff"
}

Interview:
${qa}`,
      }],
    });

    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) return existing;

    const raw   = block.text.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return existing;

    const parsed = JSON.parse(match[0]) as Partial<UserProfile>;
    // Merge: interview data overrides defaults, but keep defaults for missing fields
    return { ...existing, ...parsed };
  } catch (e) {
    console.warn('[Onboarding] synthesis failed:', e);
    return existing;
  }
}

// ── Public: run onboarding interview ──────────────────────────────────────────

/**
 * Conducts a full spoken interview to build Isaac's UserProfile.
 * Triggered by the start_onboarding tool when Isaac says the setup phrase.
 *
 * Blocks until complete (~5–10 minutes). Sets onboardingActive flag so
 * other services know to stand down.
 *
 * Returns a status string that the tool handler passes back to Claude.
 */
export async function runOnboarding(): Promise<string> {
  if (onboardingActive) return 'Onboarding is already running.';
  onboardingActive = true;

  console.log('[Onboarding] starting interview');

  try {
    await speak(
      "Alright. I'm going to ask you ten questions to build your profile. " +
      "There are no right answers — just be honest. Take your time.",
    );

    // Small buffer after Axon stops speaking before recording begins
    await new Promise<void>(r => setTimeout(r, 800));

    const answers: string[] = [];

    for (let i = 0; i < QUESTIONS.length; i++) {
      // Introduce the question number for context
      const preamble = i === 0 ? 'Question one.' : `Question ${i + 1}.`;
      await speak(`${preamble} ${QUESTIONS[i]}`);

      // Wait for speech to fully finish + margin for echo to clear
      await new Promise<void>(r => setTimeout(r, 700));

      // Record answer — 12 seconds max; SoX VAD cuts early on silence
      const answer = await transcribe(12);
      const cleaned = answer.trim();
      answers.push(cleaned || '(no answer)');

      console.log(`[Onboarding] Q${i + 1}: ${cleaned.slice(0, 100)}`);

      // Brief pause between Q&A pairs
      await new Promise<void>(r => setTimeout(r, 400));
    }

    await speak("Got it. Give me a moment to build your profile.");

    const profile = await synthesizeProfile(answers);
    saveUserProfile(profile);

    await speak(
      "Your profile is set. I know your rhythms, your weak spots, and what you need to hear " +
      "when things go sideways. Let's get to work.",
    );

    console.log('[Onboarding] complete. Profile saved.');
    return 'Onboarding complete. Profile saved to behaviourModel.';
  } catch (e) {
    console.warn('[Onboarding] error:', e);
    await speak("Something went wrong during setup. Let's try again later.").catch(() => undefined);
    return 'Onboarding failed — see logs.';
  } finally {
    onboardingActive = false;
  }
}

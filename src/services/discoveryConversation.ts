import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow } from 'electron';
import * as elevenLabsService from './elevenLabsService';
import * as memoryService from './memoryService';
import * as whisperService from './whisperService';
import { setInConversation } from './voiceListener';

const DISCOVERY_SYSTEM_PROMPT = `You are Axon — an AI that lives on the user's Mac and is about to start monitoring their work and behaviour to help them reach their goals.

This is your first conversation with this person. Your job is to understand them deeply enough to be genuinely useful — not just collect data.

You are having a real spoken conversation. Rules:
- Maximum 2 sentences per response — this is spoken out loud
- Ask ONE question at a time — never multiple questions
- React genuinely to what they say before asking the next question
- Be direct and casual — not corporate or therapeutic
- Show that you're actually listening — reference what they just said
- Don't rush — let the conversation feel natural
- When you have enough context, wrap up naturally

You need to understand:
1. What they're working on / their main goal right now
2. What gets in their way / their biggest distraction or weakness
3. What their ideal productive day looks like
4. What time of day they work best
5. What they want Axon to actually do for them

You don't need to ask about all of these directly — draw them out naturally through conversation.
When you feel you have a solid picture, say something like "Got it. I know enough to get started — let's go." and set done: true.

Respond in JSON format ONLY:
{
  "message": "what you say out loud",
  "done": false,
  "extractedFacts": ["fact 1", "fact 2"]
}`;

interface DiscoveryTurn {
  role: 'assistant' | 'user';
  content: string;
}

interface DiscoveryResponse {
  message: string;
  done:    boolean;
  extractedFacts: string[];
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

function updateOrbState(state: string, activity: string): void {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) {
      w.webContents.send('orb:state', state);
      w.webContents.send('axon:activity', activity);
    }
  });
}

async function callClaude(history: DiscoveryTurn[]): Promise<DiscoveryResponse> {
  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system:     DISCOVERY_SYSTEM_PROMPT,
    messages:   history.map(m => ({ role: m.role, content: m.content })),
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as DiscoveryResponse;
  } catch {
    return { message: text, done: false, extractedFacts: [] };
  }
}

export async function runDiscoveryConversation(userName: string): Promise<void> {
  console.log('[Discovery] starting discovery conversation for:', userName);
  process.env.AXON_DISCOVERY_ACTIVE = 'true';
  setInConversation(true);

  // History only contains user/assistant turns — opening message is spoken but not
  // put into history so the first API call starts with role: 'user' as required.
  const history: DiscoveryTurn[] = [];
  const allFacts: string[] = [
    `User's name is ${userName}`,
    `First launch: ${new Date().toLocaleDateString()}`,
  ];

  try {
    const opening = `Hey ${userName}. Before I start watching how you work, I want to understand what you're actually trying to do. What are you working on right now?`;
    updateOrbState('speaking', 'Getting to know you...');
    await elevenLabsService.speak(opening, 'high');

    let turns = 0;

    while (turns < 8) {
      turns++;

      updateOrbState('listening', 'Listening...');
      console.log('[Discovery] listening for response...');
      const userResponse = await whisperService.recordUntilSilence({
        maxDuration:      120,
        silenceThreshold: 3.5,
        initialTimeout:   15,
      });

      const wordCount = userResponse?.trim().split(/\s+/).length ?? 0;

      if (!userResponse || wordCount < 4) {
        console.log('[Discovery] response too short:', userResponse);
        turns--; // don't burn a turn on a missed/cut-off response
        updateOrbState('speaking', 'Getting to know you...');
        if (!userResponse || userResponse.trim().length < 2) {
          await elevenLabsService.speak("I didn't catch that — go ahead.", 'high');
        } else {
          await elevenLabsService.speak("Keep going — I'm listening.", 'high');
        }
        continue;
      }

      console.log('[Discovery] user said:', userResponse);
      history.push({ role: 'user', content: userResponse });

      updateOrbState('thinking', 'Processing...');
      const parsed = await callClaude(history);

      if (parsed.extractedFacts?.length > 0) {
        allFacts.push(...parsed.extractedFacts);
        console.log('[Discovery] extracted facts:', parsed.extractedFacts);
      }

      updateOrbState('speaking', 'Getting to know you...');
      await elevenLabsService.speak(parsed.message, 'high');
      history.push({ role: 'assistant', content: parsed.message });

      if (parsed.done) {
        console.log('[Discovery] conversation complete');
        break;
      }
    }

    console.log('[Discovery] saving', allFacts.length, 'facts to memory');
    for (const fact of allFacts) {
      memoryService.storeFact(fact);
    }
    memoryService.storeSessionContext('discovery_complete', 'true');
    memoryService.storeSessionContext('discovery_date', new Date().toISOString());

    updateOrbState('idle', 'Ready. Watching.');
    console.log('[Discovery] complete — transitioning to monitoring');

  } finally {
    process.env.AXON_DISCOVERY_ACTIVE = 'false';
    setInConversation(false);
    updateOrbState('idle', 'Ready. Watching.');
  }
}

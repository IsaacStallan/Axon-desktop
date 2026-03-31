/**
 * Thin wrapper around the OpenAI Whisper API that transcribes an existing
 * WAV file.  Unlike whisperService.transcribe(), this function does NOT
 * record anything — the caller owns both the recording and file clean-up.
 *
 * Throws on API errors so callers can decide how to handle them.
 */

import OpenAI from 'openai';
import { toFile } from 'openai';
import fs from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

export async function transcribeFile(filePath: string): Promise<string> {
  const buffer   = fs.readFileSync(filePath);
  const file     = await toFile(buffer, 'audio.wav', { type: 'audio/wav' });

  const response = await openai.audio.transcriptions.create({
    file,
    model:    'whisper-1',
    language: 'en',
  });

  const result = response.text.trim();
  console.log('[Whisper] transcript:', result);
  return result;
}

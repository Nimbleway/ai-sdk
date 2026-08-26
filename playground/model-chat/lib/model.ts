import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI, openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export function resolveModel(): LanguageModel {
  if (process.env.OPENAI_API_KEY) {
    return openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5');
  }
  if (process.env.OPENROUTER_API_KEY) {
    return createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    })(process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini');
  }
  throw new Error('Configure OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.');
}

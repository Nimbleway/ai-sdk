/**
 * streamText + nimbleSearch: same tool, streamed output. The model calls
 * nimbleSearch as needed and streams its cited answer to stdout.
 *
 *   export NIMBLE_API_KEY=...   export OPENAI_API_KEY=...
 *   pnpm install && pnpm stream "your question"
 */
import { openai } from '@ai-sdk/openai';
import { streamText, stepCountIs } from 'ai';
import { nimbleSearch } from '@nimble-way/ai-sdk';

const prompt =
  process.argv.slice(2).join(' ') ||
  'What are the latest developments in agentic web search? Cite sources.';

async function main() {
  const result = streamText({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    prompt,
    tools: { webSearch: nimbleSearch() },
    stopWhen: stepCountIs(3),
  });

  for await (const chunk of result.textStream) process.stdout.write(chunk);
  process.stdout.write('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

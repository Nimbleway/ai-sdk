/**
 * generateText + nimbleExtract: the model reads a web page with Nimble and
 * summarizes it.
 *
 *   export NIMBLE_API_KEY=...   export OPENAI_API_KEY=...
 *   pnpm install && pnpm extract "https://en.wikipedia.org/wiki/Web_scraping"
 */
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { nimbleExtract } from '@nimble-way/ai-sdk';
import type { NimbleExtractOutput } from '@nimble-way/ai-sdk';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';

async function main() {
  const { text, steps } = await generateText({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    prompt: `Read this page and summarize it in 3 bullet points: ${url}`,
    tools: { extract: nimbleExtract({ format: 'markdown' }) },
    stopWhen: stepCountIs(3),
  });

  for (const toolResult of steps.flatMap((step) => step.toolResults)) {
    if (toolResult.toolName !== 'extract') continue;
    const out = toolResult.output as NimbleExtractOutput | undefined;
    if (!out) continue;
    console.log(`\n[nimbleExtract] ${out.url} (${out.status}, ${out.content.length} chars)`);
  }

  console.log('\n[summary]\n' + text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * generateText + nimbleSearch: the model searches the web with Nimble, then
 * answers with citations.
 *
 *   export NIMBLE_API_KEY=...   export OPENAI_API_KEY=...
 *   pnpm install && pnpm generate "your question"
 */
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { nimbleSearch } from '@nimble-way/ai-sdk';
import type { NimbleSearchOutput } from '@nimble-way/ai-sdk';

const prompt =
  process.argv.slice(2).join(' ') ||
  'What are the latest developments in agentic web search? Cite sources.';

async function main() {
  const { text, steps } = await generateText({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    prompt,
    tools: { webSearch: nimbleSearch() },
    stopWhen: stepCountIs(3),
  });

  for (const toolResult of steps.flatMap((step) => step.toolResults)) {
    if (toolResult.toolName !== 'webSearch') continue;
    const out = toolResult.output as NimbleSearchOutput | undefined;
    if (!out?.results) continue;
    console.log(`\n[nimbleSearch] "${out.query}" → ${out.results.length} results`);
    for (const r of out.results) console.log(`  ${r.position ?? '·'}. ${r.title}\n     ${r.url}`);
  }

  console.log('\n[answer]\n' + text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

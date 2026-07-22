/**
 * Deep research with Nimble Agent runs — start now, answer later.
 *
 * A research run takes minutes; no chat request should block that long. This
 * example plays both sides of the async story:
 *
 *   request 1  the model starts a run and replies immediately (milliseconds)
 *   …time passes (your app serves other traffic; the user leaves)…
 *   request 2  the model fetches the finished result and answers with
 *              citations — needing nothing but the runId
 *
 *   export NIMBLE_API_KEY=...  export OPENAI_API_KEY=...  export NIMBLE_AGENT_ID=wsa_...
 *
 *   pnpm agent "your research question"          # full flow in one process
 *   pnpm agent --start-only "your question"      # request 1 only; prints how to resume
 *   pnpm agent --resume task_run_...             # request 2 in a FRESH process
 */
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
} from '@nimble-way/ai-sdk';
import type {
  NimbleAgentRunResultOutput,
  NimbleAgentRunStatusOutput,
  NimbleAgentStartRunOutput,
} from '@nimble-way/ai-sdk';

const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
// Tool execute() normally receives its options from the AI SDK loop; the
// direct polling bridge below supplies a minimal stub.
const directOpts = { toolCallId: 'direct', messages: [] } as never;

const DEFAULT_TASK =
  'What changed in the EU AI Act enforcement timeline in the last 12 months, ' +
  'and which obligations apply to general-purpose AI providers next? Cite sources.';

/** Request 1 — the model kicks off the run and the request returns instantly. */
async function startPhase(task: string): Promise<string> {
  const t0 = performance.now();
  const { text, steps } = await generateText({
    model,
    prompt:
      `Start a deep-research run for this task, then tell the user (one short ` +
      `paragraph) that research is underway and their answer will be ready in a ` +
      `few minutes. If starting fails, do NOT claim research is underway — ` +
      `relay exactly what went wrong instead:\n\n${task}`,
    tools: { startResearch: nimbleAgentStartRun({ effort: 'medium' }) },
    stopWhen: stepCountIs(2),
  });

  const started = steps
    .flatMap((step) => step.toolResults)
    .find((r) => r.toolName === 'startResearch')?.output as NimbleAgentStartRunOutput | undefined;
  if (!started) {
    // Surface the tool's own error (e.g. a NimbleAgentRunError for a quota
    // 429) rather than a generic failure.
    const toolError = steps.flatMap((s) => s.content).find((p) => p.type === 'tool-error');
    const detail = toolError ? `\n[tool-error] ${String(toolError.error)}` : '';
    throw new Error('The model did not start a research run.' + detail);
  }

  console.log(
    `\n[request 1] done in ${Math.round(performance.now() - t0)}ms — ` +
      `run ${started.runId} (effort: ${started.effort}, status: ${started.status}) ` +
      'is researching in the background',
  );
  console.log('[assistant]', text);
  return started.runId;
}

/**
 * The bridge between requests: something in your app (a poller, a cron, a
 * webhook-adjacent worker, or simply the user returning) decides when to ask
 * again. Here: a plain status poll — cheap GETs, no LLM involved.
 */
async function waitUntilTerminal(runId: string): Promise<void> {
  const status = nimbleAgentRunStatus();
  const t0 = performance.now();
  for (;;) {
    const snapshot = (await status.execute!(
      { runId },
      directOpts,
    )) as NimbleAgentRunStatusOutput;
    console.log(
      `[status] ${snapshot.status} — ${Math.round((performance.now() - t0) / 1000)}s elapsed`,
    );
    if (!snapshot.isActive) return;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Request 2 — a fresh request (or process): only the runId crosses over. */
async function resumePhase(runId: string): Promise<void> {
  const t0 = performance.now();
  const { text, steps } = await generateText({
    model,
    prompt:
      `The user is back. A deep-research run was started earlier for them: ${runId}. ` +
      `Fetch its result. If it is not ready yet, say so briefly. If it is ready, ` +
      `answer the user's research question from it, keeping the numbered citation ` +
      `callouts, and finish with a short source list.`,
    tools: { getResearchResult: nimbleAgentRunResult() },
    stopWhen: stepCountIs(2),
  });

  const result = steps
    .flatMap((step) => step.toolResults)
    .find((r) => r.toolName === 'getResearchResult')?.output as
    | NimbleAgentRunResultOutput
    | undefined;

  console.log(`\n[request 2] done in ${Math.round(performance.now() - t0)}ms`);
  if (result?.ready) {
    const trust = result.output.trust;
    console.log(
      `[trust] confidence: ${trust.confidence} — ${trust.sources.length} sources, ` +
        `${trust.claims.length} cited claims`,
    );
    for (const s of trust.sources.slice(0, 5)) {
      console.log(`  [${s.type}] ${s.title ?? s.url}\n         ${s.url}`);
    }
  }
  console.log('\n[assistant]\n' + text);
}

async function main() {
  const args = process.argv.slice(2);

  const resumeAt = args.indexOf('--resume');
  if (resumeAt !== -1) {
    const runId = args[resumeAt + 1];
    if (!runId) throw new Error('Usage: pnpm agent --resume task_run_...');
    await resumePhase(runId);
    return;
  }

  const startOnly = args.includes('--start-only');
  const task = args.filter((a) => a !== '--start-only').join(' ') || DEFAULT_TASK;

  const runId = await startPhase(task);
  if (startOnly) {
    console.log(
      `\nResume later — in a completely separate process if you like:\n` +
        `  pnpm agent --resume ${runId}`,
    );
    return;
  }

  console.log('\n…the app is free; simulating the user coming back later…');
  await waitUntilTerminal(runId);
  await resumePhase(runId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

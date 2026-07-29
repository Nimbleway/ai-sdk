import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
} from '@nimble-way/ai-sdk';

export const POLL_INTERVAL_MS = 10_000;
export const RESULT_TIMEOUT_MS = 300_000;

type ToolFactories = {
  start: typeof nimbleAgentStartRun;
  status: typeof nimbleAgentRunStatus;
  result: typeof nimbleAgentRunResult;
};

type ExecutableTool = {
  execute?: (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
};

const defaultFactories: ToolFactories = {
  start: nimbleAgentStartRun,
  status: nimbleAgentRunStatus,
  result: nimbleAgentRunResult,
};

/**
 * Request-scoped tools for the model-driven demo. No agentId is configured,
 * so startResearch uses POST /v2/agents/runs and preserves the generated
 * agentId returned with the run. Create is pinned to low; the package itself
 * disables retries for the non-idempotent create request.
 */
export function buildAgentTools(apiKey: string, factories: ToolFactories = defaultFactories) {
  const tools = {
    startResearch: factories.start({ apiKey, effort: 'low' }),
    checkResearch: factories.status({ apiKey }),
    getResearchResult: factories.result({
      apiKey,
      wait: {
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMs: RESULT_TIMEOUT_MS,
      },
    }),
  };

  const start = tools.startResearch as ExecutableTool;
  const status = tools.checkResearch as ExecutableTool;
  const result = tools.getResearchResult as ExecutableTool;
  if (!start.execute || !status.execute || !result.execute) {
    throw new Error('Agent tools must provide server-side execute handlers.');
  }

  const executeStart = start.execute.bind(start);
  const executeStatus = status.execute.bind(status);
  const executeResult = result.execute.bind(result);
  let createPromise: Promise<Record<string, unknown>> | undefined;

  const guardedStart = {
    ...start,
    execute(input: Record<string, unknown>, options: unknown) {
      createPromise ??= executeStart(input, options);
      return createPromise;
    },
  };

  async function assertGuardedIds(input: Record<string, unknown>) {
    if (!createPromise) {
      throw new Error('Start the research run before checking its lifecycle.');
    }
    const created = await createPromise;
    if (input.runId !== created.runId || input.agentId !== created.agentId) {
      throw new Error('Lifecycle IDs must match the run created in this request.');
    }
  }

  return {
    startResearch: guardedStart,
    checkResearch: {
      ...status,
      async execute(input: Record<string, unknown>, options: unknown) {
        await assertGuardedIds(input);
        return executeStatus(input, options);
      },
    },
    getResearchResult: {
      ...result,
      async execute(input: Record<string, unknown>, options: unknown) {
        await assertGuardedIds(input);
        return executeResult(input, options);
      },
    },
  } as unknown as typeof tools;
}

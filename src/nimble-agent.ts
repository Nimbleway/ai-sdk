import { tool } from 'ai';
import { createNimbleClient } from './client';
import {
  NIMBLE_AGENT_RUN_STATUSES,
  nimbleAgentRunIdInputSchema,
  nimbleAgentStartRunInputSchema,
} from './agent-schemas';
import type {
  NimbleAgentEffort,
  NimbleAgentOutput,
  NimbleAgentRawFailedResult,
  NimbleAgentRawResult,
  NimbleAgentRawRun,
  NimbleAgentRequestOptions,
  NimbleAgentRunCreateBody,
  NimbleAgentRunCompletedOutput,
  NimbleAgentRunLifecycleStatus,
  NimbleAgentRunPendingOutput,
  NimbleAgentRunResultConfig,
  NimbleAgentRunResultOutput,
  NimbleAgentRunsClient,
  NimbleAgentRunStatusOutput,
  NimbleAgentStartRunConfig,
  NimbleAgentStartRunOutput,
  NimbleAgentToolConfig,
  NimbleAgentWaitOptions,
} from './agent-schemas';
import { NimbleAgentRunError, NimbleConfigError } from './errors';

/**
 * Agent tool defaults. `effortCap` bounds only the *model's* effort choice;
 * the wait values apply when {@link NimbleAgentRunResultConfig.wait} is
 * enabled (it is off by default — the result tool never blocks unless asked).
 */
export const NIMBLE_AGENT_DEFAULTS = {
  effortCap: 'high',
  waitTimeoutMs: 300_000,
  pollIntervalMs: 2_000,
  minPollIntervalMs: 100,
} as const;

const EFFORT_ORDER: Record<NimbleAgentEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  'x-high': 3,
  max: 4,
};

// Derived from the canonical const array so a drift between the type and the
// runtime guard cannot compile.
const LIFECYCLE_STATUSES: ReadonlySet<NimbleAgentRunLifecycleStatus> = new Set(
  NIMBLE_AGENT_RUN_STATUSES,
);

function capEffort(requested: NimbleAgentEffort, cap: NimbleAgentEffort): NimbleAgentEffort {
  return EFFORT_ORDER[requested] > EFFORT_ORDER[cap] ? cap : requested;
}

function readStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function asFailedResult(value: unknown): NimbleAgentRawFailedResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<NimbleAgentRawFailedResult>;
  if (
    typeof candidate.run?.status === 'string' &&
    typeof candidate.error?.message === 'string'
  ) {
    return candidate as NimbleAgentRawFailedResult;
  }
  return undefined;
}

/**
 * Parsed error body of a Stainless APIError, when it carries a failed result.
 * The API delivers the 422 failure form either bare (`{ run, error }`) or
 * wrapped in the gateway's error envelope (`{ detail: { run, error } }`) —
 * accept both so terminal failed/cancelled mapping and the server message
 * survive either shape.
 */
function readFailedResultBody(err: unknown): NimbleAgentRawFailedResult | undefined {
  if (typeof err !== 'object' || err === null || !('error' in err)) return undefined;
  const body = (err as { error?: unknown }).error;
  if (typeof body !== 'object' || body === null) return undefined;
  return asFailedResult(body) ?? asFailedResult((body as { detail?: unknown }).detail);
}

function toAgentError(
  err: unknown,
  context: { verb: string; runId?: string; agentId?: string },
): NimbleAgentRunError {
  if (err instanceof NimbleAgentRunError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const runRef = context.runId ? ` (run ${context.runId})` : '';
  return new NimbleAgentRunError(`Nimble agent ${context.verb} failed${runRef}: ${message}`, {
    reason: 'request',
    runId: context.runId,
    agentId: context.agentId,
    status: readStatus(err),
    cause: err,
  });
}

function terminalFailure(
  run: Pick<NimbleAgentRawRun, 'status'> & Partial<NimbleAgentRawRun>,
  ids: { runId: string; agentId: string },
  serverMessage?: string,
): NimbleAgentRunError {
  const reason = run.status === 'cancelled' ? 'cancelled' : 'failed';
  const detail = serverMessage ?? run.error?.message;
  return new NimbleAgentRunError(
    `Nimble agent run ${ids.runId} ${run.status}${detail ? `: ${detail}` : '.'}`,
    {
      reason,
      runId: ids.runId,
      agentId: ids.agentId,
      runStatus: run.status,
    },
  );
}

interface AgentContext {
  client: NimbleAgentRunsClient;
  agentId: string;
}

function resolveAgentContext(config: NimbleAgentToolConfig, factory: string): AgentContext {
  const agentId = config.agentId ?? process.env.NIMBLE_AGENT_ID;
  if (!agentId) {
    throw new NimbleConfigError(
      `Missing Nimble agent id: set NIMBLE_AGENT_ID or pass { agentId } to ${factory}(). ` +
        'Create an agent instance once via the Nimble console or POST /v2/agents.',
    );
  }
  if (config.client) return { client: config.client, agentId };
  const apiKey = config.apiKey ?? process.env.NIMBLE_API_KEY;
  if (!apiKey) {
    throw new NimbleConfigError(
      `Missing Nimble API key: set NIMBLE_API_KEY or pass { apiKey } to ${factory}().`,
    );
  }
  const client = createNimbleClient(apiKey, config.clientOptions) as unknown as NimbleAgentRunsClient;
  return { client, agentId };
}

function requestOptions(signal: AbortSignal | undefined): NimbleAgentRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

function assertKnownStatus(
  run: NimbleAgentRawRun,
  ids: { runId: string; agentId: string },
): void {
  if (!LIFECYCLE_STATUSES.has(run.status)) {
    throw new NimbleAgentRunError(
      `Nimble agent run ${ids.runId} reported unknown status "${String(run.status)}".`,
      {
        reason: 'protocol',
        runId: ids.runId,
        agentId: ids.agentId,
        runStatus: String(run.status),
      },
    );
  }
}

function baseFields(run: NimbleAgentRawRun, agentId: string) {
  return {
    runId: run.id,
    // Deliberately truthy (not `??`): an out-of-contract empty string from the
    // server should also fall back to the configured agent id.
    agentId: run.web_search_agent_id || agentId,
    effort: run.effort,
    createdAt: run.created_at,
  };
}

function toStartOutput(run: NimbleAgentRawRun, agentId: string): NimbleAgentStartRunOutput {
  return {
    ...baseFields(run, agentId),
    interactionId: run.interaction_id,
    status: run.status,
  };
}

function toStatusOutput(run: NimbleAgentRawRun, agentId: string): NimbleAgentRunStatusOutput {
  return {
    ...baseFields(run, agentId),
    status: run.status,
    isActive: run.is_active,
    ...(run.started_at ? { startedAt: run.started_at } : {}),
    ...(run.completed_at ? { completedAt: run.completed_at } : {}),
    ...(run.error?.message ? { error: { message: run.error.message } } : {}),
  };
}

function toPendingOutput(
  run: NimbleAgentRawRun,
  agentId: string,
  status: 'queued' | 'running',
): NimbleAgentRunPendingOutput {
  return {
    ready: false,
    ...baseFields(run, agentId),
    status,
    isActive: true,
    ...(run.started_at ? { startedAt: run.started_at } : {}),
  };
}

function protocolError(ids: { runId: string; agentId: string }, runStatus?: string) {
  return new NimbleAgentRunError(
    `Nimble agent run ${ids.runId} returned a malformed result payload.`,
    { reason: 'protocol', runId: ids.runId, agentId: ids.agentId, runStatus },
  );
}

function toAgentOutput(
  raw: NimbleAgentRawResult['output'],
  ids: { runId: string; agentId: string },
): NimbleAgentOutput {
  // The SDK does not runtime-validate bodies; a misbehaving proxy can deliver
  // an out-of-contract container. Keep such cases inside the typed
  // protocol-error contract instead of surfacing a raw TypeError.
  if (typeof raw !== 'object' || raw === null) {
    throw protocolError(ids, 'completed');
  }
  // `trust` is required on both output forms; a body missing it would make the
  // typed output lie (non-null field holding undefined).
  if (typeof raw.trust !== 'object' || raw.trust === null) {
    throw protocolError(ids, 'completed');
  }
  const kind = raw.type ?? (typeof raw.content === 'string' ? 'text' : 'json');
  if (kind === 'text' && typeof raw.content === 'string') {
    return { type: 'text', text: raw.content, trust: raw.trust };
  }
  if (kind === 'json' && typeof raw.content === 'object' && raw.content !== null) {
    return { type: 'json', json: raw.content, trust: raw.trust };
  }
  throw protocolError(ids, 'completed');
}

function toCompletedOutput(
  result: NimbleAgentRawResult,
  agentId: string,
): NimbleAgentRunCompletedOutput {
  const run = result.run;
  return {
    ready: true,
    ...baseFields(run, agentId),
    status: 'completed',
    ...(run.started_at ? { startedAt: run.started_at } : {}),
    ...(run.completed_at ? { completedAt: run.completed_at } : {}),
    output: toAgentOutput(result.output, { runId: run.id, agentId }),
  };
}

/** Abortable sleep; rejects with the signal's reason when aborted. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('The operation was aborted.');
}

function normalizeWait(
  wait: NimbleAgentRunResultConfig['wait'],
): Required<NimbleAgentWaitOptions> | undefined {
  if (!wait) return undefined;
  const options = wait === true ? {} : wait;
  return {
    timeoutMs: options.timeoutMs ?? NIMBLE_AGENT_DEFAULTS.waitTimeoutMs,
    pollIntervalMs: Math.max(
      options.pollIntervalMs ?? NIMBLE_AGENT_DEFAULTS.pollIntervalMs,
      NIMBLE_AGENT_DEFAULTS.minPollIntervalMs,
    ),
  };
}

/**
 * Create a Vercel AI SDK tool that starts a Nimble deep-research agent run
 * (`@nimble-way/nimble-js` → `POST /v2/agents/{agent_id}/runs`) and returns
 * immediately with the real `task_run_…` ID.
 *
 * The research runs asynchronously on Nimble's side (typically minutes at
 * `medium`+ effort) — a chat request is never blocked for the run's duration.
 * Pair with {@link nimbleAgentRunStatus} / {@link nimbleAgentRunResult} to
 * collect the answer later, from the same or a completely different process.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { nimbleAgentStartRun, nimbleAgentRunResult } from '@nimble-way/ai-sdk';
 *
 * const { text } = await generateText({
 *   model: 'anthropic/claude-sonnet-4.6',
 *   prompt: 'Kick off deep research on the EU AI Act enforcement timeline.',
 *   tools: {
 *     startResearch: nimbleAgentStartRun({ agentId: process.env.NIMBLE_AGENT_ID }),
 *     getResearchResult: nimbleAgentRunResult({ agentId: process.env.NIMBLE_AGENT_ID }),
 *   },
 * });
 * ```
 */
export function nimbleAgentStartRun(config: NimbleAgentStartRunConfig = {}) {
  const effortCap = config.effortCap ?? NIMBLE_AGENT_DEFAULTS.effortCap;

  return tool({
    description:
      'Start a Nimble deep-research agent run for a complex research task. ' +
      'Returns immediately with a runId while the research (which can take ' +
      'minutes) continues in the background. Use the run-status or run-result ' +
      'tool with the returned runId to collect the answer later — even from a ' +
      'different conversation turn or process.',
    inputSchema: nimbleAgentStartRunInputSchema,
    execute: async (input, options): Promise<NimbleAgentStartRunOutput> => {
      const { client, agentId } = resolveAgentContext(config, 'nimbleAgentStartRun');
      const signal = options?.abortSignal;

      const effort = input.effort ? capEffort(input.effort, effortCap) : config.effort;
      const body: NimbleAgentRunCreateBody = {
        input: input.task,
        ...(effort ? { effort } : {}),
      };

      let run: NimbleAgentRawRun;
      try {
        run = await client.agents.runs.create(agentId, body, requestOptions(signal));
      } catch (err) {
        throw toAgentError(err, { verb: 'run creation', agentId });
      }
      assertKnownStatus(run, { runId: run.id, agentId });
      return toStartOutput(run, agentId);
    },
  });
}

/**
 * Create a Vercel AI SDK tool that reports the current status of a Nimble
 * agent run (`GET /v2/agents/{agent_id}/runs/{run_id}`). Instant and cheap;
 * never waits. Works for any run of the configured agent, including runs
 * started by another process — only the `runId` is needed.
 */
export function nimbleAgentRunStatus(config: NimbleAgentToolConfig = {}) {
  return tool({
    description:
      'Check the current status of a Nimble deep-research agent run by runId ' +
      '(queued, running, completed, failed, or cancelled). Instant; never ' +
      'waits. Use the run-result tool to fetch the finished answer.',
    inputSchema: nimbleAgentRunIdInputSchema,
    execute: async (input, options): Promise<NimbleAgentRunStatusOutput> => {
      const { client, agentId } = resolveAgentContext(config, 'nimbleAgentRunStatus');
      const signal = options?.abortSignal;

      let run: NimbleAgentRawRun;
      try {
        run = await client.agents.runs.get(
          input.runId,
          { agent_id: agentId },
          requestOptions(signal),
        );
      } catch (err) {
        throw toAgentError(err, { verb: 'status check', runId: input.runId, agentId });
      }
      assertKnownStatus(run, { runId: input.runId, agentId });
      return toStatusOutput(run, agentId);
    },
  });
}

/**
 * Create a Vercel AI SDK tool that fetches the result of a Nimble agent run
 * (`GET /v2/agents/{agent_id}/runs/{run_id}/result`).
 *
 * A still-active run returns `{ ready: false, status }` — an expected async
 * state, not an error — so the model can tell the user to check back. Enable
 * `config.wait` to bounded-poll first (timeout + AbortSignal aware; the run
 * keeps going server-side if the wait gives up). A run that terminally
 * `failed`/`cancelled` throws {@link NimbleAgentRunError} with the runId
 * preserved. Completed runs return the answer — prose `text` or structured
 * `json` — plus verbatim `trust` metadata (sources, per-claim citations,
 * confidence).
 */
export function nimbleAgentRunResult(config: NimbleAgentRunResultConfig = {}) {
  const wait = normalizeWait(config.wait);

  return tool({
    description:
      'Fetch the result of a Nimble deep-research agent run by runId. If the ' +
      'run is still working, returns { ready: false } — check again later. ' +
      'When complete, returns the answer (text or structured JSON) with ' +
      'sources, per-claim citations, and confidence metadata.',
    inputSchema: nimbleAgentRunIdInputSchema,
    execute: async (input, options): Promise<NimbleAgentRunResultOutput> => {
      const { client, agentId } = resolveAgentContext(config, 'nimbleAgentRunResult');
      const signal = options?.abortSignal;
      const ids = { runId: input.runId, agentId };

      const getRun = async (): Promise<NimbleAgentRawRun> => {
        try {
          return await client.agents.runs.get(
            input.runId,
            { agent_id: agentId },
            requestOptions(signal),
          );
        } catch (err) {
          throw toAgentError(err, { verb: 'status check', ...ids });
        }
      };

      let run = await getRun();
      assertKnownStatus(run, ids);

      if (wait && run.is_active) {
        const startedWaiting = performance.now();
        while (run.is_active) {
          const elapsed = performance.now() - startedWaiting;
          const remaining = wait.timeoutMs - elapsed;
          if (remaining <= 0) break;
          await sleep(Math.min(wait.pollIntervalMs, remaining), signal);
          run = await getRun();
          assertKnownStatus(run, ids);
        }
      }

      if (run.status === 'queued' || run.status === 'running') {
        return toPendingOutput(run, agentId, run.status);
      }
      if (run.status === 'failed' || run.status === 'cancelled') {
        throw terminalFailure(run, ids);
      }

      // status === 'completed' — fetch the output.
      let result: NimbleAgentRawResult | NimbleAgentRawFailedResult;
      try {
        result = await client.agents.runs.result(
          input.runId,
          { agent_id: agentId },
          requestOptions(signal),
        );
      } catch (err) {
        const httpStatus = readStatus(err);
        // 409: the result endpoint still considers the run active (eventual
        // consistency with the status we just read) — report not-ready.
        if (httpStatus === 409) {
          return toPendingOutput({ ...run, status: 'running', is_active: true }, agentId, 'running');
        }
        // 422: terminal failure — the body carries the run + structured error.
        if (httpStatus === 422) {
          const failed = readFailedResultBody(err);
          if (failed) throw terminalFailure(failed.run, ids, failed.error.message);
        }
        throw toAgentError(err, { verb: 'result fetch', ...ids });
      }

      if (typeof result !== 'object' || result === null) {
        throw protocolError(ids);
      }
      if (!('output' in result)) {
        // Failed form: { run, error }. Validate the run before dereferencing
        // so a run-less body maps to 'protocol', not a TypeError.
        if (typeof result.run?.status !== 'string') throw protocolError(ids);
        throw terminalFailure(result.run, ids, result.error?.message);
      }
      if (typeof result.run?.status !== 'string') throw protocolError(ids);
      return toCompletedOutput(result, agentId);
    },
  });
}

/** Lifecycle statuses re-exported for convenience in host apps. */
export type { NimbleAgentRunLifecycleStatus };

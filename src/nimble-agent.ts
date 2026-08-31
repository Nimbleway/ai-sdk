import { tool } from 'ai';
import { createNimbleClient } from './client';
import {
  NIMBLE_AGENT_RUN_STATUSES,
  nimbleAgentRunIdInputSchema,
  nimbleAgentStartRunInputSchema,
} from './agent-schemas';
import type {
  NimbleAgentOutput,
  NimbleAgentEffort,
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
 * Agent tool defaults. A model-selected effort is capped at `high` by default;
 * omitting effort still preserves the selected agent/template default. The wait values apply when
 * {@link NimbleAgentRunResultConfig.wait} is enabled (it is off by default —
 * the result tool never blocks unless asked).
 */
export const NIMBLE_AGENT_DEFAULTS = {
  effortCap: 'high',
  waitTimeoutMs: 300_000,
  pollIntervalMs: 10_000,
  minPollIntervalMs: 100,
  /**
   * Retries for a run-create request. Zero: creating a run is billable and
   * non-idempotent, and the API exposes no idempotency key, so a "transient"
   * failure that actually reached the server would bill (and start) a second
   * run. Reads (status/result) keep the SDK's own retry budget.
   */
  createMaxRetries: 0,
} as const;

const EFFORT_ORDER: Record<NimbleAgentEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  'x-high': 3,
  max: 4,
};

function capEffort(effort: NimbleAgentEffort, cap: NimbleAgentEffort): NimbleAgentEffort {
  return EFFORT_ORDER[effort] > EFFORT_ORDER[cap] ? cap : effort;
}

const MAX_EFFORT_GUIDANCE =
  'Nimble Max effort is available with a custom budget. ' +
  'Contact Nimble to enable it: https://www.nimbleway.com/contact';

// Derived from the canonical const array so a drift between the type and the
// runtime guard cannot compile.
const LIFECYCLE_STATUSES: ReadonlySet<NimbleAgentRunLifecycleStatus> = new Set(
  NIMBLE_AGENT_RUN_STATUSES,
);

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
  /** Undefined when no agent is configured — the generated-agent route. */
  agentId: string | undefined;
}

function resolveAgentContext(config: NimbleAgentToolConfig, factory: string): AgentContext {
  // Empty-string env vars are "unset", not an agent named "".
  const agentId = config.agentId || process.env.NIMBLE_AGENT_ID || undefined;
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

/**
 * Resolve the agent a lifecycle (status/result) call addresses.
 *
 * The caller-supplied `{ runId, agentId }` pair is authoritative: for a
 * generated run it is the *only* way to reach the run. A configured agent id
 * is treated as a constraint, not a substitute — a pair naming a different
 * owner is rejected rather than silently redirected to the configured agent
 * (which would query a run that does not belong to it).
 */
function resolveLifecycleAgentId(
  config: NimbleAgentToolConfig,
  input: { runId: string; agentId: string },
): string {
  const configured = config.agentId || process.env.NIMBLE_AGENT_ID || undefined;
  if (configured && configured !== input.agentId) {
    throw new NimbleAgentRunError(
      `Nimble agent run ${input.runId} was addressed with agent ${input.agentId}, ` +
        `which is not the configured agent ${configured}.`,
      {
        reason: 'protocol',
        runId: input.runId,
        agentId: input.agentId,
      },
    );
  }
  return input.agentId;
}

function requestOptions(signal: AbortSignal | undefined): NimbleAgentRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

/**
 * Options for a run-create call: abort propagation plus the explicit
 * single-shot retry budget. Passed on *both* create routes, so a
 * package-constructed client (SDK default `maxRetries: 2`) and an injected
 * client alike are prevented from silently starting a second billable run.
 */
function createRequestOptions(signal: AbortSignal | undefined): NimbleAgentRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    maxRetries: NIMBLE_AGENT_DEFAULTS.createMaxRetries,
  };
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

/** A required identity field: present, a string, and non-empty. */
function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The agent that owns a freshly created run, taken from the run itself.
 *
 * `web_search_agent_id` is a required property of the create response on both
 * routes, and on the generated-agent route it names an agent the caller has
 * never seen — it is the *only* id that can address the run afterwards. A
 * response without it is therefore not merely incomplete: the run it started
 * (and billed) is unresumable, and there is nothing safe to substitute. A
 * configured agent id is not a valid stand-in — on the generated route it
 * would name the wrong agent entirely. So a missing owner is a typed protocol
 * error, exactly like a mismatched one.
 */
function runOwner(run: NimbleAgentRawRun): string {
  const owner = identity(run.web_search_agent_id);
  const runId = identity(run.id);
  if (!runId) {
    throw new NimbleAgentRunError(
      'Nimble agent run was created without a run id, so it cannot be resumed.',
      { reason: 'protocol', runStatus: run.status },
    );
  }
  if (!owner) {
    throw new NimbleAgentRunError(
      `Nimble agent run ${runId} was created without an owning agent id, so it cannot be resumed.`,
      { reason: 'protocol', runId, runStatus: run.status },
    );
  }
  return owner;
}

/**
 * Assert a run object the server sent back is exactly the run we asked about,
 * under exactly the agent we asked about.
 *
 * A payload for a different run — or for the same run under a different agent
 * — must never be accepted: its status and output would be attributed to the
 * requested run. Both ids are required by the API contract, so an absent or
 * empty one is treated the same as a wrong one: with no verifiable identity,
 * the payload cannot be shown to belong to this run, and guessing is the
 * failure mode this check exists to prevent.
 */
function assertRunIdentity(
  run: Partial<NimbleAgentRawRun>,
  ids: { runId: string; agentId: string },
): void {
  const runId = identity(run.id);
  if (runId !== ids.runId) {
    throw new NimbleAgentRunError(
      `Nimble agent run ${ids.runId} returned a payload for a different run ` +
        `(${runId ?? 'no run id'}).`,
      { reason: 'protocol', runId: ids.runId, agentId: ids.agentId },
    );
  }
  const owner = identity(run.web_search_agent_id);
  if (owner !== ids.agentId) {
    throw new NimbleAgentRunError(
      `Nimble agent run ${ids.runId} reported owner ${owner ?? 'no agent id'}, not the ` +
        `requested agent ${ids.agentId}.`,
      { reason: 'protocol', runId: ids.runId, agentId: ids.agentId },
    );
  }
}

/**
 * Identity fields are read straight off the run: every path that reaches here
 * has already proved them present and correct (runOwner / assertRunIdentity),
 * so there is no fallback left to get wrong.
 */
function baseFields(run: NimbleAgentRawRun) {
  return {
    runId: run.id,
    agentId: run.web_search_agent_id,
    effort: run.effort,
    createdAt: run.created_at,
  };
}

function toStartOutput(run: NimbleAgentRawRun): NimbleAgentStartRunOutput {
  return {
    ...baseFields(run),
    interactionId: run.interaction_id,
    status: run.status,
  };
}

function toStatusOutput(run: NimbleAgentRawRun): NimbleAgentRunStatusOutput {
  return {
    ...baseFields(run),
    status: run.status,
    isActive: run.is_active,
    ...(run.started_at ? { startedAt: run.started_at } : {}),
    ...(run.completed_at ? { completedAt: run.completed_at } : {}),
    ...(run.error?.message ? { error: { message: run.error.message } } : {}),
  };
}

function toPendingOutput(
  run: NimbleAgentRawRun,
  status: 'queued' | 'running',
): NimbleAgentRunPendingOutput {
  return {
    ready: false,
    ...baseFields(run),
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
    ...baseFields(run),
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

/**
 * A finite, positive number, or the fallback. Guards against non-finite /
 * non-positive wait values (notably `NaN` from `Number(unset env)`) — which
 * `??` would treat as "provided", leaving a `NaN` timeout that never trips the
 * `remaining <= 0` break and a `NaN` sleep that coerces to a 0ms tight poll.
 */
function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeWait(
  wait: NimbleAgentRunResultConfig['wait'],
): Required<NimbleAgentWaitOptions> | undefined {
  if (!wait) return undefined;
  const options = wait === true ? {} : wait;
  return {
    timeoutMs: positiveFinite(options.timeoutMs, NIMBLE_AGENT_DEFAULTS.waitTimeoutMs),
    pollIntervalMs: Math.max(
      positiveFinite(options.pollIntervalMs, NIMBLE_AGENT_DEFAULTS.pollIntervalMs),
      NIMBLE_AGENT_DEFAULTS.minPollIntervalMs,
    ),
  };
}

/**
 * Create a Vercel AI SDK tool that starts a Nimble deep-research agent run and
 * returns immediately with the real `task_run_…` ID and the agent that owns it.
 *
 * The agent is optional. With one configured the run goes to that instance
 * (`POST /v2/agents/{agent_id}/runs`); without one Nimble generates a minimal
 * agent for the run (`POST /v2/agents/runs`) and returns its id. Either way
 * exactly one create request is made — never retried, because creating a run
 * is billable and has no idempotency key. Effort is omitted unless the caller
 * supplies an explicit generally available override.
 *
 * The research runs asynchronously on Nimble's side (minutes) — a chat request
 * is never blocked for the run's duration. Pass the returned
 * `{ runId, agentId }` pair to {@link nimbleAgentRunStatus} /
 * {@link nimbleAgentRunResult} to collect the answer later, from the same or a
 * completely different process.
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
 *     // No agentId: Nimble generates the agent and returns its id.
 *     startResearch: nimbleAgentStartRun(),
 *     getResearchResult: nimbleAgentRunResult(),
 *   },
 * });
 * ```
 */
export function nimbleAgentStartRun(config: NimbleAgentStartRunConfig = {}) {
  return tool({
    description:
      'Start a Nimble deep-research agent run for a complex research task. ' +
      'Returns immediately with a runId and agentId while the research (which ' +
      'can take minutes) continues in the background. Pass BOTH ids to the ' +
      'run-status or run-result tool to collect the answer later — even from a ' +
      'different conversation turn or process.',
    inputSchema: nimbleAgentStartRunInputSchema,
    execute: async (input, options): Promise<NimbleAgentStartRunOutput> => {
      // A configured effort PINS the tier. Otherwise a model-selected tier is
      // clamped to the configured (or conservative default) ceiling.
      const effort = config.effort ??
        (input.effort ? capEffort(input.effort, config.effortCap ?? NIMBLE_AGENT_DEFAULTS.effortCap) : undefined);
      // Recognize the promotional tier, but stop before credentials or the
      // non-idempotent create until custom-budget access is configured.
      if (effort === 'max') {
        throw new NimbleConfigError(MAX_EFFORT_GUIDANCE);
      }
      const { client, agentId } = resolveAgentContext(config, 'nimbleAgentStartRun');
      const signal = options?.abortSignal;

      const outputSchema = input.outputSchema ?? config.outputSchema;
      const inputData = input.inputData ?? config.inputData;
      const sources = input.sources ?? config.sources;
      const skill = input.skill ?? config.skill;
      const useCase = input.useCase ?? config.useCase;
      const agentName = input.agentName ?? config.agentName;
      const body: NimbleAgentRunCreateBody = {
        input: input.task,
        ...(effort ? { effort } : {}),
        ...(outputSchema ? { output_schema: outputSchema } : {}),
        ...(inputData ? { input_data: inputData } : {}),
        ...(sources ? { sources } : {}),
        ...(skill ? { skill } : {}),
        ...(useCase ? { use_case: useCase } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
      };

      let run: NimbleAgentRawRun;
      try {
        // Exactly one create call on either route, with retries disabled.
        run = agentId
          ? await client.agents.runs.create(agentId, body, createRequestOptions(signal))
          : await client.agents.run(body, createRequestOptions(signal));
      } catch (err) {
        throw toAgentError(err, { verb: 'run creation', agentId });
      }
      // The run's own `web_search_agent_id` is the authority — for a generated
      // run it is the only id that can address it afterwards.
      const owner = runOwner(run);
      // A persistent-agent create must come back owned by the agent we asked
      // for. A different owner means the run is not the one we requested, and
      // silently adopting it would hand back a pair pointing at someone else's
      // agent — the same substitution the lifecycle tools already reject.
      if (agentId && owner !== agentId) {
        throw new NimbleAgentRunError(
          `Nimble agent run ${run.id} was created under agent ${owner}, not the ` +
            `requested agent ${agentId}.`,
          { reason: 'protocol', runId: run.id, agentId, runStatus: run.status },
        );
      }
      assertKnownStatus(run, { runId: run.id, agentId: owner });
      return toStartOutput(run);
    },
  });
}

/**
 * Create a Vercel AI SDK tool that reports the current status of a Nimble
 * agent run (`GET /v2/agents/{agent_id}/runs/{run_id}`). Instant and cheap;
 * never waits. Works for any run — including generated-agent runs and runs
 * started by another process — given the `{ runId, agentId }` pair the
 * start-run tool returned.
 */
export function nimbleAgentRunStatus(config: NimbleAgentToolConfig = {}) {
  return tool({
    description:
      'Check the current status of a Nimble deep-research agent run, given the ' +
      'runId and agentId returned when it was started (queued, running, ' +
      'completed, failed, or cancelled). Instant; never waits. Use the ' +
      'run-result tool to fetch the finished answer.',
    inputSchema: nimbleAgentRunIdInputSchema,
    execute: async (input, options): Promise<NimbleAgentRunStatusOutput> => {
      const { client } = resolveAgentContext(config, 'nimbleAgentRunStatus');
      const agentId = resolveLifecycleAgentId(config, input);
      const signal = options?.abortSignal;
      const ids = { runId: input.runId, agentId };

      let run: NimbleAgentRawRun;
      try {
        run = await client.agents.runs.get(
          input.runId,
          { agent_id: agentId },
          requestOptions(signal),
        );
      } catch (err) {
        throw toAgentError(err, { verb: 'status check', ...ids });
      }
      assertRunIdentity(run, ids);
      assertKnownStatus(run, ids);
      return toStatusOutput(run);
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
      'Fetch the result of a Nimble deep-research agent run, given the runId ' +
      'and agentId returned when it was started. If the run is still working, ' +
      'returns { ready: false } — check again later. When complete, returns ' +
      'the answer (text or structured JSON) with sources, per-claim ' +
      'citations, and confidence metadata.',
    inputSchema: nimbleAgentRunIdInputSchema,
    execute: async (input, options): Promise<NimbleAgentRunResultOutput> => {
      const { client } = resolveAgentContext(config, 'nimbleAgentRunResult');
      const agentId = resolveLifecycleAgentId(config, input);
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
      assertRunIdentity(run, ids);
      assertKnownStatus(run, ids);

      if (wait && run.is_active) {
        const startedWaiting = performance.now();
        while (run.is_active) {
          const elapsed = performance.now() - startedWaiting;
          const remaining = wait.timeoutMs - elapsed;
          if (remaining <= 0) break;
          await sleep(Math.min(wait.pollIntervalMs, remaining), signal);
          run = await getRun();
          assertRunIdentity(run, ids);
          assertKnownStatus(run, ids);
        }
      }

      if (run.status === 'queued' || run.status === 'running') {
        return toPendingOutput(run, run.status);
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
          return toPendingOutput({ ...run, status: 'running', is_active: true }, 'running');
        }
        // 422: terminal failure — the body carries the run + structured error.
        if (httpStatus === 422) {
          const failed = readFailedResultBody(err);
          if (failed) {
            // Same identity bar as the 200 paths: never report another run's
            // failure as this run's.
            assertRunIdentity(failed.run, ids);
            throw terminalFailure(failed.run, ids, failed.error.message);
          }
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
        assertRunIdentity(result.run, ids);
        throw terminalFailure(result.run, ids, result.error?.message);
      }
      // Re-validate the run object embedded in the result payload rather than
      // trusting only the earlier status snapshot: an eventually-inconsistent
      // or malformed body must not be stamped `completed` by toCompletedOutput.
      const resultRun = result.run;
      if (typeof resultRun?.status !== 'string') throw protocolError(ids);
      // …and prove the payload is for THIS run under THIS agent before its
      // answer and trust metadata are attributed to the requested run.
      assertRunIdentity(resultRun, ids);
      assertKnownStatus(resultRun, ids);
      if (resultRun.status === 'queued' || resultRun.status === 'running') {
        return toPendingOutput(resultRun, resultRun.status);
      }
      if (resultRun.status === 'failed' || resultRun.status === 'cancelled') {
        throw terminalFailure(resultRun, ids);
      }
      return toCompletedOutput(result, agentId);
    },
  });
}

/** Lifecycle statuses re-exported for convenience in host apps. */
export type { NimbleAgentRunLifecycleStatus };

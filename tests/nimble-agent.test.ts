import { inspect } from 'node:util';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  nimbleAgentStartRun,
  nimbleAgentRunStatus,
  nimbleAgentRunResult,
  NIMBLE_AGENT_DEFAULTS,
} from '../src/nimble-agent';
import {
  nimbleAgentRunIdInputSchema,
  nimbleAgentStartRunInputSchema,
} from '../src/agent-schemas';
import type {
  NimbleAgentRunCompletedOutput,
  NimbleAgentRunPendingOutput,
  NimbleAgentRunResultConfig,
  NimbleAgentRunResultOutput,
  NimbleAgentRunStatusOutput,
  NimbleAgentStartRunConfig,
  NimbleAgentStartRunOutput,
  NimbleAgentToolConfig,
} from '../src/agent-schemas';
import { NimbleAgentRunError, NimbleConfigError } from '../src/errors';
import {
  AGENT_ID,
  RUN_ID,
  completedJsonResult,
  completedRun,
  completedTextResult,
  failedResult,
  httpError,
  jsonTrust,
  rawRun,
  scriptedRunsClient,
  textTrust,
} from './agent-fixtures';

// The AI SDK passes a second options arg to execute(); a minimal stub suffices.
const execOpts = { toolCallId: 'test-call', messages: [] } as never;

function execOptsWithSignal(signal: AbortSignal) {
  return { toolCallId: 'test-call', messages: [], abortSignal: signal } as never;
}

async function runStart(
  config: NimbleAgentStartRunConfig,
  input: { task: string; effort?: 'low' | 'medium' | 'high' | 'x-high' | 'max' },
): Promise<NimbleAgentStartRunOutput> {
  const t = nimbleAgentStartRun(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, execOpts)) as NimbleAgentStartRunOutput;
}

async function runStatus(
  config: NimbleAgentToolConfig,
  input: { runId: string },
): Promise<NimbleAgentRunStatusOutput> {
  const t = nimbleAgentRunStatus(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, execOpts)) as NimbleAgentRunStatusOutput;
}

async function runResult(
  config: NimbleAgentRunResultConfig,
  input: { runId: string },
  opts: unknown = execOpts,
): Promise<NimbleAgentRunResultOutput> {
  const t = nimbleAgentRunResult(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, opts as never)) as NimbleAgentRunResultOutput;
}

describe('agent tools — construction & defaults', () => {
  it('constructs all three factories without a key or agent id', () => {
    for (const t of [nimbleAgentStartRun(), nimbleAgentRunStatus(), nimbleAgentRunResult()]) {
      expect(t).toHaveProperty('inputSchema');
      expect(typeof t.execute).toBe('function');
    }
  });

  it('exposes conservative defaults', () => {
    expect(NIMBLE_AGENT_DEFAULTS.effortCap).toBe('high');
    expect(NIMBLE_AGENT_DEFAULTS.waitTimeoutMs).toBe(300_000);
    expect(NIMBLE_AGENT_DEFAULTS.pollIntervalMs).toBe(2_000);
  });
});

describe('agent tools — model input schemas', () => {
  it('start: requires a non-empty task', () => {
    expect(nimbleAgentStartRunInputSchema.safeParse({}).success).toBe(false);
    expect(nimbleAgentStartRunInputSchema.safeParse({ task: '' }).success).toBe(false);
    expect(nimbleAgentStartRunInputSchema.safeParse({ task: 'research X' }).success).toBe(true);
  });

  it('start: validates the effort enum', () => {
    expect(
      nimbleAgentStartRunInputSchema.safeParse({ task: 't', effort: 'x-high' }).success,
    ).toBe(true);
    expect(nimbleAgentStartRunInputSchema.safeParse({ task: 't', effort: 'ultra' }).success).toBe(
      false,
    );
  });

  it('start/status/result: never expose apiKey or agentId to the model', () => {
    const startKeys = Object.keys(nimbleAgentStartRunInputSchema.shape);
    const runIdKeys = Object.keys(nimbleAgentRunIdInputSchema.shape);
    expect(startKeys).toEqual(['task', 'effort']);
    expect(runIdKeys).toEqual(['runId']);
  });

  it('status/result: require a non-empty runId', () => {
    expect(nimbleAgentRunIdInputSchema.safeParse({}).success).toBe(false);
    expect(nimbleAgentRunIdInputSchema.safeParse({ runId: '' }).success).toBe(false);
    expect(nimbleAgentRunIdInputSchema.safeParse({ runId: RUN_ID }).success).toBe(true);
  });
});

describe('nimbleAgentStartRun — request mapping', () => {
  it('creates a run with (agentId, { input: task }) and returns the real run id immediately', async () => {
    const { client, calls } = scriptedRunsClient();
    const out = await runStart({ client, agentId: AGENT_ID }, { task: 'research the EU AI Act' });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.agentId).toBe(AGENT_ID);
    expect(calls.create[0]!.body).toEqual({ input: 'research the EU AI Act' });
    expect(out.runId).toBe(RUN_ID);
    expect(out.agentId).toBe(AGENT_ID);
    expect(out.status).toBe('queued');
    expect(out.interactionId).toBe('int_0001');
    expect(out.createdAt).toBe('2026-07-22T10:00:00Z');
  });

  it('omits effort entirely when neither config nor model set one (agent default applies)', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID }, { task: 't' });
    expect('effort' in calls.create[0]!.body).toBe(false);
  });

  it('uses the configured effort when the model does not choose one', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID, effort: 'low' }, { task: 't' });
    expect(calls.create[0]!.body.effort).toBe('low');
  });

  it('passes a model-chosen effort at or below the cap', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID }, { task: 't', effort: 'high' });
    expect(calls.create[0]!.body.effort).toBe('high');
  });

  it('clamps a model-chosen effort above the default cap (high)', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID }, { task: 't', effort: 'max' });
    expect(calls.create[0]!.body.effort).toBe('high');
  });

  it('lets a developer raise the cap to allow max', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID, effortCap: 'max' }, { task: 't', effort: 'max' });
    expect(calls.create[0]!.body.effort).toBe('max');
  });

  it('does not let a model effort override a LOWER developer cap', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, agentId: AGENT_ID, effortCap: 'low' }, { task: 't', effort: 'high' });
    expect(calls.create[0]!.body.effort).toBe('low');
  });

  it('wraps a create failure with status and agent context', async () => {
    const { client } = scriptedRunsClient({ create: httpError(429, 'rate limited') });
    await expect(runStart({ client, agentId: AGENT_ID }, { task: 't' })).rejects.toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'request',
      status: 429,
      agentId: AGENT_ID,
    });
  });
});

describe('agent tools — config resolution', () => {
  let savedKey: string | undefined;
  let savedAgent: string | undefined;
  beforeEach(() => {
    savedKey = process.env.NIMBLE_API_KEY;
    savedAgent = process.env.NIMBLE_AGENT_ID;
    delete process.env.NIMBLE_API_KEY;
    delete process.env.NIMBLE_AGENT_ID;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.NIMBLE_API_KEY = savedKey;
    if (savedAgent !== undefined) process.env.NIMBLE_AGENT_ID = savedAgent;
  });

  it('throws NimbleConfigError when no agent id is resolvable', async () => {
    const { client } = scriptedRunsClient();
    await expect(runStart({ client }, { task: 't' })).rejects.toBeInstanceOf(NimbleConfigError);
  });

  it('resolves the agent id from NIMBLE_AGENT_ID', async () => {
    process.env.NIMBLE_AGENT_ID = AGENT_ID;
    const { client, calls } = scriptedRunsClient();
    await runStart({ client }, { task: 't' });
    expect(calls.create[0]!.agentId).toBe(AGENT_ID);
  });

  it('throws NimbleConfigError when no API key and no client are available', async () => {
    await expect(runStart({ agentId: AGENT_ID }, { task: 't' })).rejects.toBeInstanceOf(
      NimbleConfigError,
    );
  });

  it('needs no API key when a client is injected', async () => {
    const { client } = scriptedRunsClient();
    await expect(runStart({ client, agentId: AGENT_ID }, { task: 't' })).resolves.toBeTruthy();
  });
});

describe('nimbleAgentRunStatus', () => {
  it('maps (runId, { agent_id }) and returns the snapshot', async () => {
    const { client, calls } = scriptedRunsClient({
      gets: [rawRun({ status: 'running', started_at: '2026-07-22T10:00:05Z' })],
    });
    const out = await runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID });

    expect(calls.get[0]!.runId).toBe(RUN_ID);
    expect(calls.get[0]!.params).toEqual({ agent_id: AGENT_ID });
    expect(out).toMatchObject({
      runId: RUN_ID,
      agentId: AGENT_ID,
      status: 'running',
      isActive: true,
      effort: 'medium',
      startedAt: '2026-07-22T10:00:05Z',
    });
    expect(out.completedAt).toBeUndefined();
  });

  it('surfaces the server error message on failed runs', async () => {
    const { client } = scriptedRunsClient({
      gets: [
        rawRun({
          status: 'failed',
          is_active: false,
          error: { message: 'provider exploded', ref_id: RUN_ID },
        }),
      ],
    });
    const out = await runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID });
    expect(out.status).toBe('failed');
    expect(out.isActive).toBe(false);
    expect(out.error).toEqual({ message: 'provider exploded' });
  });

  it('throws a protocol error on an unknown status', async () => {
    const { client } = scriptedRunsClient({
      gets: [rawRun({ status: 'exploded' as never })],
    });
    await expect(runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID },
    );
  });

  it('wraps a lookup failure and keeps the runId in the message', async () => {
    const { client } = scriptedRunsClient({ gets: [httpError(404, 'run not found')] });
    const err = await runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NimbleAgentRunError);
    expect((err as NimbleAgentRunError).status).toBe(404);
    expect((err as NimbleAgentRunError).runId).toBe(RUN_ID);
    expect(String(err)).toContain(RUN_ID);
  });
});

describe('nimbleAgentRunResult — no wait (default)', () => {
  it('returns ready:false for a queued run without calling /result', async () => {
    const { client, calls } = scriptedRunsClient({ gets: [rawRun({ status: 'queued' })] });
    const out = (await runResult(
      { client, agentId: AGENT_ID },
      { runId: RUN_ID },
    )) as NimbleAgentRunPendingOutput;

    expect(out.ready).toBe(false);
    expect(out.status).toBe('queued');
    expect(out.isActive).toBe(true);
    expect(out.runId).toBe(RUN_ID);
    expect(calls.result).toHaveLength(0);
  });

  it('returns ready:false for a running run', async () => {
    const { client } = scriptedRunsClient({ gets: [rawRun({ status: 'running' })] });
    const out = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID });
    expect(out.ready).toBe(false);
  });

  it('returns the completed text answer with verbatim trust', async () => {
    const { client, calls } = scriptedRunsClient({
      gets: [completedRun()],
      result: completedTextResult(),
    });
    const out = (await runResult(
      { client, agentId: AGENT_ID },
      { runId: RUN_ID },
    )) as NimbleAgentRunCompletedOutput;

    expect(calls.result[0]!.runId).toBe(RUN_ID);
    expect(calls.result[0]!.params).toEqual({ agent_id: AGENT_ID });
    expect(out.ready).toBe(true);
    expect(out.status).toBe('completed');
    expect(out.completedAt).toBe('2026-07-22T10:02:00Z');
    expect(out.output.type).toBe('text');
    if (out.output.type !== 'text') throw new Error('expected text output');
    expect(out.output.text).toBe('Answer with a cited claim.[1]');
    // Trust passes through verbatim: sources, confidence, reasoning, and
    // callout-keyed claims with citation excerpts all preserved.
    expect(out.output.trust).toEqual(textTrust());
    expect(out.output.trust.claims[0]!.callout).toBe(1);
    expect(out.output.trust.claims[0]!.citations[0]!.excerpts).toEqual([
      'the verbatim supporting line',
    ]);
  });

  it('returns the completed JSON answer with path-keyed claims', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: completedJsonResult(),
    });
    const out = (await runResult(
      { client, agentId: AGENT_ID },
      { runId: RUN_ID },
    )) as NimbleAgentRunCompletedOutput;

    expect(out.output.type).toBe('json');
    if (out.output.type !== 'json') throw new Error('expected json output');
    expect(out.output.json).toEqual({ company: { name: 'Example Corp', founded: 2016 } });
    expect(out.output.trust).toEqual(jsonTrust());
    expect(out.output.trust.claims[0]!.path).toBe('$.company.founded');
  });

  it('throws reason:failed with the server message for a failed run', async () => {
    const { client } = scriptedRunsClient({
      gets: [
        rawRun({
          status: 'failed',
          is_active: false,
          error: { message: 'upstream provider 500', ref_id: RUN_ID },
        }),
      ],
    });
    const err = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'failed',
      runId: RUN_ID,
      runStatus: 'failed',
    });
    expect(String(err)).toContain(RUN_ID);
    expect(String(err)).toContain('upstream provider 500');
  });

  it('throws reason:cancelled for a cancelled run', async () => {
    const { client } = scriptedRunsClient({
      gets: [rawRun({ status: 'cancelled', is_active: false })],
    });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'cancelled', runId: RUN_ID, runStatus: 'cancelled' },
    );
  });

  it('maps a result-endpoint 409 (still active) to ready:false', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(409, 'run is still active'),
    });
    const out = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID });
    expect(out.ready).toBe(false);
    expect(out.status).toBe('running');
  });

  it('maps a result-endpoint 422 with a failed body to reason:failed + server message', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', failedResult('failed', 'graph blew up')),
    });
    const err = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ reason: 'failed', runId: RUN_ID });
    expect(String(err)).toContain('graph blew up');
  });

  it('maps a result-endpoint 422 with a cancelled body to reason:cancelled', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', failedResult('cancelled', 'user cancelled')),
    });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'cancelled', runId: RUN_ID },
    );
  });

  it('maps a 200 failed-shape result (no output) to a terminal failure', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: failedResult('failed', 'late failure'),
    });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'failed', runId: RUN_ID },
    );
  });

  it('throws a protocol error on a malformed output payload', async () => {
    const malformed = completedTextResult();
    (malformed.output as { content: unknown }).content = 42;
    const { client } = scriptedRunsClient({ gets: [completedRun()], result: malformed });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'protocol', runId: RUN_ID },
    );
  });

  it('maps out-of-contract result containers to protocol errors (never raw TypeErrors)', async () => {
    const cases = [
      { run: completedRun(), output: null }, // null output container
      {}, // no output, no run
      { output: { type: 'text', content: 'x', trust: textTrust() } }, // success form without run
      { run: completedRun(), output: { type: 'text', content: 'x' } }, // output missing trust
    ];
    for (const body of cases) {
      const { client } = scriptedRunsClient({
        gets: [completedRun()],
        result: body as never,
      });
      await expect(
        runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
      ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
    }

    // Body decoded to null (needs a literal client — the scripted mock's
    // `??` default would swallow a null script entry).
    const nullResultClient = {
      agents: {
        runs: {
          create: async () => rawRun(),
          get: async () => completedRun(),
          result: async () => null as never,
        },
      },
    };
    await expect(
      runResult({ client: nullResultClient, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });
});

describe('nimbleAgentRunResult — state-independent resumability', () => {
  it('a fresh factory + fresh client resolves a run it never started', async () => {
    // Process A starts the run…
    const a = scriptedRunsClient();
    const started = await runStart({ client: a.client, agentId: AGENT_ID }, { task: 't' });

    // …process B (new factory instance, new client, no shared state) resumes
    // from nothing but config agentId + the runId string.
    const b = scriptedRunsClient({ gets: [completedRun()], result: completedTextResult() });
    const out = await runResult({ client: b.client, agentId: AGENT_ID }, { runId: started.runId });

    expect(out.ready).toBe(true);
    expect(b.calls.get[0]!.runId).toBe(started.runId);
    expect(a.calls.get).toHaveLength(0); // A was never consulted again.
  });
});

describe('nimbleAgentRunResult — bounded wait', () => {
  it('polls until completion then fetches the result', async () => {
    const { client, calls } = scriptedRunsClient({
      gets: [rawRun({ status: 'queued' }), rawRun({ status: 'running' }), completedRun()],
      result: completedTextResult(),
    });
    const out = await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: 5_000, pollIntervalMs: 100 } },
      { runId: RUN_ID },
    );
    expect(out.ready).toBe(true);
    expect(calls.get.length).toBeGreaterThanOrEqual(3);
    expect(calls.result).toHaveLength(1);
  });

  it('wait:true uses the defaults shape (still completes)', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: completedTextResult(),
    });
    const out = await runResult({ client, agentId: AGENT_ID, wait: true }, { runId: RUN_ID });
    expect(out.ready).toBe(true);
  });

  it('returns ready:false at timeout while the run is still active (no throw)', async () => {
    const { client, calls } = scriptedRunsClient({ gets: [rawRun({ status: 'running' })] });
    const startedAt = performance.now();
    const out = await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: 250, pollIntervalMs: 100 } },
      { runId: RUN_ID },
    );
    const elapsed = performance.now() - startedAt;

    expect(out.ready).toBe(false);
    expect(out.status).toBe('running');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2_000);
    expect(calls.result).toHaveLength(0);
  });

  it('surfaces a transient failure mid-poll as a typed error (no hang, no swallow)', async () => {
    const { client, calls } = scriptedRunsClient({
      gets: [rawRun({ status: 'running' }), httpError(500, 'transient upstream error')],
    });
    await expect(
      runResult(
        { client, agentId: AGENT_ID, wait: { timeoutMs: 5_000, pollIntervalMs: 100 } },
        { runId: RUN_ID },
      ),
    ).rejects.toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'request',
      status: 500,
      runId: RUN_ID,
    });
    expect(calls.result).toHaveLength(0);
  });

  it('clamps tiny poll intervals (never hammers the API)', async () => {
    const { client, calls } = scriptedRunsClient({ gets: [rawRun({ status: 'running' })] });
    await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: 250, pollIntervalMs: 1 } },
      { runId: RUN_ID },
    );
    // With the 100ms floor a 250ms budget allows ~3-4 gets; without it, ~250.
    expect(calls.get.length).toBeLessThan(10);
  });

  it('aborting the AI SDK signal stops the wait and rejects with the abort reason', async () => {
    const { client, calls } = scriptedRunsClient({ gets: [rawRun({ status: 'running' })] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const startedAt = performance.now();
    const err = await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: 30_000, pollIntervalMs: 200 } },
      { runId: RUN_ID },
      execOptsWithSignal(controller.signal),
    ).catch((e: unknown) => e);
    const elapsed = performance.now() - startedAt;

    expect(String(err)).toMatch(/abort/i);
    expect(elapsed).toBeLessThan(5_000); // gave up long before the 30s budget
    // The signal is threaded into the SDK calls themselves.
    expect(calls.get[0]!.options?.signal).toBe(controller.signal);
  });

  it('threads the abort signal into create and result calls too', async () => {
    const controller = new AbortController();
    const start = scriptedRunsClient();
    const t = nimbleAgentStartRun({ client: start.client, agentId: AGENT_ID });
    await t.execute!({ task: 't' }, execOptsWithSignal(controller.signal) as never);
    expect(start.calls.create[0]!.options?.signal).toBe(controller.signal);

    const res = scriptedRunsClient({ gets: [completedRun()], result: completedTextResult() });
    await runResult(
      { client: res.client, agentId: AGENT_ID },
      { runId: RUN_ID },
      execOptsWithSignal(controller.signal),
    );
    expect(res.calls.result[0]!.options?.signal).toBe(controller.signal);
  });
});

describe('agent tools — secret hygiene (mocked layer)', () => {
  it('outputs and errors never contain the API key', async () => {
    const KEY = 'nimble-test-secret-abc123';
    // Key present in config, mock client in use — the key must never appear
    // in outputs or error text produced by this package's own mapping.
    const ok = scriptedRunsClient({ gets: [completedRun()], result: completedTextResult() });
    const out = await runResult({ client: ok.client, agentId: AGENT_ID, apiKey: KEY }, {
      runId: RUN_ID,
    });
    expect(JSON.stringify(out)).not.toContain(KEY);

    const bad = scriptedRunsClient({ gets: [httpError(500, 'internal error')] });
    const err = await runResult({ client: bad.client, agentId: AGENT_ID, apiKey: KEY }, {
      runId: RUN_ID,
    }).catch((e: unknown) => e);
    expect(String(err)).not.toContain(KEY);
    // Deep inspection covers nested properties and the whole cause chain, not
    // just the top-level error's own property names.
    expect(inspect(err, { depth: 8 })).not.toContain(KEY);
  });
});

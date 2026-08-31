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
  NIMBLE_AGENT_EFFORTS,
} from '../src/agent-schemas';
import type {
  NimbleAgentRunCompletedOutput,
  NimbleAgentRunPendingOutput,
  NimbleAgentRunResultConfig,
  NimbleAgentRunResultOutput,
  NimbleAgentRunStatusOutput,
  NimbleAgentEffort,
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
  input: {
    task: string;
    effort?: NimbleAgentEffort;
    outputSchema?: Record<string, unknown>;
    inputData?: Record<string, unknown> | Array<Record<string, unknown>>;
    sources?: Record<string, unknown>;
    skill?: string;
    useCase?: 'research' | 'enrichment' | 'dataset_building';
    agentName?: string;
  },
): Promise<NimbleAgentStartRunOutput> {
  const t = nimbleAgentStartRun(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, execOpts)) as NimbleAgentStartRunOutput;
}

async function runStatus(
  config: NimbleAgentToolConfig,
  input: { runId: string; agentId?: string },
): Promise<NimbleAgentRunStatusOutput> {
  const t = nimbleAgentRunStatus(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(
    { agentId: AGENT_ID, ...input },
    execOpts,
  )) as NimbleAgentRunStatusOutput;
}

async function runResult(
  config: NimbleAgentRunResultConfig,
  input: { runId: string; agentId?: string },
  opts: unknown = execOpts,
): Promise<NimbleAgentRunResultOutput> {
  const t = nimbleAgentRunResult(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(
    { agentId: AGENT_ID, ...input },
    opts as never,
  )) as NimbleAgentRunResultOutput;
}

describe('agent tools — construction & defaults', () => {
  it('constructs all three factories without a key or agent id', () => {
    for (const t of [nimbleAgentStartRun(), nimbleAgentRunStatus(), nimbleAgentRunResult()]) {
      expect(t).toHaveProperty('inputSchema');
      expect(typeof t.execute).toBe('function');
    }
  });

  it('exposes conservative defaults', () => {
    // C03: run creation is single-shot and model-selected effort is bounded.
    expect(NIMBLE_AGENT_DEFAULTS.effortCap).toBe('high');
    expect(NIMBLE_AGENT_DEFAULTS.createMaxRetries).toBe(0);
    expect(NIMBLE_AGENT_DEFAULTS.waitTimeoutMs).toBe(300_000);
    expect(NIMBLE_AGENT_DEFAULTS.pollIntervalMs).toBe(10_000);
  });
});

describe('agent tools — model input schemas', () => {
  it('start: requires a non-empty task', () => {
    expect(nimbleAgentStartRunInputSchema.safeParse({}).success).toBe(false);
    expect(nimbleAgentStartRunInputSchema.safeParse({ task: '' }).success).toBe(false);
    expect(nimbleAgentStartRunInputSchema.safeParse({ task: 'research X' }).success).toBe(true);
  });

  it('start: keeps max selectable while rejecting unknown tiers', () => {
    expect(NIMBLE_AGENT_EFFORTS).toEqual(['low', 'medium', 'high', 'x-high', 'max']);
    for (const tier of NIMBLE_AGENT_EFFORTS) {
      expect(nimbleAgentStartRunInputSchema.safeParse({ task: 't', effort: tier }).success).toBe(
        true,
      );
    }
    for (const tier of ['ultra']) {
      expect(nimbleAgentStartRunInputSchema.safeParse({ task: 't', effort: tier }).success).toBe(
        false,
      );
    }
  });

  // C07 / C08 / C09: the published structured controls are model-reachable.
  it('start: accepts outputSchema, inputData (object or list), and sources', () => {
    const outputSchema = { type: 'object', properties: { name: { type: 'string' } } };
    expect(
      nimbleAgentStartRunInputSchema.safeParse({
        task: 't',
        outputSchema,
        inputData: { domain: 'example.com' },
        sources: {
          allow: [{ title: 'Regulators', domains: ['europa.eu'] }],
          block: [{ title: 'Forums', domains: ['reddit.com'], order: 0 }],
          prioritize: 'official filings',
          avoid: 'press releases',
        },
      }).success,
    ).toBe(true);
    expect(
      nimbleAgentStartRunInputSchema.safeParse({
        task: 't',
        inputData: [{ domain: 'a.com' }, { domain: 'b.com' }],
      }).success,
    ).toBe(true);
    // A source group without domains is not usable guidance.
    expect(
      nimbleAgentStartRunInputSchema.safeParse({
        task: 't',
        sources: { allow: [{ title: 'Empty', domains: [] }] },
      }).success,
    ).toBe(false);
  });

  it('start/status/result: never expose apiKey to the model', () => {
    const startKeys = Object.keys(nimbleAgentStartRunInputSchema.shape);
    const runIdKeys = Object.keys(nimbleAgentRunIdInputSchema.shape);
    expect(startKeys).toEqual([
      'task',
      'effort',
      'outputSchema',
      'inputData',
      'sources',
      'skill',
      'useCase',
      'agentName',
    ]);
    // The agent id is model-facing on the lifecycle tools by design: it is the
    // handle the start tool returned, and the only way to reach a generated run.
    expect(runIdKeys).toEqual(['runId', 'agentId']);
    for (const keys of [startKeys, runIdKeys]) {
      expect(keys).not.toContain('apiKey');
    }
  });

  // C05: both halves of the pair are required to address a run.
  it('status/result: require a non-empty runId AND agentId', () => {
    expect(nimbleAgentRunIdInputSchema.safeParse({}).success).toBe(false);
    expect(nimbleAgentRunIdInputSchema.safeParse({ runId: '', agentId: AGENT_ID }).success).toBe(
      false,
    );
    expect(nimbleAgentRunIdInputSchema.safeParse({ runId: RUN_ID }).success).toBe(false);
    expect(nimbleAgentRunIdInputSchema.safeParse({ runId: RUN_ID, agentId: '' }).success).toBe(
      false,
    );
    expect(
      nimbleAgentRunIdInputSchema.safeParse({ runId: RUN_ID, agentId: AGENT_ID }).success,
    ).toBe(true);
  });
});

describe('nimbleAgentStartRun — request mapping', () => {
  // C02: an agent is configured → exactly one persistent-agent create.
  it('creates a run with (agentId, body) and returns the run + agent pair immediately', async () => {
    const { client, calls } = scriptedRunsClient();
    const out = await runStart({ client, agentId: AGENT_ID }, { task: 'research the EU AI Act' });

    expect(calls.create).toHaveLength(1);
    expect(calls.run).toHaveLength(0);
    expect(calls.create[0]!.agentId).toBe(AGENT_ID);
    expect(calls.create[0]!.body).toEqual({ input: 'research the EU AI Act' });
    expect(out.runId).toBe(RUN_ID);
    expect(out.agentId).toBe(AGENT_ID);
    expect(out.status).toBe('queued');
    expect(out.interactionId).toBe('int_0001');
    expect(out.createdAt).toBe('2026-07-22T10:00:00Z');
  });

  // C01: no agent configured → exactly one generated-agent create.
  it('routes to the generated-agent create when no agent id is configured', async () => {
    const generatedAgent = 'wsa_generated-0000-4000-8000-000000000009';
    const { client, calls } = scriptedRunsClient({
      run: rawRun({ web_search_agent_id: generatedAgent }),
    });
    const out = await runStart({ client }, { task: 'research the EU AI Act' });

    expect(calls.run).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
    expect(calls.run[0]!.body).toEqual({ input: 'research the EU AI Act' });
    // C05: the RETURNED agent identity is what comes back, not a configured one.
    expect(out.agentId).toBe(generatedAgent);
    expect(out.runId).toBe(RUN_ID);
  });

  it('fails with a protocol error when a generated run comes back without an owner', async () => {
    const { client } = scriptedRunsClient({ run: rawRun({ web_search_agent_id: '' }) });
    await expect(runStart({ client }, { task: 't' })).rejects.toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'protocol',
      runId: RUN_ID,
    });
  });

  it('omits unspecified effort and caps model-selected effort on both routes', async () => {
    const persistent = scriptedRunsClient();
    await runStart({ client: persistent.client, agentId: AGENT_ID }, { task: 't' });
    expect(persistent.calls.create[0]!.body).not.toHaveProperty('effort');

    const explicit = scriptedRunsClient();
    await runStart({ client: explicit.client, agentId: AGENT_ID }, { task: 't', effort: 'x-high' });
    expect(explicit.calls.create[0]!.body.effort).toBe('high');

    const generated = scriptedRunsClient();
    await runStart({ client: generated.client }, { task: 't' });
    expect(generated.calls.run[0]!.body).not.toHaveProperty('effort');
  });

  it('honors an explicit effort cap while preserving lower model choices', async () => {
    const capped = scriptedRunsClient();
    await runStart(
      { client: capped.client, agentId: AGENT_ID, effortCap: 'x-high' },
      { task: 't', effort: 'x-high' },
    );
    expect(capped.calls.create[0]!.body.effort).toBe('x-high');

    const lower = scriptedRunsClient();
    await runStart({ client: lower.client }, { task: 't', effort: 'low' });
    expect(lower.calls.run[0]!.body.effort).toBe('low');
  });

  it('blocks a model max choice only when the configured cap permits it', async () => {
    const gated = scriptedRunsClient();
    await expect(
      runStart({ client: gated.client, effortCap: 'max' }, { task: 't', effort: 'max' }),
    ).rejects.toThrow(/custom budget.*https:\/\/www\.nimbleway\.com\/contact/i);
    expect(gated.calls.run).toHaveLength(0);
    expect(gated.calls.create).toHaveLength(0);
  });

  // C03: create is single-shot — retries disabled per request on both routes.
  it('disables SDK retries on both create routes', async () => {
    const persistent = scriptedRunsClient();
    await runStart({ client: persistent.client, agentId: AGENT_ID }, { task: 't' });
    expect(persistent.calls.create[0]!.options?.maxRetries).toBe(0);

    const generated = scriptedRunsClient();
    await runStart({ client: generated.client }, { task: 't' });
    expect(generated.calls.run[0]!.options?.maxRetries).toBe(0);
  });

  // C03: a failed create is never re-attempted by this package, on any route.
  it.each([
    ['transport failure', new Error('socket hang up')],
    ['408', httpError(408, 'request timeout')],
    ['409', httpError(409, 'conflict')],
    ['429', httpError(429, 'rate limited')],
    ['500', httpError(500, 'internal error')],
    ['503', httpError(503, 'unavailable')],
  ])('makes exactly one create attempt on %s', async (_label, failure) => {
    const persistent = scriptedRunsClient({ create: failure });
    await expect(
      runStart({ client: persistent.client, agentId: AGENT_ID }, { task: 't' }),
    ).rejects.toBeInstanceOf(NimbleAgentRunError);
    expect(persistent.calls.create).toHaveLength(1);

    const generated = scriptedRunsClient({ run: failure });
    await expect(runStart({ client: generated.client }, { task: 't' })).rejects.toBeInstanceOf(
      NimbleAgentRunError,
    );
    expect(generated.calls.run).toHaveLength(1);
    expect(generated.calls.create).toHaveLength(0);
  });

  // C07 / C08 / C09: structured controls pass through unchanged on both routes.
  it('passes model-supplied outputSchema, inputData, and sources through unchanged', async () => {
    const outputSchema = { type: 'object', properties: { revenue: { type: 'number' } } };
    const inputData = [{ domain: 'a.com' }, { domain: 'b.com' }];
    const sources = {
      allow: [{ title: 'Regulators', domains: ['sec.gov', 'europa.eu'] }],
      prioritize: 'official filings',
    };

    const persistent = scriptedRunsClient();
    await runStart(
      { client: persistent.client, agentId: AGENT_ID },
      { task: 'enrich these', outputSchema, inputData, sources },
    );
    expect(persistent.calls.create[0]!.body).toEqual({
      input: 'enrich these',
      output_schema: outputSchema,
      input_data: inputData,
      sources,
    });

    const generated = scriptedRunsClient();
    await runStart(
      { client: generated.client },
      { task: 'enrich these', outputSchema, inputData, sources },
    );
    expect(generated.calls.run[0]!.body).toEqual({
      input: 'enrich these',
      output_schema: outputSchema,
      input_data: inputData,
      sources,
    });
  });

  it('falls back to developer-configured structured controls, and the model overrides them', async () => {
    const configured = { type: 'object', properties: { a: { type: 'string' } } };
    const chosen = { type: 'object', properties: { b: { type: 'string' } } };

    const fallback = scriptedRunsClient();
    await runStart(
      { client: fallback.client, agentId: AGENT_ID, outputSchema: configured, sources: { avoid: 'blogs' } },
      { task: 't' },
    );
    expect(fallback.calls.create[0]!.body.output_schema).toEqual(configured);
    expect(fallback.calls.create[0]!.body.sources).toEqual({ avoid: 'blogs' });

    const override = scriptedRunsClient();
    await runStart(
      { client: override.client, agentId: AGENT_ID, outputSchema: configured },
      { task: 't', outputSchema: chosen },
    );
    expect(override.calls.create[0]!.body.output_schema).toEqual(chosen);
  });

  it('forwards typed skill, use_case, and agent_name on both create routes', async () => {
    const persistent = scriptedRunsClient();
    await runStart(
      { client: persistent.client, agentId: AGENT_ID },
      {
        task: 't',
        outputSchema: { type: 'object' },
        sources: { avoid: 'blogs' },
        skill: 'Prefer official filings',
        useCase: 'research',
        agentName: 'filings-researcher',
      },
    );
    const generated = scriptedRunsClient();
    await runStart(
      { client: generated.client },
      {
        task: 't',
        skill: 'Build a normalized dataset',
        useCase: 'dataset_building',
        agentName: 'dataset-builder',
      },
    );

    expect(persistent.calls.create[0]!.body).toMatchObject({
      skill: 'Prefer official filings',
      use_case: 'research',
      agent_name: 'filings-researcher',
    });
    expect(generated.calls.run[0]!.body).toMatchObject({
      skill: 'Build a normalized dataset',
      use_case: 'dataset_building',
      agent_name: 'dataset-builder',
    });
  });

  // Serialization contract: camelCase model/config fields map to the SDK's
  // snake_case wire names, exactly once each, with nothing extra added.
  it('serializes the full control set to snake_case wire fields on both routes', async () => {
    const outputSchema = { type: 'object', properties: { hq: { type: 'string' } } };
    const inputData = [{ domain: 'a.com' }];
    const sources = { prioritize: 'official filings' };
    const input = {
      task: 'enrich these',
      effort: 'medium' as const,
      outputSchema,
      inputData,
      sources,
      skill: 'Prefer primary sources',
      useCase: 'enrichment' as const,
      agentName: 'enricher',
    };
    const expected = {
      input: 'enrich these',
      effort: 'medium',
      output_schema: outputSchema,
      input_data: inputData,
      sources,
      skill: 'Prefer primary sources',
      use_case: 'enrichment',
      agent_name: 'enricher',
    };

    const persistent = scriptedRunsClient();
    await runStart({ client: persistent.client, agentId: AGENT_ID }, input);
    const generated = scriptedRunsClient();
    await runStart({ client: generated.client }, input);

    for (const body of [persistent.calls.create[0]!.body, generated.calls.run[0]!.body]) {
      // Exact equality, so a stray camelCase key or an unpublished extra_body
      // style field fails instead of slipping through a subset match.
      expect(body).toEqual(expected);
      // The camelCase names must never reach the wire.
      for (const camel of ['outputSchema', 'inputData', 'useCase', 'agentName']) {
        expect(body).not.toHaveProperty(camel);
      }
    }
  });

  it('falls back to developer-configured skill, useCase, and agentName', async () => {
    const configured = scriptedRunsClient();
    await runStart(
      {
        client: configured.client,
        skill: 'Configured skill',
        useCase: 'research',
        agentName: 'configured-agent',
      },
      { task: 't' },
    );
    expect(configured.calls.run[0]!.body).toMatchObject({
      skill: 'Configured skill',
      use_case: 'research',
      agent_name: 'configured-agent',
    });

    // A model-supplied value wins over the configured default.
    const overridden = scriptedRunsClient();
    await runStart(
      { client: overridden.client, agentName: 'configured-agent' },
      { task: 't', agentName: 'model-agent' },
    );
    expect(overridden.calls.run[0]!.body.agent_name).toBe('model-agent');
  });

  // Identity: a persistent create must come back owned by the agent we asked
  // for; adopting a different owner would return a pair pointing elsewhere.
  it('rejects a persistent create returned under a different agent', async () => {
    const OTHER = 'wsa_deadbeef-0000-4000-8000-00000000ffff';
    const { client } = scriptedRunsClient({ create: rawRun({ web_search_agent_id: OTHER }) });
    await expect(runStart({ client, agentId: AGENT_ID }, { task: 't' })).rejects.toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'protocol',
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
  });

  it('accepts a persistent create returned under the requested agent', async () => {
    const { client } = scriptedRunsClient({ create: rawRun({ web_search_agent_id: AGENT_ID }) });
    const out = await runStart({ client, agentId: AGENT_ID }, { task: 't' });
    expect(out.agentId).toBe(AGENT_ID);
  });

  // The generated route has no requested agent to compare against, so any
  // non-empty owner the server names is legitimate.
  it('accepts any owner the server names on the generated route', async () => {
    const generatedAgent = 'wsa_generated-0000-4000-8000-000000000009';
    const { client } = scriptedRunsClient({
      run: rawRun({ web_search_agent_id: generatedAgent }),
    });
    const out = await runStart({ client }, { task: 't' });
    expect(out.agentId).toBe(generatedAgent);
  });

  // Cost bound: a configured effort PINS the tier and beats the model.
  it('pins a configured effort over the model choice on both routes', async () => {
    const persistent = scriptedRunsClient();
    await runStart(
      { client: persistent.client, agentId: AGENT_ID, effort: 'low' },
      { task: 't', effort: 'x-high' },
    );
    expect(persistent.calls.create[0]!.body.effort).toBe('low');

    const generated = scriptedRunsClient();
    await runStart({ client: generated.client, effort: 'low' }, { task: 't', effort: 'high' });
    expect(generated.calls.run[0]!.body.effort).toBe('low');
  });

  it('pins a configured effort even when the model omits one', async () => {
    const { client, calls } = scriptedRunsClient();
    await runStart({ client, effort: 'low' }, { task: 't' });
    expect(calls.run[0]!.body.effort).toBe('low');
  });

  it('gates a configured max pin before any create request', async () => {
    const gated = scriptedRunsClient();
    await expect(
      runStart({ client: gated.client, effort: 'max' }, { task: 't' }),
    ).rejects.toThrow(/custom budget/i);
    expect(gated.calls.create).toHaveLength(0);
    expect(gated.calls.run).toHaveLength(0);
  });

  it('rejects a raw model max request with custom-budget guidance under the default cap', async () => {
    const gated = scriptedRunsClient();
    await expect(runStart({ client: gated.client }, { task: 't', effort: 'max' })).rejects.toThrow(
      /custom budget.*https:\/\/www\.nimbleway\.com\/contact/i,
    );
    expect(gated.calls.run).toHaveLength(0);
    expect(gated.calls.create).toHaveLength(0);
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
    // Restore-or-remove: a plain `if (saved !== undefined)` leaks a var this
    // block SET into every later test in the file (it did — the identity
    // suites then saw a "configured" agent that no test configured).
    if (savedKey !== undefined) process.env.NIMBLE_API_KEY = savedKey;
    else delete process.env.NIMBLE_API_KEY;
    if (savedAgent !== undefined) process.env.NIMBLE_AGENT_ID = savedAgent;
    else delete process.env.NIMBLE_AGENT_ID;
  });

  it('needs no agent id at all — an unconfigured start uses the generated route', async () => {
    const { client, calls } = scriptedRunsClient();
    await expect(runStart({ client }, { task: 't' })).resolves.toBeTruthy();
    expect(calls.run).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
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
      effort: 'low',
      startedAt: '2026-07-22T10:00:05Z',
    });
    expect(out.completedAt).toBeUndefined();
  });

  // We only ever request `low`, but an agent instance configured elsewhere can
  // report a higher tier — reading a run must not choke on it.
  it('reports a higher server-side effort tier verbatim', async () => {
    const { client } = scriptedRunsClient({ gets: [rawRun({ effort: 'x-high' })] });
    const out = await runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID });
    expect(out.effort).toBe('x-high');
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

  it('maps a 422 whose failure form is wrapped in the detail envelope (failed)', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', {
        detail: failedResult('failed', 'graph blew up (detail-wrapped)'),
      }),
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
    expect(String(err)).toContain('graph blew up (detail-wrapped)');
  });

  it('maps a 422 whose failure form is wrapped in the detail envelope (cancelled)', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', {
        detail: failedResult('cancelled', 'cancelled upstream (detail-wrapped)'),
      }),
    });
    const err = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ reason: 'cancelled', runId: RUN_ID, runStatus: 'cancelled' });
    expect(String(err)).toContain('cancelled upstream (detail-wrapped)');
  });

  it('keeps a 422 validation-error envelope (detail: array) on the generic request path', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'validation error', {
        detail: [{ loc: ['path', 'run_id'], msg: 'value is not a valid uuid', type: 'value_error' }],
      }),
    });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'request', status: 422, runId: RUN_ID },
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

  it('re-validates the result payload run: an embedded running status maps to pending, not completed', async () => {
    // Status GET said completed (so we fetch /result), but the result payload's
    // own run says running — trust the payload, do not stamp completed.
    const inconsistent = completedTextResult();
    inconsistent.run = rawRun({ status: 'running', is_active: true });
    const { client } = scriptedRunsClient({ gets: [completedRun()], result: inconsistent });
    const out = await runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID });
    expect(out.ready).toBe(false);
    expect(out.status).toBe('running');
  });

  it('re-validates the result payload run: an embedded failed status throws terminal, not completed', async () => {
    const inconsistent = completedTextResult();
    inconsistent.run = rawRun({
      status: 'failed',
      is_active: false,
      error: { message: 'result-embedded failure', ref_id: RUN_ID },
    });
    const { client } = scriptedRunsClient({ gets: [completedRun()], result: inconsistent });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { name: 'NimbleAgentRunError', reason: 'failed', runId: RUN_ID },
    );
  });

  it('re-validates the result payload run: an unknown embedded status is a protocol error', async () => {
    const inconsistent = completedTextResult();
    inconsistent.run = rawRun({ status: 'exploded' as never });
    const { client } = scriptedRunsClient({ gets: [completedRun()], result: inconsistent });
    await expect(runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID })).rejects.toMatchObject(
      { reason: 'protocol', runId: RUN_ID },
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
        run: async () => rawRun(),
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
    // from nothing but the { runId, agentId } pair A returned.
    const b = scriptedRunsClient({ gets: [completedRun()], result: completedTextResult() });
    const out = await runResult(
      { client: b.client },
      { runId: started.runId, agentId: started.agentId },
    );

    expect(out.ready).toBe(true);
    expect(b.calls.get[0]!.runId).toBe(started.runId);
    expect(a.calls.get).toHaveLength(0); // A was never consulted again.
  });

  // C05: a generated run is resumable with no configuration whatsoever.
  it('resumes a GENERATED run using only the returned pair (no configured agent)', async () => {
    const generatedAgent = 'wsa_generated-0000-4000-8000-000000000009';
    const generatedRun = rawRun({ web_search_agent_id: generatedAgent });
    const a = scriptedRunsClient({ run: generatedRun });
    const started = await runStart({ client: a.client }, { task: 't' });
    expect(started.agentId).toBe(generatedAgent);

    const b = scriptedRunsClient({
      gets: [completedRun({ web_search_agent_id: generatedAgent })],
      result: {
        run: completedRun({ web_search_agent_id: generatedAgent }),
        output: { type: 'text', content: 'done [1]', trust: textTrust() },
      },
    });
    const out = await runResult(
      { client: b.client },
      { runId: started.runId, agentId: started.agentId },
    );

    // The RETURNED agent id — not a configured fallback — addressed both calls.
    expect(b.calls.get[0]!.params).toEqual({ agent_id: generatedAgent });
    expect(b.calls.result[0]!.params).toEqual({ agent_id: generatedAgent });
    expect(out.ready).toBe(true);
    expect(out.agentId).toBe(generatedAgent);
  });
});

// C06: identity consistency — never silently substitute or accept a foreign owner.
describe('agent lifecycle — run/agent identity guards', () => {
  const OTHER_AGENT = 'wsa_deadbeef-0000-4000-8000-00000000ffff';
  const OTHER_RUN = 'task_run_99999999-2222-4333-8444-555555555555';

  it('rejects a pair naming a different agent than the configured one', async () => {
    for (const call of [
      () => runStatus({ client: scriptedRunsClient().client, agentId: AGENT_ID }, { runId: RUN_ID, agentId: OTHER_AGENT }),
      () => runResult({ client: scriptedRunsClient().client, agentId: AGENT_ID }, { runId: RUN_ID, agentId: OTHER_AGENT }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: 'NimbleAgentRunError',
        reason: 'protocol',
        runId: RUN_ID,
        agentId: OTHER_AGENT,
      });
    }
  });

  it('never queries the API when the configured/requested agents disagree', async () => {
    const { client, calls } = scriptedRunsClient();
    await expect(
      runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID, agentId: OTHER_AGENT }),
    ).rejects.toBeInstanceOf(NimbleAgentRunError);
    expect(calls.get).toHaveLength(0);
  });

  it('accepts a pair with no configured agent (generated-run case)', async () => {
    const { client, calls } = scriptedRunsClient({
      gets: [rawRun({ web_search_agent_id: OTHER_AGENT })],
    });
    const out = await runStatus({ client }, { runId: RUN_ID, agentId: OTHER_AGENT });
    expect(calls.get[0]!.params).toEqual({ agent_id: OTHER_AGENT });
    expect(out.agentId).toBe(OTHER_AGENT);
  });

  it('rejects a status payload for a different run', async () => {
    const { client } = scriptedRunsClient({ gets: [rawRun({ id: OTHER_RUN })] });
    await expect(
      runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a status payload owned by a different agent', async () => {
    const { client } = scriptedRunsClient({ gets: [rawRun({ web_search_agent_id: OTHER_AGENT })] });
    await expect(
      runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  // The Qodo finding: the RESULT payload's embedded run must be re-checked.
  it('rejects a completed result whose embedded run.id is a different run', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: {
        run: completedRun({ id: OTHER_RUN }),
        output: { type: 'text', content: 'someone else answer [1]', trust: textTrust() },
      },
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a completed result whose embedded run belongs to a different agent', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: {
        run: completedRun({ web_search_agent_id: OTHER_AGENT }),
        output: { type: 'text', content: 'someone else answer [1]', trust: textTrust() },
      },
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a FAILED-form result payload for a different run', async () => {
    const foreign = failedResult();
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: { ...foreign, run: { ...foreign.run, id: OTHER_RUN } },
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a 422 failure envelope describing a different run', async () => {
    const foreign = failedResult();
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', {
        ...foreign,
        run: { ...foreign.run, id: OTHER_RUN },
      }),
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a poll response that switches to a different run mid-wait', async () => {
    const { client } = scriptedRunsClient({
      gets: [rawRun({ status: 'running' }), rawRun({ id: OTHER_RUN, status: 'running' })],
    });
    await expect(
      runResult(
        { client, agentId: AGENT_ID, wait: { timeoutMs: 500, pollIntervalMs: 100 } },
        { runId: RUN_ID },
      ),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  // Missing identity is as unsafe as wrong identity: with no verifiable owner
  // the payload cannot be shown to belong to this run, and the configured id
  // is not a valid stand-in (on a generated run it names a different agent).
  const missingOwner = [
    ['empty', ''],
    ['absent', undefined],
  ] as const;

  it.each(missingOwner)('rejects a status payload with an %s owner', async (_label, owner) => {
    const { client } = scriptedRunsClient({
      gets: [rawRun({ web_search_agent_id: owner as string })],
    });
    await expect(
      runStatus({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it.each(missingOwner)('rejects a completed result with an %s owner', async (_label, owner) => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: {
        run: completedRun({ web_search_agent_id: owner as string }),
        output: { type: 'text', content: 'answer [1]', trust: textTrust() },
      },
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it.each(missingOwner)('rejects a 422 failure envelope with an %s owner', async (_label, owner) => {
    const foreign = failedResult();
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: httpError(422, 'unprocessable', {
        ...foreign,
        run: { ...foreign.run, web_search_agent_id: owner as string },
      }),
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  it('rejects a result payload with a missing run id', async () => {
    const { client } = scriptedRunsClient({
      gets: [completedRun()],
      result: {
        run: completedRun({ id: undefined as unknown as string }),
        output: { type: 'text', content: 'answer [1]', trust: textTrust() },
      },
    });
    await expect(
      runResult({ client, agentId: AGENT_ID }, { runId: RUN_ID }),
    ).rejects.toMatchObject({ name: 'NimbleAgentRunError', reason: 'protocol', runId: RUN_ID });
  });

  // C05: a create response with no owner started (and billed) an unresumable
  // run — on BOTH routes. The configured agent must not paper over it.
  it.each(missingOwner)(
    'rejects a generated-route create whose response has an %s owner',
    async (_label, owner) => {
      const { client } = scriptedRunsClient({
        run: rawRun({ web_search_agent_id: owner as string }),
      });
      await expect(runStart({ client }, { task: 't' })).rejects.toMatchObject({
        name: 'NimbleAgentRunError',
        reason: 'protocol',
        runId: RUN_ID,
      });
    },
  );

  it.each(missingOwner)(
    'rejects a persistent-route create whose response has an %s owner',
    async (_label, owner) => {
      const { client } = scriptedRunsClient({
        create: rawRun({ web_search_agent_id: owner as string }),
      });
      await expect(runStart({ client, agentId: AGENT_ID }, { task: 't' })).rejects.toMatchObject({
        name: 'NimbleAgentRunError',
        reason: 'protocol',
        runId: RUN_ID,
      });
    },
  );

  it('rejects a create response with no run id', async () => {
    const { client } = scriptedRunsClient({
      create: rawRun({ id: undefined as unknown as string }),
    });
    await expect(runStart({ client, agentId: AGENT_ID }, { task: 't' })).rejects.toMatchObject({
      name: 'NimbleAgentRunError',
      reason: 'protocol',
    });
  });
});

describe('nimbleAgentRunResult — bounded wait', () => {
  // Short poll intervals in this block are test-only overrides that keep the
  // suite fast; production/runtime callers inherit the 10-second default.
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

  it('coerces a NaN poll interval to a bounded value (no 0ms spin)', async () => {
    // NaN is a common Number(unset-env) result; `??` would treat it as provided.
    const { client, calls } = scriptedRunsClient({ gets: [rawRun({ status: 'running' })] });
    const startedAt = performance.now();
    const out = await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: 400, pollIntervalMs: NaN } },
      { runId: RUN_ID },
    );
    const elapsed = performance.now() - startedAt;

    expect(out.ready).toBe(false);
    // With the bug, sleep(NaN)→0ms would fire hundreds of polls inside 400ms.
    expect(calls.get.length).toBeLessThan(6);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('coerces a NaN timeout to the finite default (loop still terminates)', async () => {
    const { client } = scriptedRunsClient({
      gets: [rawRun({ status: 'running' }), completedRun()],
      result: completedTextResult(),
    });
    const startedAt = performance.now();
    const out = await runResult(
      { client, agentId: AGENT_ID, wait: { timeoutMs: NaN, pollIntervalMs: 50 } },
      { runId: RUN_ID },
    );
    // A NaN timeout must not wedge the loop; it completes on the next poll.
    expect(out.ready).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
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

import { describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS, RESULT_TIMEOUT_MS, buildAgentTools } from '../lib/agent-tools';
import { SAMPLE_QUERIES } from '../lib/sample-queries';
import {
  GATEWAY_HEADER,
  isGatewayAuthorized,
  signGatewayAssertion,
} from '../lib/gateway-auth';
import {
  actualResultFromToolOutput,
  classifyTrust,
  inspectableEvidence,
  trustFromToolOutput,
} from '../lib/presentation';
import { POST } from '../app/api/chat/route';
import { csrfTokenFromCookie } from '../lib/browser-auth';
import {
  CREATE_DIAGNOSTIC_SCHEMA,
  type CreateDiagnosticEvent,
  type CreateDiagnosticReporter,
} from '../lib/create-diagnostics';
import { newChatRequestId } from '../lib/request-id';

const GENERATED_AGENT_CREATE_URL =
  'https://sdk.nimbleway.com/v2/agents/runs';
const CONFIGURED_AGENT_ID =
  'wsa_22222222-2222-4222-8222-222222222222';
const CONFIGURED_AGENT_CREATE_URL =
  `https://sdk.nimbleway.com/v2/agents/${CONFIGURED_AGENT_ID}/runs`;

describe('model chat Agent V2 policy', () => {
  it('exposes exactly the start/status/result lifecycle', () => {
    expect(Object.keys(buildAgentTools('nimble_test_key'))).toEqual([
      'startResearch',
      'checkResearch',
      'getResearchResult',
    ]);
  });

  it('ships only 90+ decision-led query contracts', () => {
    expect(SAMPLE_QUERIES).toHaveLength(3);
    for (const sample of SAMPLE_QUERIES) {
      expect(sample.score).toBeGreaterThanOrEqual(90);
      expect(sample.prompt).toMatch(/Decision:/);
      expect(sample.prompt).toMatch(/Source hierarchy:/);
      expect(sample.prompt).toMatch(/Return (JSON|the original keys)/);
      expect(sample.prompt).toMatch(/Preserve (disagreements|conflicting evidence|contradictions)/);
      expect(sample.prompt).toMatch(/Stop (after|at)/);
    }
  });

  it('prevents the generic prompt regressions identified in review', () => {
    const catalogue = SAMPLE_QUERIES.map((sample) => sample.prompt).join('\n').toLowerCase();
    expect(catalogue).not.toContain('latest python');
    expect(catalogue).not.toContain('company profile');
    expect(catalogue).not.toContain('nvidia');
  });

  it('uses the production 10-second polling convention and bounded wait', () => {
    expect(POLL_INTERVAL_MS).toBe(10_000);
    expect(RESULT_TIMEOUT_MS).toBe(300_000);
  });

  it('pins low, leaves agentId absent, and shares only the request-scoped key', () => {
    const start = vi.fn(() => ({ execute: vi.fn() }));
    const status = vi.fn(() => ({ execute: vi.fn() }));
    const result = vi.fn(() => ({ execute: vi.fn() }));

    buildAgentTools('nimble_request_key', { start, status, result } as never);

    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({
      apiKey: 'nimble_request_key',
      effort: 'low',
    });
    expect(status).toHaveBeenCalledWith({ apiKey: 'nimble_request_key' });
    expect(result).toHaveBeenCalledWith({
      apiKey: 'nimble_request_key',
      wait: { pollIntervalMs: 10_000, timeoutMs: 300_000 },
    });
  });

  it('atomically deduplicates parallel starts and binds lifecycle IDs', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const startExecute = vi.fn(() => pending);
    const statusExecute = vi.fn(async () => ({ status: 'running' }));
    const resultExecute = vi.fn(async () => ({ ready: false }));
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: statusExecute })),
      result: vi.fn(() => ({ execute: resultExecute })),
    } as never) as unknown as Record<string, Executable>;

    const first = tools.startResearch.execute({ task: 'one' }, {});
    const second = tools.startResearch.execute({ task: 'duplicate' }, {});
    expect(startExecute).toHaveBeenCalledOnce();
    release({ runId: 'task_run_one', agentId: 'wsa_one' });
    await expect(first).resolves.toMatchObject({ runId: 'task_run_one' });
    await expect(second).resolves.toMatchObject({ runId: 'task_run_one' });

    await expect(
      tools.checkResearch.execute({ runId: 'task_run_other', agentId: 'wsa_one' }, {}),
    ).rejects.toThrow(/must match/);
    expect(statusExecute).not.toHaveBeenCalled();
    await tools.checkResearch.execute({ runId: 'task_run_one', agentId: 'wsa_one' }, {});
    expect(statusExecute).toHaveBeenCalledOnce();
  });

  it('rejects malformed outputSchema before consuming the create slot', async () => {
    const startExecute = vi.fn(async () => ({
      runId: 'task_run_one',
      agentId: 'wsa_one',
    }));
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;

    await expect(
      tools.startResearch.execute(
        { task: 'one', outputSchema: { company: 'string' } },
        {},
      ),
    ).rejects.toThrow(/rejected before any Agent API request/);
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('allows one corrected schema after a local rejection', async () => {
    const created = { runId: 'task_run_one', agentId: 'wsa_one' };
    const startExecute = vi.fn(async () => created);
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;

    await expect(
      tools.startResearch.execute(
        { task: 'one', outputSchema: { company: 'string' } },
        {},
      ),
    ).rejects.toThrow(/before any Agent API request/);

    const corrected = tools.startResearch.execute(
      {
        task: 'one',
        outputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              recommended_rank: { type: ['number', 'null'] },
            },
            required: ['company', 'recommended_rank'],
            additionalProperties: false,
          },
        },
      },
      {},
    );
    await expect(corrected).resolves.toEqual(created);
    await expect(
      tools.startResearch.execute({ task: 'duplicate' }, {}),
    ).resolves.toEqual(created);
    expect(startExecute).toHaveBeenCalledOnce();
    expect(startExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: expect.objectContaining({ type: 'array' }),
      }),
      {},
    );
  });

  it('memoizes a post-validation create rejection', async () => {
    const createError = new Error('ambiguous transport failure');
    const startExecute = vi.fn(async () => {
      throw createError;
    });
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;
    const validInput = {
      task: 'one',
      outputSchema: {
        type: 'object',
        properties: { company: { type: 'string' } },
      },
    };

    const first = tools.startResearch.execute(validInput, {});
    await expect(first).rejects.toBe(createError);
    const second = tools.startResearch.execute(validInput, {});
    expect(second).toBe(first);
    await expect(second).rejects.toBe(createError);
    expect(startExecute).toHaveBeenCalledOnce();
  });

  describe('request-scoped create diagnostics', () => {
    const correlationId = 'c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60';

    it('records a local schema rejection without invoking create or fetch', async () => {
      const startExecute = vi.fn(async () => ({
        runId: 'task_run_one',
        agentId: 'wsa_one',
      }));
      const baseFetch = vi.fn(async () => new Response(null, { status: 202 }));
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: vi.fn(() => ({ execute: startExecute })),
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const error = await tools.startResearch
        .execute(
          {
            task: 'private-prompt-canary',
            outputSchema: { private_field: 'schema-canary' },
          },
          {},
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('private-prompt-canary');
      expect(String(error)).not.toContain('schema-canary');
      expect(startExecute).not.toHaveBeenCalled();
      expect(baseFetch).not.toHaveBeenCalled();
      expect(diagnostics.clear).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'pre_network_rejection',
          providerPostAttempted: false,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
          localReason: 'schema_validation',
        },
      ]);
    });

    it.each([
      {
        boundary: 'empty agent id',
        url: 'https://sdk.nimbleway.com/v2/agents//runs',
        init: { method: 'POST' },
      },
      {
        boundary: 'extra path segment',
        url: `https://sdk.nimbleway.com/v2/agents/${CONFIGURED_AGENT_ID}/runs/unexpected`,
        init: { method: 'POST' },
      },
      {
        boundary: 'encoded separator in agent id',
        url: 'https://sdk.nimbleway.com/v2/agents/wsa_bad%2Fsegment/runs',
        init: { method: 'POST' },
      },
      {
        boundary: 'invalid agent-id character',
        url: 'https://sdk.nimbleway.com/v2/agents/wsa_bad:segment/runs',
        init: { method: 'POST' },
      },
      {
        boundary: 'unexpected origin',
        url: 'https://example.invalid/v2/agents/runs',
        init: { method: 'POST' },
      },
      {
        boundary: 'non-POST method',
        url: 'https://sdk.nimbleway.com/v2/agents/runs',
        init: { method: 'GET' },
      },
      {
        boundary: 'query string',
        url: `${CONFIGURED_AGENT_CREATE_URL}?trace=1`,
        init: { method: 'POST' },
      },
      {
        boundary: 'URL fragment',
        url: `${CONFIGURED_AGENT_CREATE_URL}#trace`,
        init: { method: 'POST' },
      },
    ])(
      'rejects $boundary before invoking the provider transport',
      async ({ url, init }) => {
      const baseFetch = vi.fn(async () => new Response(null, { status: 202 }));
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };
      const underlyingCreate = vi.fn(async (providerFetch: typeof fetch) => {
        await providerFetch(url, init);
        return { runId: 'task_run_one', agentId: 'wsa_one' };
      });
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: vi.fn(
            (config: { clientOptions?: { fetch?: typeof fetch } }) => ({
              execute: () => underlyingCreate(config.clientOptions!.fetch!),
            }),
          ),
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const first = tools.startResearch.execute({ task: 'one' }, {});
      const repeated = tools.startResearch.execute({ task: 'duplicate' }, {});
      expect(repeated).toBe(first);
      const error = await first.catch((caught: unknown) => caught);
      await expect(repeated).rejects.toBe(error);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('"phase":"pre_network_rejection"');
      expect(String(error)).toContain('"localReason":"sdk_local_rejection"');
      expect(String(error)).toContain('"providerPostAttempted":false');
      expect(underlyingCreate).toHaveBeenCalledOnce();
      expect(baseFetch).not.toHaveBeenCalled();
      expect(diagnostics.clear).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        phase: 'pre_network_rejection',
        providerPostAttempted: false,
        providerResponseReceived: false,
      });
      },
    );

    it('records outbound and 202 response, then clears once after one successful create', async () => {
      const operations: string[] = [];
      const baseFetch = vi.fn(async () => {
        operations.push('provider-fetch');
        return new Response(null, { status: 202 });
      });
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          operations.push(`report:${event.phase}`);
          return true;
        }),
        clear: vi.fn(async () => {
          operations.push('clear');
          return true;
        }),
      };
      const created = { runId: 'task_run_one', agentId: 'wsa_one' };
      const underlyingCreate = vi.fn(
        async (
          providerFetch: typeof fetch,
          input: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          const response = await providerFetch(
            GENERATED_AGENT_CREATE_URL,
            {
              method: 'POST',
              body: JSON.stringify(input),
            },
          );
          expect(response.status).toBe(202);
          return created;
        },
      );
      const startFactory = vi.fn(
        (config: { clientOptions?: { fetch?: typeof fetch } }) => ({
          execute: (input: Record<string, unknown>) =>
            underlyingCreate(config.clientOptions!.fetch!, input),
        }),
      );
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: startFactory,
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const first = tools.startResearch.execute({ task: 'one' }, {});
      const repeated = tools.startResearch.execute({ task: 'duplicate' }, {});
      expect(repeated).toBe(first);
      await expect(first).resolves.toEqual(created);
      await expect(repeated).resolves.toEqual(created);

      expect(underlyingCreate).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledOnce();
      expect(diagnostics.clear).toHaveBeenCalledOnce();
      expect(operations).toEqual([
        'provider-fetch',
        'report:outbound_post_attempt',
        'report:provider_response',
        'clear',
      ]);
      expect(events).toEqual([
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'outbound_post_attempt',
          providerPostAttempted: true,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
        },
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'provider_response',
          providerPostAttempted: true,
          providerResponseReceived: true,
          retryCreateAutomatically: false,
          httpStatus: 202,
        },
      ]);
    });

    it('observes the released SDK generated-agent POST at the expected endpoint', async () => {
      let captured: Request | undefined;
      const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response(
          JSON.stringify({
            id: 'task_run_11111111-1111-4111-8111-111111111111',
            interaction_id: 'interaction_11111111-1111-4111-8111-111111111111',
            status: 'queued',
            is_active: true,
            effort: 'low',
            created_at: '2026-07-22T10:00:00Z',
            web_search_agent_id: 'wsa_11111111-1111-4111-8111-111111111111',
          }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };
      const tools = buildAgentTools(
        'nimble_request_key',
        undefined,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      await expect(
        tools.startResearch.execute({ task: 'one bounded research task' }, {}),
      ).resolves.toMatchObject({
        runId: 'task_run_11111111-1111-4111-8111-111111111111',
        agentId: 'wsa_11111111-1111-4111-8111-111111111111',
        status: 'queued',
        effort: 'low',
      });

      expect(baseFetch).toHaveBeenCalledOnce();
      expect(captured).toBeDefined();
      expect(captured!.method).toBe('POST');
      expect(captured!.url).toBe(GENERATED_AGENT_CREATE_URL);
      expect(events.map((event) => event.phase)).toEqual([
        'outbound_post_attempt',
        'provider_response',
      ]);
      expect(diagnostics.clear).toHaveBeenCalledOnce();
    });

    it('observes the released SDK configured-agent POST exactly once', async () => {
      const previousAgentId = process.env.NIMBLE_AGENT_ID;
      process.env.NIMBLE_AGENT_ID = CONFIGURED_AGENT_ID;
      let captured: Request | undefined;
      const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response(
          JSON.stringify({
            id: 'task_run_22222222-2222-4222-8222-222222222222',
            interaction_id: 'interaction_22222222-2222-4222-8222-222222222222',
            status: 'queued',
            is_active: true,
            effort: 'low',
            created_at: '2026-07-22T10:00:00Z',
            web_search_agent_id: CONFIGURED_AGENT_ID,
          }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };

      try {
        const tools = buildAgentTools(
          'nimble_request_key',
          undefined,
          diagnostics,
        ) as unknown as Record<string, Executable>;

        const first = tools.startResearch.execute(
          { task: 'one bounded research task' },
          {},
        );
        const repeated = tools.startResearch.execute(
          { task: 'duplicate bounded research task' },
          {},
        );
        expect(repeated).toBe(first);
        await expect(first).resolves.toMatchObject({
          runId: 'task_run_22222222-2222-4222-8222-222222222222',
          agentId: CONFIGURED_AGENT_ID,
          status: 'queued',
          effort: 'low',
        });
        await expect(repeated).resolves.toMatchObject({
          agentId: CONFIGURED_AGENT_ID,
        });
      } finally {
        if (previousAgentId === undefined) {
          delete process.env.NIMBLE_AGENT_ID;
        } else {
          process.env.NIMBLE_AGENT_ID = previousAgentId;
        }
      }

      expect(baseFetch).toHaveBeenCalledOnce();
      expect(captured).toBeDefined();
      expect(captured!.method).toBe('POST');
      expect(captured!.url).toBe(CONFIGURED_AGENT_CREATE_URL);
      expect(events.map((event) => event.phase)).toEqual([
        'outbound_post_attempt',
        'provider_response',
      ]);
      expect(diagnostics.clear).toHaveBeenCalledOnce();
    });

    it('keeps the last durable phase candid when terminal reporting and clear fail', async () => {
      const baseFetch = vi.fn(async () => new Response(null, { status: 202 }));
      const durableEvents: CreateDiagnosticEvent[] = [];
      const report = vi.fn(async (event: CreateDiagnosticEvent) => {
        if (event.phase === 'provider_response') return false;
        durableEvents.push(event);
        return true;
      });
      const clear = vi.fn(async () => {
        throw new Error('diagnostic-clear-canary');
      });
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report,
        clear,
      };
      const underlyingCreate = vi.fn(
        async (
          providerFetch: typeof fetch,
          input: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          await providerFetch(GENERATED_AGENT_CREATE_URL, {
            method: 'POST',
            body: JSON.stringify(input),
          });
          return { runId: 'task_run_one', agentId: 'wsa_one' };
        },
      );
      const startFactory = vi.fn(
        (config: { clientOptions?: { fetch?: typeof fetch } }) => ({
          execute: (input: Record<string, unknown>) =>
            underlyingCreate(config.clientOptions!.fetch!, input),
        }),
      );
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: startFactory,
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const first = tools.startResearch.execute(
        { task: 'private-prompt-canary' },
        {},
      );
      const repeated = tools.startResearch.execute(
        { task: 'different-duplicate' },
        {},
      );
      expect(repeated).toBe(first);
      await expect(first).resolves.toEqual({
        runId: 'task_run_one',
        agentId: 'wsa_one',
      });
      await expect(repeated).resolves.toEqual({
        runId: 'task_run_one',
        agentId: 'wsa_one',
      });

      expect(underlyingCreate).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledTimes(2);
      expect(clear).toHaveBeenCalledOnce();
      expect(durableEvents).toEqual([
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'outbound_post_attempt',
          providerPostAttempted: true,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
        },
      ]);
      expect(JSON.stringify(durableEvents)).not.toContain(
        'private-prompt-canary',
      );
      expect(JSON.stringify(durableEvents)).not.toContain(
        'diagnostic-clear-canary',
      );
    });

    it('records a structured provider response and makes one create POST under repeats', async () => {
      const baseFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            detail: 'provider-body-canary',
            echoed_input: 'private-prompt-canary',
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const events: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };
      const underlyingCreate = vi.fn(
        async (
          providerFetch: typeof fetch,
          input: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          const response = await providerFetch(
            GENERATED_AGENT_CREATE_URL,
            {
              method: 'POST',
              headers: {
                authorization: 'Bearer nimble-secret-canary',
                'content-type': 'application/json',
              },
              body: JSON.stringify(input),
            },
          );
          if (!response.ok) {
            throw new Error(
              `provider rejected private-prompt-canary: ${await response.text()}`,
            );
          }
          return { runId: 'task_run_one', agentId: 'wsa_one' };
        },
      );
      const startFactory = vi.fn(
        (config: { clientOptions?: { fetch?: typeof fetch } }) => ({
          execute: (input: Record<string, unknown>) =>
            underlyingCreate(config.clientOptions!.fetch!, input),
        }),
      );
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: startFactory,
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const first = tools.startResearch.execute(
        { task: 'private-prompt-canary' },
        {},
      );
      const repeated = tools.startResearch.execute(
        { task: 'different-duplicate' },
        {},
      );
      expect(repeated).toBe(first);
      const error = await first.catch((caught: unknown) => caught);
      await expect(repeated).rejects.toBe(error);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('"phase":"provider_response"');
      expect(String(error)).toContain('"httpStatus":422');
      expect(String(error)).not.toContain('provider-body-canary');
      expect(String(error)).not.toContain('private-prompt-canary');
      expect(String(error)).not.toContain('nimble-secret-canary');
      expect(underlyingCreate).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: GENERATED_AGENT_CREATE_URL,
        }),
      );
      expect(diagnostics.clear).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'outbound_post_attempt',
          providerPostAttempted: true,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
        },
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'provider_response',
          providerPostAttempted: true,
          providerResponseReceived: true,
          retryCreateAutomatically: false,
          httpStatus: 422,
        },
      ]);
    });

    it('records transport ambiguity and never repeats the underlying create or fetch', async () => {
      const baseFetch = vi.fn(async () => {
        throw new TypeError('socket-reset-canary');
      });
      const events: CreateDiagnosticEvent[] = [];
      const durableEvents: CreateDiagnosticEvent[] = [];
      const diagnostics: CreateDiagnosticReporter = {
        correlationId,
        baseFetch: baseFetch as unknown as typeof fetch,
        report: vi.fn(async (event) => {
          events.push(event);
          if (event.phase === 'transport_ambiguity') return false;
          durableEvents.push(event);
          return true;
        }),
        clear: vi.fn(async () => true),
      };
      const underlyingCreate = vi.fn(
        async (
          providerFetch: typeof fetch,
          input: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          await providerFetch(GENERATED_AGENT_CREATE_URL, {
            method: 'POST',
            body: JSON.stringify(input),
          });
          return { runId: 'task_run_one', agentId: 'wsa_one' };
        },
      );
      const startFactory = vi.fn(
        (config: { clientOptions?: { fetch?: typeof fetch } }) => ({
          execute: (input: Record<string, unknown>) =>
            underlyingCreate(config.clientOptions!.fetch!, input),
        }),
      );
      const tools = buildAgentTools(
        'nimble_request_key',
        {
          start: startFactory,
          status: vi.fn(() => ({ execute: vi.fn() })),
          result: vi.fn(() => ({ execute: vi.fn() })),
        } as never,
        diagnostics,
      ) as unknown as Record<string, Executable>;

      const first = tools.startResearch.execute(
        { task: 'private-prompt-canary' },
        {},
      );
      const repeated = tools.startResearch.execute(
        { task: 'different-duplicate' },
        {},
      );
      expect(repeated).toBe(first);
      const error = await first.catch((caught: unknown) => caught);
      await expect(repeated).rejects.toBe(error);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('"phase":"transport_ambiguity"');
      expect(String(error)).not.toContain('socket-reset-canary');
      expect(String(error)).not.toContain('private-prompt-canary');
      expect(underlyingCreate).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledOnce();
      expect(diagnostics.clear).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'outbound_post_attempt',
          providerPostAttempted: true,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
        },
        {
          schema: CREATE_DIAGNOSTIC_SCHEMA,
          correlationId,
          phase: 'transport_ambiguity',
          providerPostAttempted: true,
          providerResponseReceived: false,
          retryCreateAutomatically: false,
        },
      ]);
      expect(durableEvents.map((event) => event.phase)).toEqual([
        'outbound_post_attempt',
      ]);
    });
  });

  it('fails closed on unsupported, oversized, or mismatched structured inputs', async () => {
    const startExecute = vi.fn(async () => ({
      runId: 'task_run_one',
      agentId: 'wsa_one',
    }));
    const build = () =>
      buildAgentTools('nimble_request_key', {
        start: vi.fn(() => ({ execute: startExecute })),
        status: vi.fn(() => ({ execute: vi.fn() })),
        result: vi.fn(() => ({ execute: vi.fn() })),
      } as never) as unknown as Record<string, Executable>;

    const invalidInputs = [
      {
        task: 'nested shorthand',
        outputSchema: {
          type: 'object',
          properties: { company: { label: 'string' } },
        },
      },
      {
        task: 'remote ref',
        outputSchema: {
          type: 'object',
          properties: { company: { $ref: 'https://example.test/schema.json' } },
        },
      },
      {
        task: 'oversized',
        outputSchema: {
          type: 'object',
          description: 'x'.repeat(17_000),
          properties: { company: { type: 'string' } },
        },
      },
      {
        task: 'invalid numeric constraint',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number', multipleOf: 0 } },
        },
      },
      {
        task: 'duplicate enum',
        outputSchema: {
          type: 'object',
          properties: {
            confidence: { type: 'string', enum: ['high', 'high'] },
          },
        },
      },
      {
        task: 'input without schema',
        inputData: [{ company: 'Browserbase' }],
      },
    ];

    for (const input of invalidInputs) {
      await expect(build().startResearch.execute(input, {})).rejects.toThrow(
        /before any Agent API request/,
      );
    }
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('reports invalid sibling schema nodes in one local correction response', async () => {
    const startExecute = vi.fn(async () => ({
      runId: 'task_run_one',
      agentId: 'wsa_one',
    }));
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;

    const start = tools.startResearch.execute(
      {
        task: 'invalid siblings',
        outputSchema: {
          type: 'object',
          properties: {
            company: { type: 'string', pattern: '^Nimble' },
            rank: { type: 'number', default: 1 },
          },
        },
      },
      {},
    );

    await expect(start).rejects.toThrow(
      /properties\.company uses unsupported keywords: pattern; .*properties\.rank uses unsupported keywords: default/,
    );
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('reports nested issues even when parent schema types are missing', async () => {
    const startExecute = vi.fn(async () => ({
      runId: 'task_run_one',
      agentId: 'wsa_one',
    }));
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;

    const start = tools.startResearch.execute(
      {
        task: 'missing parent types',
        outputSchema: {
          type: 'object',
          properties: {
            company: {
              properties: {
                name: { type: 'string', pattern: '^Nimble' },
              },
            },
          },
        },
      },
      {},
    );

    await expect(start).rejects.toThrow(
      /properties\.company\.type must be .*; .*properties\.company\.properties\.name uses unsupported keywords: pattern/,
    );
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('reports duplicate required names even when properties are absent', async () => {
    const startExecute = vi.fn(async () => ({
      runId: 'task_run_one',
      agentId: 'wsa_one',
    }));
    const tools = buildAgentTools('nimble_request_key', {
      start: vi.fn(() => ({ execute: startExecute })),
      status: vi.fn(() => ({ execute: vi.fn() })),
      result: vi.fn(() => ({ execute: vi.fn() })),
    } as never) as unknown as Record<string, Executable>;

    const start = tools.startResearch.execute(
      {
        task: 'duplicate required names',
        outputSchema: {
          type: 'object',
          required: ['company', 'company'],
        },
      },
      {},
    );

    await expect(start).rejects.toThrow(
      /required must contain unique names.*; .*properties must be/,
    );
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('default-denies unless a short-lived audience-bound origin assertion matches', async () => {
    const previous = process.env.PLAYGROUND_GATEWAY_SECRET;
    const previousAudience = process.env.PLAYGROUND_GATEWAY_AUDIENCE;
    process.env.PLAYGROUND_GATEWAY_SECRET = 'origin-only-secret';
    process.env.PLAYGROUND_GATEWAY_AUDIENCE = 'playground.test';
    try {
      await expect(isGatewayAuthorized(new Request('https://playground.test/')))
        .resolves.toBe(false);
      await expect(
        isGatewayAuthorized(new Request('https://playground.test/', {
          headers: { [GATEWAY_HEADER]: 'wrong' },
        })),
      ).resolves.toBe(false);
      const now = Math.floor(Date.now() / 1_000);
      const assertion = await signGatewayAssertion('origin-only-secret', {
        role: 'agent',
        sid: 'S'.repeat(43),
        aud: 'playground.test',
        iat: now,
        exp: now + 30,
      });
      await expect(
        isGatewayAuthorized(new Request('https://playground.test/', {
          headers: { [GATEWAY_HEADER]: assertion },
        })),
      ).resolves.toBe(true);
      const wrongAudience = await signGatewayAssertion('origin-only-secret', {
        role: 'agent',
        sid: 'S'.repeat(43),
        aud: 'other.test',
        iat: now,
        exp: now + 30,
      });
      await expect(
        isGatewayAuthorized(new Request('https://playground.test/', {
          headers: { [GATEWAY_HEADER]: wrongAudience },
        })),
      ).resolves.toBe(false);
      const expired = await signGatewayAssertion('origin-only-secret', {
        role: 'agent',
        sid: 'S'.repeat(43),
        aud: 'playground.test',
        iat: now - 31,
        exp: now - 1,
      });
      await expect(
        isGatewayAuthorized(new Request('https://playground.test/', {
          headers: { [GATEWAY_HEADER]: expired },
        })),
      ).resolves.toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PLAYGROUND_GATEWAY_SECRET;
      else process.env.PLAYGROUND_GATEWAY_SECRET = previous;
      if (previousAudience === undefined) delete process.env.PLAYGROUND_GATEWAY_AUDIENCE;
      else process.env.PLAYGROUND_GATEWAY_AUDIENCE = previousAudience;
    }
  });

  it('default-denies the chat route before reading keys or invoking a model', async () => {
    const response = await POST(
      new Request('https://playground.test/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
  });

  it('renders trust from the real result output envelope', () => {
    const trust = { confidence: 'high', sources: [{ url: 'https://example.test' }], claims: [{}] };
    expect(trustFromToolOutput({ output: { trust } })).toEqual(trust);
  });

  it('renders text trust keyed by callout with citation excerpts', () => {
    const evidence = inspectableEvidence({
      output: {
        trust: {
          confidence: 'high',
          reasoning: 'r'.repeat(2_000),
          sources: [{ url: 'https://example.test/source', type: 'primary' }],
          claims: [{
            callout: 1,
            confidence: 'high',
            reasoning: 'Stated verbatim in the primary source.',
            citations: [{
              url: 'https://example.test/citation',
              excerpts: ['e'.repeat(500), 'second supporting excerpt'],
            }],
          }],
        },
      },
    });
    expect(evidence.reasoning).toHaveLength(1_200);
    expect(evidence.claims[0]).toMatchObject({
      key: 'Callout 1',
      confidence: 'high',
      reasoning: 'Stated verbatim in the primary source.',
    });
    expect(evidence.claims[0]?.citations[0]?.url).toBe('https://example.test/citation');
    expect(evidence.claims[0]?.citations[0]?.excerpts).toEqual([
      'e'.repeat(360),
      'second supporting excerpt',
    ]);
  });

  it('renders structured trust keyed by JSON path', () => {
    const evidence = inspectableEvidence({
      output: {
        trust: {
          confidence: 'medium',
          reasoning: 'Secondary sources only.',
          sources: [],
          claims: [{
            path: '$.company.founded',
            confidence: 'medium',
            reasoning: 'One secondary source.',
            citations: [{
              url: 'https://example.test/data',
              excerpts: ['founded in 2016'],
            }],
          }],
        },
      },
    });
    expect(evidence.claims[0]?.key).toBe('$.company.founded');
    expect(evidence.claims[0]?.citations[0]?.excerpts).toEqual(['founded in 2016']);
  });

  it('preserves the complete text and structured result without cropping', () => {
    const longText = 'evidence '.repeat(5_000);
    expect(actualResultFromToolOutput({
      ready: true,
      status: 'completed',
      output: { type: 'text', text: longText },
    }))
      .toBe(longText);
    expect(
      actualResultFromToolOutput({
        ready: true,
        status: 'completed',
        output: { type: 'json', json: { decision: 'hold', findings: ['one', 'two'] } },
      }),
    ).toBe('{\n  "decision": "hold",\n  "findings": [\n    "one",\n    "two"\n  ]\n}');
  });

  it('classifies zero-citation completion as degraded and cited output as grounded', () => {
    expect(
      classifyTrust({
        ready: true,
        output: {
          trust: {
            confidence: 'high',
            sources: [{ url: 'https://example.test/source' }],
            claims: [{ citations: [] }],
          },
        },
      }),
    ).toMatchObject({ label: 'DEGRADED / HOLD' });

    expect(
      classifyTrust({
        ready: true,
        output: {
          trust: {
            confidence: 'high',
            sources: [{ url: 'https://example.test/source' }],
            claims: [{ citations: [{ url: 'https://example.test/citation' }] }],
          },
        },
      }),
    ).toMatchObject({ label: 'GROUNDED' });
  });

  it('does not treat malformed or non-web evidence as grounded', () => {
    expect(
      classifyTrust({
        ready: true,
        output: {
          trust: {
            confidence: 'pre_existing',
            sources: [{}],
            claims: [{ citations: [{ url: 'javascript:alert(1)' }] }],
          },
        },
      }),
    ).toMatchObject({ label: 'DEGRADED / HOLD' });
  });

  it('generates a fresh stable-format ID for every new submission', () => {
    const first = newChatRequestId();
    const second = newChatRequestId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it('extracts the gateway CSRF token without exposing the signed session', () => {
    expect(
      csrfTokenFromCookie(
        'other=value; nimble_playground_csrf=csrf-value; nimble_playground_session=opaque',
      ),
    ).toBe('csrf-value');
  });
});

type Executable = {
  execute(input: Record<string, unknown>, options: unknown): Promise<Record<string, unknown>>;
};

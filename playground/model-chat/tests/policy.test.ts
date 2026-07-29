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
import { newChatRequestId } from '../lib/request-id';

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

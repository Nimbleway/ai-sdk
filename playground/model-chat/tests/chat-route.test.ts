import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GATEWAY_HEADER, signGatewayAssertion } from '../lib/gateway-auth';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  startFactory: vi.fn(),
  statusFactory: vi.fn(),
  resultFactory: vi.fn(),
}));

vi.mock('../lib/model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@nimble-way/ai-sdk', () => ({
  nimbleAgentStartRun: mocks.startFactory,
  nimbleAgentRunStatus: mocks.statusFactory,
  nimbleAgentRunResult: mocks.resultFactory,
}));

import { POST } from '../app/api/chat/route';

describe('authorized native chat route', () => {
  const previousGatewaySecret = process.env.PLAYGROUND_GATEWAY_SECRET;
  const previousGatewayAudience = process.env.PLAYGROUND_GATEWAY_AUDIENCE;
  const previousNimbleKey = process.env.NIMBLE_API_KEY;
  let model: MockLanguageModelV3;
  let gatewayAssertion: string;
  let startExecute: ReturnType<typeof vi.fn>;
  let statusExecute: ReturnType<typeof vi.fn>;
  let resultExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PLAYGROUND_GATEWAY_SECRET = 'origin-only-secret';
    process.env.PLAYGROUND_GATEWAY_AUDIENCE = 'playground.test';
    process.env.NIMBLE_API_KEY = 'deployed-nimble-key';
    const now = Math.floor(Date.now() / 1_000);
    gatewayAssertion = await signGatewayAssertion('origin-only-secret', {
      role: 'agent',
      sid: 'S'.repeat(43),
      aud: 'playground.test',
      iat: now,
      exp: now + 30,
    });
    startExecute = vi.fn(async () => ({
      runId: 'task_run_1',
      agentId: 'wsa_1',
      status: 'queued',
    }));
    statusExecute = vi.fn(async () => ({
      runId: 'task_run_1',
      agentId: 'wsa_1',
      status: 'running',
      isActive: true,
    }));
    resultExecute = vi.fn(async () => ({
      ready: true,
      runId: 'task_run_1',
      agentId: 'wsa_1',
      status: 'completed',
      output: {
        type: 'text',
        text: 'Unmodified grounded research output.',
        trust: {
          confidence: 'high',
          reasoning: 'Primary evidence supports the claim.',
          sources: [{ url: 'https://example.test/source' }],
          claims: [{
            callout: 1,
            confidence: 'high',
            reasoning: 'Direct citation.',
            citations: [{ url: 'https://example.test/source' }],
          }],
        },
      },
    }));
    mocks.startFactory.mockImplementation(() => tool({
      description: 'Start research.',
      inputSchema: z.object({ task: z.string() }),
      execute: startExecute,
    }));
    mocks.statusFactory.mockImplementation(() => tool({
      description: 'Check research.',
      inputSchema: z.object({ runId: z.string(), agentId: z.string() }),
      execute: statusExecute,
    }));
    mocks.resultFactory.mockImplementation(() => tool({
      description: 'Get research result.',
      inputSchema: z.object({ runId: z.string(), agentId: z.string() }),
      execute: resultExecute,
    }));
    let turn = 0;
    model = new MockLanguageModelV3({
      doStream: async () => {
        const finish = (reason: 'tool-calls' | 'stop') => ({
          type: 'finish' as const,
          finishReason: { unified: reason, raw: undefined },
          logprobs: undefined,
          usage: {
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 8,
              text: 8,
              reasoning: undefined,
            },
          },
        });
        const toolCalls = [
          {
            type: 'tool-call' as const,
            toolCallId: 'tc-start',
            toolName: 'startResearch',
            input: JSON.stringify({ task: 'Research objective' }),
          },
          {
            type: 'tool-call' as const,
            toolCallId: 'tc-status',
            toolName: 'checkResearch',
            input: JSON.stringify({ runId: 'task_run_1', agentId: 'wsa_1' }),
          },
          {
            type: 'tool-call' as const,
            toolCallId: 'tc-result',
            toolName: 'getResearchResult',
            input: JSON.stringify({ runId: 'task_run_1', agentId: 'wsa_1' }),
          },
        ];
        const chunks = turn < toolCalls.length
          ? [toolCalls[turn], finish('tool-calls')]
          : [
              { type: 'text-start' as const, id: 'text-1' },
              {
                type: 'text-delta' as const,
                id: 'text-1',
                delta: 'Final grounded result.',
              },
              { type: 'text-end' as const, id: 'text-1' },
              finish('stop'),
            ];
        turn += 1;
        return {
          stream: simulateReadableStream<never>({ chunks: chunks as never[] }),
        };
      },
    });
    mocks.resolveModel.mockReturnValue(model);
  });

  afterEach(() => {
    if (previousGatewaySecret === undefined) {
      delete process.env.PLAYGROUND_GATEWAY_SECRET;
    } else {
      process.env.PLAYGROUND_GATEWAY_SECRET = previousGatewaySecret;
    }
    if (previousNimbleKey === undefined) {
      delete process.env.NIMBLE_API_KEY;
    } else {
      process.env.NIMBLE_API_KEY = previousNimbleKey;
    }
    if (previousGatewayAudience === undefined) {
      delete process.env.PLAYGROUND_GATEWAY_AUDIENCE;
    } else {
      process.env.PLAYGROUND_GATEWAY_AUDIENCE = previousGatewayAudience;
    }
  });

  it('executes the model-selected start/status/result lifecycle exactly once', async () => {
    const messages = [
      {
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Research the objective.' }],
      },
    ];
    const response = await POST(
      new Request('https://playground.test/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [GATEWAY_HEADER]: gatewayAssertion,
          'x-nimble-api-key': 'browser-controlled-key',
        },
        body: JSON.stringify({ messages }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const stream = await response.text();
    expect(stream).toContain('Final grounded result.');
    expect(stream).toContain('"toolName":"startResearch"');
    expect(stream).toContain('"toolName":"checkResearch"');
    expect(stream).toContain('"toolName":"getResearchResult"');
    expect(stream).toContain('Unmodified grounded research output.');
    expect(model.doStreamCalls).toHaveLength(4);
    expect(model.doStreamCalls[0]?.tools).toHaveLength(3);
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'startResearch',
      'checkResearch',
      'getResearchResult',
    ]);
    expect(mocks.startFactory).toHaveBeenCalledWith({
      apiKey: 'deployed-nimble-key',
      effort: 'low',
    });
    expect(mocks.statusFactory).toHaveBeenCalledWith({ apiKey: 'deployed-nimble-key' });
    expect(mocks.resultFactory).toHaveBeenCalledWith({
      apiKey: 'deployed-nimble-key',
      wait: { pollIntervalMs: 10_000, timeoutMs: 300_000 },
    });
    expect(startExecute).toHaveBeenCalledOnce();
    expect(statusExecute).toHaveBeenCalledOnce();
    expect(resultExecute).toHaveBeenCalledOnce();
    expect(statusExecute).toHaveBeenCalledWith(
      { runId: 'task_run_1', agentId: 'wsa_1' },
      expect.anything(),
    );
    expect(resultExecute).toHaveBeenCalledWith(
      { runId: 'task_run_1', agentId: 'wsa_1' },
      expect.anything(),
    );
  });

  it('recovers from a locally rejected schema before the single create', async () => {
    mocks.startFactory.mockImplementation(() => tool({
      description: 'Start research.',
      inputSchema: z.object({
        task: z.string(),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: startExecute,
    }));
    const finish = (reason: 'tool-calls' | 'stop') => ({
      type: 'finish' as const,
      finishReason: { unified: reason, raw: undefined },
      logprobs: undefined,
      usage: {
        inputTokens: {
          total: 3,
          noCache: 3,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 8,
          text: 8,
          reasoning: undefined,
        },
      },
    });
    const toolCalls = [
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-start-invalid',
        toolName: 'startResearch',
        input: JSON.stringify({
          task: 'Research objective',
          outputSchema: { company: 'string' },
        }),
      },
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-start-corrected',
        toolName: 'startResearch',
        input: JSON.stringify({
          task: 'Research objective',
          outputSchema: {
            type: 'object',
            properties: { company: { type: 'string' } },
            required: ['company'],
          },
        }),
      },
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-status',
        toolName: 'checkResearch',
        input: JSON.stringify({ runId: 'task_run_1', agentId: 'wsa_1' }),
      },
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-result',
        toolName: 'getResearchResult',
        input: JSON.stringify({ runId: 'task_run_1', agentId: 'wsa_1' }),
      },
    ];
    let turn = 0;
    model = new MockLanguageModelV3({
      doStream: async () => {
        const chunks = turn < toolCalls.length
          ? [toolCalls[turn], finish('tool-calls')]
          : [
              { type: 'text-start' as const, id: 'text-recovered' },
              {
                type: 'text-delta' as const,
                id: 'text-recovered',
                delta: 'Recovered after local schema validation.',
              },
              { type: 'text-end' as const, id: 'text-recovered' },
              finish('stop'),
            ];
        turn += 1;
        return {
          stream: simulateReadableStream<never>({ chunks: chunks as never[] }),
        };
      },
    });
    mocks.resolveModel.mockReturnValue(model);

    const response = await POST(
      new Request('https://playground.test/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [GATEWAY_HEADER]: gatewayAssertion,
        },
        body: JSON.stringify({
          messages: [{
            id: 'message-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Research the objective.' }],
          }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"toolCallId":"tc-start-invalid"');
    expect(stream).toContain('"type":"tool-output-error"');
    expect(stream).toContain('Recovered after local schema validation.');
    expect(startExecute).toHaveBeenCalledOnce();
    expect(startExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: expect.objectContaining({ type: 'object' }),
      }),
      expect.anything(),
    );
    expect(statusExecute).toHaveBeenCalledOnce();
    expect(resultExecute).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(5);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      'rejected before any Agent API request',
    );
  });

  it('ignores a browser-controlled key when the deployed key is absent', async () => {
    delete process.env.NIMBLE_API_KEY;
    const response = await POST(
      new Request('https://playground.test/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [GATEWAY_HEADER]: gatewayAssertion,
          'x-nimble-api-key': 'browser-controlled-key',
        },
        body: JSON.stringify({ messages: [] }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'A Nimble API key is required for this protected action.',
    });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it.each(['admin', 'employee'] as const)(
    'rejects a valid %s assertion at the agent-only chat boundary',
    async (role) => {
      const now = Math.floor(Date.now() / 1_000);
      const assertion = await signGatewayAssertion('origin-only-secret', {
        role,
        sid: 'S'.repeat(43),
        aud: 'playground.test',
        iat: now,
        exp: now + 30,
      });
      const response = await POST(
        new Request('https://playground.test/api/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [GATEWAY_HEADER]: assertion,
          },
          body: JSON.stringify({ messages: [] }),
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
      expect(model.doStreamCalls).toHaveLength(0);
      expect(mocks.startFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'malformed JSON',
      body: '{"messages":',
    },
    {
      name: 'a non-array messages field',
      body: JSON.stringify({ messages: { role: 'user' } }),
    },
    {
      name: 'a malformed UI message',
      body: JSON.stringify({ messages: [{ role: 'user', parts: 'invalid' }] }),
    },
    {
      name: 'more than 100 messages',
      body: JSON.stringify({
        messages: Array.from({ length: 101 }, (_, index) => ({
          id: `message-${index}`,
          role: 'user',
          parts: [{ type: 'text', text: 'Research.' }],
        })),
      }),
    },
    {
      name: 'more than 64 KiB',
      body: JSON.stringify({
        messages: [{
          id: 'message-oversized',
          role: 'user',
          parts: [{ type: 'text', text: 'x'.repeat(64 * 1_024) }],
        }],
      }),
    },
  ])('returns a deliberate 400 for $name', async ({ body }) => {
    const response = await POST(
      new Request('https://playground.test/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [GATEWAY_HEADER]: gatewayAssertion,
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'The chat request body is invalid or exceeds 64 KiB.',
    });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(mocks.startFactory).not.toHaveBeenCalled();
  });
});

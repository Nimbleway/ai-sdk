import { inspect } from 'node:util';
import { describe, it, expect } from 'vitest';
import { nimbleSearch } from '../src/nimble-search';
import { nimbleExtract } from '../src/nimble-extract';
import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
} from '../src/nimble-agent';
import { NIMBLE_CLIENT_SOURCE, createNimbleClient } from '../src/client';
import { AGENT_ID, RUN_ID, completedRun, completedTextResult, rawRun } from './agent-fixtures';

/**
 * Release-gate coverage: every Nimble API request this package makes must
 * carry `X-Client-Source: vercel-ai-sdk`. These tests drive the REAL
 * `@nimble-way/nimble-js` client through the actual tool paths — only the
 * network is stubbed, via the SDK's own `fetch` option — and assert the
 * header on the captured wire requests.
 */

const execOpts = { toolCallId: 'test-call', messages: [] } as never;
const KEY = 'nimble-test-secret-key-123';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
}

function captureFetch(bodies: Array<{ status?: number; json: unknown }>) {
  const seen: CapturedRequest[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    const spec = bodies[Math.min(seen.length - 1, bodies.length - 1)]!;
    return new Response(JSON.stringify(spec.json), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { seen, fetch: impl };
}

function expectAttribution(req: CapturedRequest) {
  expect(req.headers.get('x-client-source')).toBe(NIMBLE_CLIENT_SOURCE);
  expect(req.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  // The key travels only in the Authorization header — never in the URL.
  expect(req.url).not.toContain(KEY);
}

describe('X-Client-Source attribution (real client, stubbed network)', () => {
  it('client configuration carries clientSource = vercel-ai-sdk', () => {
    const client = createNimbleClient(KEY);
    expect((client as unknown as { clientSource: string }).clientSource).toBe(
      NIMBLE_CLIENT_SOURCE,
    );
    expect(NIMBLE_CLIENT_SOURCE).toBe('vercel-ai-sdk');
  });

  it('nimbleSearch sends the header on the wire', async () => {
    const { seen, fetch } = captureFetch([
      { json: { request_id: 'r1', results: [], total_results: 0 } },
    ]);
    const t = nimbleSearch({ apiKey: KEY, clientOptions: { fetch, maxRetries: 0 } });
    await t.execute!({ query: 'nimble' }, execOpts);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expectAttribution(seen[0]!);
  });

  it('nimbleExtract sends the header on the wire', async () => {
    const { seen, fetch } = captureFetch([
      {
        json: {
          url: 'https://example.com',
          status: 'success',
          task_id: 't1',
          data: { markdown: '# Hi' },
          metadata: {},
        },
      },
    ]);
    const t = nimbleExtract({ apiKey: KEY, clientOptions: { fetch, maxRetries: 0 } });
    await t.execute!({ url: 'https://example.com' }, execOpts);

    expect(seen).toHaveLength(1);
    expectAttribution(seen[0]!);
  });

  it('nimbleAgentStartRun sends the header on the create request', async () => {
    const { seen, fetch } = captureFetch([{ status: 202, json: rawRun() }]);
    const t = nimbleAgentStartRun({
      apiKey: KEY,
      agentId: AGENT_ID,
      clientOptions: { fetch, maxRetries: 0 },
    });
    const out = (await t.execute!({ task: 'research' }, execOpts)) as { runId: string };

    expect(out.runId).toBe(RUN_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toContain(`/v2/agents/${AGENT_ID}/runs`);
    expectAttribution(seen[0]!);
  });

  it('nimbleAgentRunResult sends the header on every request of the flow', async () => {
    const { seen, fetch } = captureFetch([
      { json: completedRun() },
      { json: completedTextResult() },
    ]);
    const t = nimbleAgentRunResult({
      apiKey: KEY,
      agentId: AGENT_ID,
      clientOptions: { fetch, maxRetries: 0 },
    });
    const out = (await t.execute!({ runId: RUN_ID }, execOpts)) as { ready: boolean };

    expect(out.ready).toBe(true);
    expect(seen).toHaveLength(2); // status get + result get
    for (const req of seen) expectAttribution(req);
  });

  it('real-client errors never leak the API key', async () => {
    const { fetch } = captureFetch([{ status: 400, json: { message: 'bad request' } }]);
    const t = nimbleAgentStartRun({
      apiKey: KEY,
      agentId: AGENT_ID,
      clientOptions: { fetch, maxRetries: 0 },
    });
    const err = await Promise.resolve(t.execute!({ task: 'x' }, execOpts)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(KEY);
    // Deep inspection covers nested properties and the whole cause chain.
    expect(inspect(err, { depth: 8 })).not.toContain(KEY);
  });

  it('percent-encodes a hostile model-chosen runId into one opaque path segment', async () => {
    // The traversal guarantee lives in the SDK's path encoder; this pins it in
    // OUR suite so a future SDK/transport swap can't silently reopen it.
    const { seen, fetch } = captureFetch([{ json: rawRun() }]);
    const t = nimbleAgentRunStatus({
      apiKey: KEY,
      agentId: AGENT_ID,
      clientOptions: { fetch, maxRetries: 0 },
    });
    await t.execute!({ runId: 'x/../../v2/agents/OTHER/runs/y' }, execOpts);

    const pathname = new URL(seen[0]!.url).pathname;
    expect(pathname).toContain(`/v2/agents/${AGENT_ID}/runs/`);
    const runSegment = pathname.split('/runs/')[1]!;
    expect(runSegment).not.toContain('/'); // no raw separators escaped encoding
    expect(runSegment).toContain('%2F');
  });
});

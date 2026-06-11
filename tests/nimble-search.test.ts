import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nimbleSearch, NIMBLE_SEARCH_DEFAULTS } from '../src/nimble-search';
import { NimbleConfigError } from '../src/errors';
import type { NimbleSearchOutput, NimbleSearchParams } from '../src/schemas';
import { serpResult, searchResponse, mockNimbleClient } from './fixtures';

// The AI SDK passes a second options arg to execute(); a minimal stub suffices.
const execOpts = { toolCallId: 'test-call', messages: [] } as never;

async function run(
  config: Parameters<typeof nimbleSearch>[0],
  input: { query: string; maxResults?: number },
): Promise<NimbleSearchOutput> {
  const t = nimbleSearch(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, execOpts)) as NimbleSearchOutput;
}

describe('nimbleSearch — construction', () => {
  it('constructs without an API key', () => {
    const t = nimbleSearch();
    expect(t).toHaveProperty('inputSchema');
    expect(typeof t.execute).toBe('function');
  });

  it('exposes non-enterprise defaults', () => {
    expect(NIMBLE_SEARCH_DEFAULTS.searchDepth).toBe('lite');
    expect(NIMBLE_SEARCH_DEFAULTS.focus).toBe('general');
    expect(NIMBLE_SEARCH_DEFAULTS.maxResults).toBe(5);
    expect(NIMBLE_SEARCH_DEFAULTS.maxResultsCap).toBe(10);
  });
});

describe('nimbleSearch — execute() parameter mapping', () => {
  it('sends the v1-safe params (general focus, configured depth/region)', async () => {
    const { client, calls } = mockNimbleClient(searchResponse([serpResult()]));
    await run({ client, searchDepth: 'lite', country: 'US', locale: 'en' }, { query: 'nimble' });

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.query).toBe('nimble');
    expect(params.focus).toBe('general');
    expect(params.search_depth).toBe('lite');
    expect(params.country).toBe('US');
    expect(params.locale).toBe('en');
  });

  it('never sends include_answer or search_depth "fast"', async () => {
    const { client, calls } = mockNimbleClient(searchResponse([serpResult()]));
    await run({ client }, { query: 'q' });
    const sent = calls[0] as NimbleSearchParams & { include_answer?: unknown };
    expect(sent.include_answer).toBeUndefined();
    expect(sent.search_depth).not.toBe('fast');
  });

  it('defaults max_results to the configured maxResults', async () => {
    const { client, calls } = mockNimbleClient(searchResponse([serpResult()]));
    await run({ client, maxResults: 5 }, { query: 'q' });
    expect(calls[0]!.max_results).toBe(5);
  });

  it('clamps a model-requested maxResults to maxResultsCap', async () => {
    const { client, calls } = mockNimbleClient(searchResponse([serpResult()]));
    await run({ client, maxResultsCap: 10 }, { query: 'q', maxResults: 50 });
    expect(calls[0]!.max_results).toBe(10);
  });

  it('lets the model lower maxResults below the default', async () => {
    const { client, calls } = mockNimbleClient(searchResponse([serpResult()]));
    await run({ client, maxResults: 5 }, { query: 'q', maxResults: 2 });
    expect(calls[0]!.max_results).toBe(2);
  });
});

describe('nimbleSearch — execute() output + errors', () => {
  it('returns normalized results', async () => {
    const { client } = mockNimbleClient(searchResponse([serpResult()]));
    const out = await run({ client }, { query: 'nimble' });
    expect(out.query).toBe('nimble');
    expect(out.results[0]!.url).toBe('https://example.com/article');
    expect(out.results[0]!.position).toBe(1);
  });

  it('wraps a client/API failure in NimbleSearchError with the status', async () => {
    const failing = {
      search: async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    };
    await expect(run({ client: failing }, { query: 'q' })).rejects.toMatchObject({
      name: 'NimbleSearchError',
      status: 429,
    });
  });

  describe('missing key', () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.NIMBLE_API_KEY;
      delete process.env.NIMBLE_API_KEY;
    });
    afterEach(() => {
      if (saved !== undefined) process.env.NIMBLE_API_KEY = saved;
    });

    it('throws NimbleConfigError when no key and no client are available', async () => {
      await expect(run({}, { query: 'q' })).rejects.toBeInstanceOf(NimbleConfigError);
    });

    it('does not throw when a client is injected (no key needed)', async () => {
      const { client } = mockNimbleClient(searchResponse([serpResult()]));
      await expect(run({ client }, { query: 'q' })).resolves.toBeTruthy();
    });
  });
});

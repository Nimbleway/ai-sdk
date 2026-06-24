import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nimbleExtract, NIMBLE_EXTRACT_DEFAULTS } from '../src/nimble-extract';
import { NimbleConfigError } from '../src/errors';
import type { NimbleExtractOutput } from '../src/schemas';
import { extractResponse, mockNimbleExtractClient } from './fixtures';

const execOpts = { toolCallId: 'test-call', messages: [] } as never;

async function run(
  config: Parameters<typeof nimbleExtract>[0],
  input: { url: string },
): Promise<NimbleExtractOutput> {
  const t = nimbleExtract(config);
  if (!t.execute) throw new Error('tool has no execute');
  return (await t.execute(input, execOpts)) as NimbleExtractOutput;
}

const URL = 'https://example.com/article';

describe('nimbleExtract — construction', () => {
  it('constructs without an API key', () => {
    const t = nimbleExtract();
    expect(t).toHaveProperty('inputSchema');
    expect(typeof t.execute).toBe('function');
  });

  it('exposes defaults', () => {
    expect(NIMBLE_EXTRACT_DEFAULTS.format).toBe('markdown');
    expect(NIMBLE_EXTRACT_DEFAULTS.maxContentLength).toBe(50_000);
  });
});

describe('nimbleExtract — execute() parameter mapping', () => {
  it('sends the url and configured country', async () => {
    const { client, calls } = mockNimbleExtractClient(extractResponse());
    await run({ client, country: 'US' }, { url: URL });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.country).toBe('US');
  });

  it('omits country when not configured', async () => {
    const { client, calls } = mockNimbleExtractClient(extractResponse());
    await run({ client }, { url: URL });
    expect(calls[0]!.country).toBeUndefined();
  });

  it('requests both renderings (markdown preferred) plus links so the fallback is real', async () => {
    const { client, calls } = mockNimbleExtractClient(extractResponse());
    await run({ client }, { url: URL });
    expect(calls[0]!.formats).toEqual(['markdown', 'html', 'links']);
  });

  it('requests html first when format is html', async () => {
    const { client, calls } = mockNimbleExtractClient(extractResponse());
    await run({ client, format: 'html' }, { url: URL });
    expect(calls[0]!.formats).toEqual(['html', 'markdown', 'links']);
  });
});

describe('nimbleExtract — execute() output', () => {
  it('returns markdown content by default', async () => {
    const { client } = mockNimbleExtractClient(extractResponse());
    const out = await run({ client }, { url: URL });
    expect(out.format).toBe('markdown');
    expect(out.content).toContain('# Example Article');
    expect(out.url).toBe(URL);
    expect(out.status).toBe('success');
    expect(out.statusCode).toBe(200);
    expect(out.links).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('returns html content when format is html', async () => {
    const { client } = mockNimbleExtractClient(extractResponse());
    const out = await run({ client, format: 'html' }, { url: URL });
    expect(out.format).toBe('html');
    expect(out.content).toContain('<h1>Example Article</h1>');
  });

  it('falls back to the other format when the requested one is empty, and reports the format used', async () => {
    const { client } = mockNimbleExtractClient(
      extractResponse({ data: { markdown: '', html: '<p>only html</p>' } }),
    );
    const out = await run({ client, format: 'markdown' }, { url: URL });
    expect(out.content).toBe('<p>only html</p>');
    expect(out.format).toBe('html');
  });

  it('truncates content to maxContentLength', async () => {
    const big = '#'.repeat(100_000);
    const { client } = mockNimbleExtractClient(extractResponse({ data: { markdown: big } }));
    const out = await run({ client, maxContentLength: 1_000 }, { url: URL });
    expect(out.content).toHaveLength(1_000);
  });

  it('omits links when none are returned', async () => {
    const { client } = mockNimbleExtractClient(
      extractResponse({ data: { markdown: 'body', links: [] } }),
    );
    const out = await run({ client }, { url: URL });
    expect(out.links).toBeUndefined();
  });
});

describe('nimbleExtract — errors', () => {
  it('wraps a client/API failure in NimbleExtractError with the status', async () => {
    const failing = {
      extract: async () => {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      },
    };
    await expect(run({ client: failing }, { url: URL })).rejects.toMatchObject({
      name: 'NimbleExtractError',
      status: 403,
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
      await expect(run({}, { url: URL })).rejects.toBeInstanceOf(NimbleConfigError);
    });

    it('does not throw when a client is injected', async () => {
      const { client } = mockNimbleExtractClient(extractResponse());
      await expect(run({ client }, { url: URL })).resolves.toBeTruthy();
    });
  });
});

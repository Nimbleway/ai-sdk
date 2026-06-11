import { describe, it, expect } from 'vitest';
import { normalizeSearchResponse } from '../src/normalize';
import { serpResult, wsaResult, searchResponse } from './fixtures';

describe('normalizeSearchResponse', () => {
  it('maps the basic fields and SERP metadata', () => {
    const out = normalizeSearchResponse(
      searchResponse([serpResult()], { request_id: 'req-1', total_results: 7 }),
      { query: 'nimble release notes', maxContentLength: 10_000 },
    );
    expect(out.query).toBe('nimble release notes');
    expect(out.requestId).toBe('req-1');
    expect(out.totalResults).toBe(7);
    expect(out.results).toHaveLength(1);
    const r = out.results[0]!;
    expect(r.title).toBe('Example Result');
    expect(r.url).toBe('https://example.com/article');
    expect(r.description).toBe('A short snippet about the topic.');
    expect(r.position).toBe(1);
    expect(r.entityType).toBe('OrganicResult');
  });

  it('lite depth: no content field (content is empty), description carries the snippet', () => {
    const out = normalizeSearchResponse(searchResponse([serpResult({ content: '' })]), {
      query: 'q',
      maxContentLength: 10_000,
    });
    expect(out.results[0]!.content).toBeUndefined();
    expect(out.results[0]!.description).toBe('A short snippet about the topic.');
  });

  it('deep depth: surfaces content, truncated to maxContentLength', () => {
    const longBody = 'x'.repeat(50_000);
    const out = normalizeSearchResponse(searchResponse([serpResult({ content: longBody })]), {
      query: 'q',
      maxContentLength: 1_000,
    });
    expect(out.results[0]!.content).toHaveLength(1_000);
  });

  it('WSA metadata: position falls back to index, entityType omitted', () => {
    const out = normalizeSearchResponse(searchResponse([wsaResult(), wsaResult()]), {
      query: 'q',
      maxContentLength: 10_000,
    });
    expect(out.results[0]!.position).toBe(1);
    expect(out.results[1]!.position).toBe(2);
    expect(out.results[0]!.entityType).toBeUndefined();
  });

  it('drops results without a URL', () => {
    const out = normalizeSearchResponse(
      searchResponse([serpResult(), serpResult({ url: '' })]),
      { query: 'q', maxContentLength: 10_000 },
    );
    expect(out.results).toHaveLength(1);
  });

  it('never surfaces the answer field', () => {
    const out = normalizeSearchResponse(
      searchResponse([serpResult()], { answer: 'LEAK: should not appear' }),
      { query: 'q', maxContentLength: 10_000 },
    );
    expect(JSON.stringify(out)).not.toContain('LEAK');
  });

  it('handles an empty result set', () => {
    const out = normalizeSearchResponse(searchResponse([]), { query: 'q', maxContentLength: 100 });
    expect(out.results).toEqual([]);
    expect(out.totalResults).toBe(0);
  });
});

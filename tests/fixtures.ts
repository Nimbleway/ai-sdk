import type {
  NimbleExtractClient,
  NimbleExtractParams,
  NimbleRawExtractResponse,
  NimbleRawSearchResponse,
  NimbleRawSearchResult,
  NimbleSearchClient,
  NimbleSearchParams,
} from '../src/schemas';

/** A SERP-metadata result (v1 `general` focus). */
export function serpResult(over: Partial<NimbleRawSearchResult> = {}): NimbleRawSearchResult {
  return {
    content: '',
    description: 'A short snippet about the topic.',
    title: 'Example Result',
    url: 'https://example.com/article',
    metadata: { country: 'US', entity_type: 'OrganicResult', locale: 'en', position: 1 },
    ...over,
  };
}

/** A WSA-metadata result (shopping/social/geo focus — no position/entity_type). */
export function wsaResult(over: Partial<NimbleRawSearchResult> = {}): NimbleRawSearchResult {
  return {
    content: '',
    description: 'A WSA snippet.',
    title: 'WSA Result',
    url: 'https://shop.example.com/item',
    metadata: { agent_name: 'shopping' },
    ...over,
  };
}

export function searchResponse(
  results: NimbleRawSearchResult[],
  over: Partial<NimbleRawSearchResponse> = {},
): NimbleRawSearchResponse {
  return {
    request_id: 'req-test-0001',
    total_results: results.length,
    results,
    ...over,
  };
}

/** A spyable mock Nimble client that records the params it was called with. */
export function mockNimbleClient(response: NimbleRawSearchResponse): {
  client: NimbleSearchClient;
  calls: NimbleSearchParams[];
} {
  const calls: NimbleSearchParams[] = [];
  const client: NimbleSearchClient = {
    search: async (params: NimbleSearchParams) => {
      calls.push(params);
      return response;
    },
  };
  return { client, calls };
}

export function extractResponse(
  over: Partial<NimbleRawExtractResponse> = {},
): NimbleRawExtractResponse {
  return {
    url: 'https://example.com/article',
    status: 'success',
    status_code: 200,
    task_id: 'task-test-0001',
    data: {
      markdown: '# Example Article\n\nClean readable body text.',
      html: '<h1>Example Article</h1><p>Clean readable body text.</p>',
      links: ['https://example.com/a', 'https://example.com/b'],
    },
    ...over,
  };
}

/** A spyable mock Nimble extract client. */
export function mockNimbleExtractClient(response: NimbleRawExtractResponse): {
  client: NimbleExtractClient;
  calls: NimbleExtractParams[];
} {
  const calls: NimbleExtractParams[] = [];
  const client: NimbleExtractClient = {
    extract: async (params: NimbleExtractParams) => {
      calls.push(params);
      return response;
    },
  };
  return { client, calls };
}

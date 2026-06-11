import type {
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

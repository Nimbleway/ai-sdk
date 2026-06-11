import { tool } from 'ai';
import { Nimble } from '@nimble-way/nimble-js';
import { nimbleSearchInputSchema } from './schemas';
import type {
  NimbleSearchClient,
  NimbleSearchOutput,
  NimbleSearchParams,
  NimbleSearchToolConfig,
} from './schemas';
import { normalizeSearchResponse } from './normalize';
import { NimbleConfigError, NimbleSearchError } from './errors';

/** v1 factory defaults. `focus` is fixed to `general` and not user-exposed. */
export const NIMBLE_SEARCH_DEFAULTS = {
  maxResults: 5,
  maxResultsCap: 10,
  searchDepth: 'lite',
  country: 'US',
  locale: 'en',
  maxContentLength: 10_000,
  focus: 'general',
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function toSearchError(err: unknown): NimbleSearchError {
  if (err instanceof NimbleSearchError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new NimbleSearchError(`Nimble search failed: ${message}`, {
    status: readStatus(err),
    cause: err,
  });
}

function resolveClient(config: NimbleSearchToolConfig): NimbleSearchClient {
  if (config.client) return config.client;
  const apiKey = config.apiKey ?? process.env.NIMBLE_API_KEY;
  if (!apiKey) {
    throw new NimbleConfigError(
      'Missing Nimble API key: set NIMBLE_API_KEY or pass { apiKey } to nimbleSearch().',
    );
  }
  return new Nimble({ apiKey }) as unknown as NimbleSearchClient;
}

/**
 * Create a ready-made Vercel AI SDK web-search tool backed by Nimble Search
 * (`@nimble-way/nimble-js` → `POST /v1/search`).
 *
 * The model only chooses `{ query, maxResults? }`; all policy (depth, focus,
 * region, caps) is fixed by `config` — mirroring the Exa `webSearch()` shape.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { nimbleSearch } from '@nimble-way/ai-sdk';
 *
 * const { text } = await generateText({
 *   model: 'anthropic/claude-sonnet-4.6',
 *   prompt: 'What are the latest Nimble release notes?',
 *   tools: { webSearch: nimbleSearch({ searchDepth: 'lite', maxResults: 5 }) },
 * });
 * ```
 */
export function nimbleSearch(config: NimbleSearchToolConfig = {}) {
  const maxResults = config.maxResults ?? NIMBLE_SEARCH_DEFAULTS.maxResults;
  const maxResultsCap = config.maxResultsCap ?? NIMBLE_SEARCH_DEFAULTS.maxResultsCap;
  const searchDepth = config.searchDepth ?? NIMBLE_SEARCH_DEFAULTS.searchDepth;
  const country = config.country ?? NIMBLE_SEARCH_DEFAULTS.country;
  const locale = config.locale ?? NIMBLE_SEARCH_DEFAULTS.locale;
  const maxContentLength = config.maxContentLength ?? NIMBLE_SEARCH_DEFAULTS.maxContentLength;

  return tool({
    description:
      'Search the web with Nimble and return ranked results (title, url, ' +
      'snippet, and page content) for answering questions about current or ' +
      'factual information.',
    inputSchema: nimbleSearchInputSchema,
    execute: async (input): Promise<NimbleSearchOutput> => {
      const client = resolveClient(config);

      const params: NimbleSearchParams = {
        query: input.query,
        max_results: clamp(input.maxResults ?? maxResults, 1, maxResultsCap),
        search_depth: searchDepth,
        focus: NIMBLE_SEARCH_DEFAULTS.focus, // fixed 'general' in v1
        country,
        locale,
      };

      let raw;
      try {
        raw = await client.search(params);
      } catch (err) {
        throw toSearchError(err);
      }

      return normalizeSearchResponse(raw, {
        query: input.query,
        maxContentLength,
      });
    },
  });
}

import { z } from 'zod';

/**
 * The tool input the model fills in. Kept deliberately small: the model only
 * chooses the query and (optionally) how many results it wants. All policy
 * (depth, focus, region, caps) is fixed by the developer via the factory
 * config, not by the model.
 */
export const nimbleSearchInputSchema = z.object({
  query: z.string().min(1).describe('The web search query.'),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many results to return (clamped to the developer-configured cap).'),
});

export type NimbleSearchInput = z.infer<typeof nimbleSearchInputSchema>;

/**
 * v1 exposes only the two non-enterprise depths. `fast` is enterprise-gated and
 * intentionally not offered here.
 */
export type SearchDepth = 'lite' | 'deep';

/**
 * Developer-facing factory config. `focus` is fixed to `general` in v1 and is
 * not exposed. `include_answer` and `search_depth: 'fast'` are intentionally
 * absent (enterprise / unverified-entitlement surface).
 */
export interface NimbleSearchToolConfig {
  /** Nimble API key. Defaults to `process.env.NIMBLE_API_KEY`. */
  apiKey?: string;
  /** Inject a pre-built / mock Nimble client (tests, advanced users). */
  client?: NimbleSearchClient;
  /** Default number of results when the model doesn't specify. Default 5. */
  maxResults?: number;
  /** Hard upper bound on results, regardless of model request. Default 10. */
  maxResultsCap?: number;
  /** Search depth. Default `lite`. */
  searchDepth?: SearchDepth;
  /** ISO country for result localization. Default `US`. */
  country?: string;
  /** Locale for result localization. Default `en`. */
  locale?: string;
  /** Truncate each result's body to this many characters. Default 10_000. */
  maxContentLength?: number;
}

/**
 * Structural surface of `@nimble-way/nimble-js`'s `client.search()` that this
 * package relies on. Declared structurally so the scaffold typechecks without
 * pinning to the SDK's generated type names, and so tests can inject a mock.
 *
 * Phase B: reconcile field casing/names against
 * `sdks/nimble-js/checkout/src/` after `./tools/sync-sdk.sh nimble-js`.
 */
export interface NimbleSearchParams {
  query: string;
  max_results?: number;
  search_depth?: SearchDepth;
  focus?: string;
  country?: string;
  locale?: string;
}

/** Metadata for SERP-based results (general/news/location focus). */
export interface NimbleSerpMetadata {
  country: string;
  entity_type: string;
  locale: string;
  position: number;
  driver?: string | null;
}

/** Metadata for WSA-based results (shopping/social/geo focus). */
export interface NimbleWsaMetadata {
  agent_name: string;
}

export interface NimbleRawSearchResult {
  /** Full page text in `deep`; may be empty in `lite`. */
  content: string;
  description: string;
  title: string;
  url: string;
  /** SERP focus (v1 `general`) yields {@link NimbleSerpMetadata}. */
  metadata: NimbleSerpMetadata | NimbleWsaMetadata;
  /** Platform-specific extras (price, publish_date, …); omitted when none. */
  additional_data?: Record<string, unknown> | null;
}

export interface NimbleRawSearchResponse {
  request_id: string;
  results: NimbleRawSearchResult[];
  total_results: number;
  /** Intentionally never surfaced in v1 (include_answer is off). */
  answer?: string | null;
}

export interface NimbleSearchClient {
  search(params: NimbleSearchParams): Promise<NimbleRawSearchResponse>;
}

/** A single normalized result item returned to the model. */
export interface NimbleSearchResultItem {
  title: string;
  url: string;
  description?: string;
  content?: string;
  position?: number;
  entityType?: string;
}

/** The normalized tool output. `answer` is intentionally omitted in v1. */
export interface NimbleSearchOutput {
  query: string;
  requestId?: string;
  totalResults?: number;
  results: NimbleSearchResultItem[];
}

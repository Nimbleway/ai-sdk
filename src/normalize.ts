import type {
  ExtractFormat,
  NimbleExtractOutput,
  NimbleRawExtractResponse,
  NimbleRawSearchResponse,
  NimbleRawSearchResult,
  NimbleSearchOutput,
  NimbleSearchResultItem,
  NimbleSerpMetadata,
} from './schemas';

export interface NormalizeOptions {
  query: string;
  maxContentLength: number;
}

/** SERP focus (v1 `general`) carries position + entity_type; WSA does not. */
function isSerpMetadata(
  metadata: NimbleRawSearchResult['metadata'],
): metadata is NimbleSerpMetadata {
  return 'position' in metadata;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Map a raw `/v1/search` response into the package's normalized output shape.
 *
 * - `description` is the snippet (always present when the API returns one).
 * - `content` is the full page text, present only in `deep` depth (empty in
 *   `lite`), truncated to `maxContentLength`.
 * - `position` / `entityType` come from SERP metadata; for WSA results
 *   `position` falls back to the array index and `entityType` is omitted.
 * - Results without a URL are dropped (defensive).
 * - `response.answer` is never surfaced in v1.
 */
export function normalizeSearchResponse(
  response: NimbleRawSearchResponse,
  options: NormalizeOptions,
): NimbleSearchOutput {
  const results: NimbleSearchResultItem[] = [];

  response.results.forEach((raw, index) => {
    if (!raw.url) return;

    const item: NimbleSearchResultItem = {
      title: raw.title ?? '',
      url: raw.url,
    };
    if (raw.description) item.description = raw.description;
    if (raw.content && raw.content.trim().length > 0) {
      item.content = truncate(raw.content, options.maxContentLength);
    }

    if (isSerpMetadata(raw.metadata)) {
      item.position = raw.metadata.position;
      item.entityType = raw.metadata.entity_type;
    } else {
      item.position = index + 1;
    }

    results.push(item);
  });

  return {
    query: options.query,
    requestId: response.request_id,
    totalResults: response.total_results,
    results,
  };
}

export interface NormalizeExtractOptions {
  format: ExtractFormat;
  maxContentLength: number;
}

/**
 * Map a raw `/v1/extract` response into the package's normalized extract shape.
 *
 * - `content` is `data.markdown` (default) or `data.html`, falling back to the
 *   other when the requested one is empty, truncated to `maxContentLength`.
 * - `links` is surfaced when present; everything else (browser actions, network
 *   captures, screenshots) is intentionally dropped.
 */
export function normalizeExtractResponse(
  response: NimbleRawExtractResponse,
  options: NormalizeExtractOptions,
): NimbleExtractOutput {
  const data = response.data;
  const primary = options.format === 'html' ? data.html : data.markdown;
  const fallback = options.format === 'html' ? data.markdown : data.html;
  const content = truncate(primary || fallback || '', options.maxContentLength);

  const out: NimbleExtractOutput = {
    url: response.url,
    status: response.status,
    format: options.format,
    content,
  };
  if (typeof response.status_code === 'number') out.statusCode = response.status_code;
  if (data.links && data.links.length > 0) out.links = data.links;
  return out;
}

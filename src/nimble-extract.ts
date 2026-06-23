import { tool } from 'ai';
import { Nimble } from '@nimble-way/nimble-js';
import { nimbleExtractInputSchema } from './schemas';
import type {
  ExtractFormat,
  NimbleExtractClient,
  NimbleExtractOutput,
  NimbleExtractParams,
  NimbleExtractToolConfig,
} from './schemas';
import { normalizeExtractResponse } from './normalize';
import { NimbleConfigError, NimbleExtractError } from './errors';

/** v1 extract defaults. */
export const NIMBLE_EXTRACT_DEFAULTS: { format: ExtractFormat; maxContentLength: number } = {
  format: 'markdown',
  maxContentLength: 50_000,
};

function readStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function toExtractError(err: unknown): NimbleExtractError {
  if (err instanceof NimbleExtractError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new NimbleExtractError(`Nimble extract failed: ${message}`, {
    status: readStatus(err),
    cause: err,
  });
}

function resolveClient(config: NimbleExtractToolConfig): NimbleExtractClient {
  if (config.client) return config.client;
  const apiKey = config.apiKey ?? process.env.NIMBLE_API_KEY;
  if (!apiKey) {
    throw new NimbleConfigError(
      'Missing Nimble API key: set NIMBLE_API_KEY or pass { apiKey } to nimbleExtract().',
    );
  }
  return new Nimble({ apiKey }) as unknown as NimbleExtractClient;
}

/**
 * Create a Vercel AI SDK tool that extracts clean, readable content from a web
 * page with Nimble (`@nimble-way/nimble-js` → `POST /v1/extract`).
 *
 * The model only chooses `{ url }`; format, region, and length cap are fixed by
 * `config`. Mirrors {@link nimbleSearch}'s ergonomics.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { nimbleExtract } from '@nimble-way/ai-sdk';
 *
 * const { text } = await generateText({
 *   model: 'openai/gpt-4o-mini',
 *   prompt: 'Summarize https://nimbleway.com',
 *   tools: { extract: nimbleExtract() },
 * });
 * ```
 */
export function nimbleExtract(config: NimbleExtractToolConfig = {}) {
  const format = config.format ?? NIMBLE_EXTRACT_DEFAULTS.format;
  const maxContentLength = config.maxContentLength ?? NIMBLE_EXTRACT_DEFAULTS.maxContentLength;
  const country = config.country;

  return tool({
    description:
      'Fetch a web page by URL with Nimble and return its clean, readable content ' +
      '(markdown or HTML) — use this to read, quote, or summarize a specific page.',
    inputSchema: nimbleExtractInputSchema,
    execute: async (input): Promise<NimbleExtractOutput> => {
      const client = resolveClient(config);

      // Request both renderings (preferred format first) plus links. A rendering
      // is only produced when requested via `formats`, so asking for both lets an
      // empty primary fall back to the other; normalizeExtractResponse reports
      // whichever rendering actually populated the content.
      const params: NimbleExtractParams = {
        url: input.url,
        formats:
          format === 'html' ? ['html', 'markdown', 'links'] : ['markdown', 'html', 'links'],
      };
      if (country) params.country = country;
      // `main_content` returns the cleaned article body rather than the full page.
      if (format === 'markdown') params.markdown_backend = 'main_content';

      let raw;
      try {
        raw = await client.extract(params);
      } catch (err) {
        throw toExtractError(err);
      }

      return normalizeExtractResponse(raw, { format, maxContentLength });
    },
  });
}

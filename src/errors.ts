/**
 * Thrown when the tool is invoked without a resolvable API key (no `apiKey`
 * config and no `NIMBLE_API_KEY` in the environment) and no injected client.
 * Raised at execute time, not at factory-construction time, so the tool can be
 * constructed in environments without a key (e.g. unit tests, type-checking).
 */
export class NimbleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NimbleConfigError';
  }
}

/**
 * Wraps an error surfaced by the Nimble client / API during a search call,
 * preserving the HTTP status when available. The AI SDK surfaces a thrown
 * tool error back to the model as a tool-call failure.
 */
export class NimbleSearchError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NimbleSearchError';
    this.status = options?.status;
  }
}

/**
 * Wraps an error surfaced by the Nimble client / API during an extract call,
 * preserving the HTTP status when available.
 */
export class NimbleExtractError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NimbleExtractError';
    this.status = options?.status;
  }
}

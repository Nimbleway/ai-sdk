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

/** Why an agent-run tool call failed. */
export type NimbleAgentRunErrorReason =
  /** The run reached terminal status `failed`. */
  | 'failed'
  /** The run reached terminal status `cancelled`. */
  | 'cancelled'
  /** The API returned something outside the documented contract. */
  | 'protocol'
  /** The underlying request errored (transport, auth, rate limit, …). */
  | 'request';

/**
 * Thrown by the agent tools when a run cannot produce a result. Always retains
 * the run/agent IDs (when known) — in the fields *and* in the message — so a
 * model or caller seeing the error can still resume, inspect, or report the
 * run. A wait that merely times out does NOT throw this; the result tool
 * returns `{ ready: false }` because a still-active run is not a failure.
 */
export class NimbleAgentRunError extends Error {
  /** The run this error belongs to, when known. */
  readonly runId?: string;
  /** The agent instance the run belongs to, when known. */
  readonly agentId?: string;
  /** The run's terminal lifecycle status, when the server reported one. */
  readonly runStatus?: string;
  readonly reason: NimbleAgentRunErrorReason;
  /** HTTP status of the underlying request, when available. */
  readonly status?: number;

  constructor(
    message: string,
    options: {
      reason: NimbleAgentRunErrorReason;
      runId?: string;
      agentId?: string;
      runStatus?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NimbleAgentRunError';
    this.reason = options.reason;
    this.runId = options.runId;
    this.agentId = options.agentId;
    this.runStatus = options.runStatus;
    this.status = options.status;
  }
}

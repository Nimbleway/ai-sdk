import { z } from 'zod';
import type { NimbleClientOptions } from './client';

// ── Model-facing input schemas ─────────────────────────────────────────────

/**
 * Effort tiers accepted by the Agent API, in ascending cost/latency order.
 * Higher tiers research more sources for longer before answering.
 */
export const NIMBLE_AGENT_EFFORTS = ['low', 'medium', 'high', 'x-high', 'max'] as const;

export type NimbleAgentEffort = (typeof NIMBLE_AGENT_EFFORTS)[number];

/**
 * Input for the start-run tool. The model chooses the research task and, at
 * most, an effort tier (clamped to the developer-configured `effortCap`).
 * Everything else — the agent instance, credentials, request policy — is
 * developer configuration and never appears in the model schema.
 */
export const nimbleAgentStartRunInputSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe('The research task or question for the Nimble deep-research agent.'),
  effort: z
    .enum(NIMBLE_AGENT_EFFORTS)
    .optional()
    .describe(
      'Optional effort tier. Higher tiers research more sources and take ' +
        'longer (minutes) and cost more; omit to use the configured default.',
    ),
});

export type NimbleAgentStartRunInput = z.infer<typeof nimbleAgentStartRunInputSchema>;

/**
 * Input for the status and result tools: just the run ID returned by the
 * start-run tool. Runs are resumable — any process configured with the same
 * agent can check a run it did not start.
 */
export const nimbleAgentRunIdInputSchema = z.object({
  runId: z
    .string()
    .min(1)
    .describe(
      'The Nimble agent run ID (format "task_run_<uuid>") returned when the run was started.',
    ),
});

export type NimbleAgentRunIdInput = z.infer<typeof nimbleAgentRunIdInputSchema>;

// ── Developer-facing factory configs ───────────────────────────────────────

/** Run lifecycle states. `queued` and `running` are the non-terminal pair. */
export const NIMBLE_AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type NimbleAgentRunLifecycleStatus = (typeof NIMBLE_AGENT_RUN_STATUSES)[number];

/** Config shared by all three agent tool factories. */
export interface NimbleAgentToolConfig {
  /**
   * The Web Search Agent instance to run (format `wsa_<uuid>`), created once
   * via the Nimble console or API. Defaults to `process.env.NIMBLE_AGENT_ID`.
   * Resolved at execute time; the model can never choose the agent.
   */
  agentId?: string;
  /** Nimble API key. Defaults to `process.env.NIMBLE_API_KEY` (server-side). */
  apiKey?: string;
  /** Inject a pre-built / mock client (tests, advanced users). When set, the
   * package does not construct a client and `apiKey`/`clientOptions` are
   * ignored — attribution headers are then the injected client's concern. */
  client?: NimbleAgentRunsClient;
  /** Options forwarded to the package-constructed Nimble client. */
  clientOptions?: NimbleClientOptions;
}

/** Config for {@link nimbleAgentStartRun}. */
export interface NimbleAgentStartRunConfig extends NimbleAgentToolConfig {
  /**
   * Effort used when the model does not choose one. Unset means the agent
   * instance's own configured default applies (recommended).
   */
  effort?: NimbleAgentEffort;
  /**
   * Upper bound on the effort the *model* may request; model choices above it
   * are clamped. Does not limit the developer-set `effort`. Default `high`,
   * so a model cannot unilaterally trigger `x-high`/`max` cost tiers.
   */
  effortCap?: NimbleAgentEffort;
}

/** Bounded-wait behavior for {@link nimbleAgentRunResult}. */
export interface NimbleAgentWaitOptions {
  /** Give up waiting after this long (run keeps going server-side). Default 300_000. */
  timeoutMs?: number;
  /** Delay between status polls. Default 2_000, floor 100. */
  pollIntervalMs?: number;
}

/** Config for {@link nimbleAgentRunResult}. */
export interface NimbleAgentRunResultConfig extends NimbleAgentToolConfig {
  /**
   * When set, the tool polls a still-active run until it finishes or the
   * bounded timeout elapses (`true` = defaults). When absent (the default),
   * the tool never blocks: an active run returns `{ ready: false }`
   * immediately. Waiting respects the AI SDK's per-call `AbortSignal`.
   */
  wait?: boolean | NimbleAgentWaitOptions;
}

// ── Structural surface of the SDK this package calls ───────────────────────
// Declared structurally (mirroring `@nimble-way/nimble-js@1.1.x` generated
// types) so tests can inject mocks and the package's public .d.ts stays
// self-contained. tests/sdk-type-compat.test.ts asserts these stay assignable
// from the SDK's generated types.

/** Body this package sends to `POST /v2/agents/{agent_id}/runs`. */
export interface NimbleAgentRunCreateBody {
  /** User prompt or task instructions for the run. */
  input: string;
  /** Effort level overriding the agent default for this run. */
  effort?: NimbleAgentEffort | null;
}

/** Per-call options this package forwards to the SDK (abort propagation). */
export interface NimbleAgentRequestOptions {
  signal?: AbortSignal | undefined;
}

/** Raw run object returned by create/get (TaskRunResponsePublicV2). */
export interface NimbleAgentRawRun {
  /** Run identifier, format `task_run_<uuid>`. */
  id: string;
  interaction_id: string;
  status: NimbleAgentRunLifecycleStatus;
  /** True while status is `queued` or `running`. */
  is_active: boolean;
  effort: NimbleAgentEffort;
  created_at: string;
  web_search_agent_id: string;
  started_at?: string | null;
  completed_at?: string | null;
  prompt?: string | null;
  error?: { message: string; ref_id: string } | null;
}

/** How authoritative a source is for the answer. */
export type NimbleAgentTrustSourceType = 'primary' | 'secondary';

/** What kind of source a page is (independent of authoritativeness). */
export type NimbleAgentSourceCategory =
  | 'official'
  | 'news'
  | 'social'
  | 'academic'
  | 'aggregator'
  | 'other';

export type NimbleAgentTrustConfidence = 'high' | 'medium' | 'low' | 'pre_existing';

/** A source consulted while producing the answer. */
export interface NimbleAgentTrustSource {
  url: string;
  type: NimbleAgentTrustSourceType;
  title?: string | null;
  source_category?: NimbleAgentSourceCategory | null;
  source_intent?: NimbleAgentSourceCategory | null;
  extract_template_name?: string | null;
}

/** A citation backing a specific claim in the answer. */
export interface NimbleAgentTrustCitation {
  url: string;
  title?: string | null;
  /** Verbatim excerpts supporting the claim. */
  excerpts?: string[] | null;
  source_type?: NimbleAgentTrustSourceType | null;
  source_category?: NimbleAgentSourceCategory | null;
  source_intent?: NimbleAgentSourceCategory | null;
  extract_template_name?: string | null;
}

/**
 * Trust metadata for one claim. Text answers key claims by `callout` (the
 * numeric markers embedded in the prose); JSON answers key claims by `path`
 * (the JSON path of the value). Exactly one of the two is present.
 */
export interface NimbleAgentTrustClaim {
  confidence: NimbleAgentTrustConfidence;
  reasoning: string;
  citations: NimbleAgentTrustCitation[];
  /** Callout marker number referencing this claim in a text answer. */
  callout?: number;
  /** JSON path of the value this claim refers to in a JSON answer. */
  path?: string;
}

/**
 * Trust and citation metadata for a run's output — passed through verbatim
 * from the API (snake_case preserved) so citation markers stay aligned with
 * the answer and future fields survive.
 */
export interface NimbleAgentTrust {
  confidence: NimbleAgentTrustConfidence;
  reasoning: string;
  sources: NimbleAgentTrustSource[];
  claims: NimbleAgentTrustClaim[];
}

/** Raw output union returned by `GET .../result` on success. */
export type NimbleAgentRawOutput =
  | { type?: 'text'; content: string; trust: NimbleAgentTrust }
  | { type?: 'json'; content: Record<string, unknown> | unknown[]; trust: NimbleAgentTrust };

/** Raw success form of the result endpoint. */
export interface NimbleAgentRawResult {
  run: NimbleAgentRawRun;
  output: NimbleAgentRawOutput;
}

/** Raw failed form of the result endpoint (also carried on HTTP 422). */
export interface NimbleAgentRawFailedResult {
  run: NimbleAgentRawRun;
  error: { message: string; ref_id: string };
}

/**
 * The slice of `@nimble-way/nimble-js` the agent tools call:
 * `client.agents.runs.create/get/result`.
 */
export interface NimbleAgentRunsClient {
  agents: {
    runs: {
      create(
        agentId: string,
        body: NimbleAgentRunCreateBody,
        options?: NimbleAgentRequestOptions,
      ): Promise<NimbleAgentRawRun>;
      get(
        runId: string,
        params: { agent_id: string },
        options?: NimbleAgentRequestOptions,
      ): Promise<NimbleAgentRawRun>;
      result(
        runId: string,
        params: { agent_id: string },
        options?: NimbleAgentRequestOptions,
      ): Promise<NimbleAgentRawResult | NimbleAgentRawFailedResult>;
    };
  };
}

// ── Normalized tool outputs ────────────────────────────────────────────────

/** Output of the start-run tool: the handle needed to resume later. */
export interface NimbleAgentStartRunOutput {
  /** The real run ID (`task_run_<uuid>`) — pass to the status/result tools. */
  runId: string;
  /** The agent instance the run belongs to. */
  agentId: string;
  /** Interaction ID (conversation-continuation handle). */
  interactionId: string;
  status: NimbleAgentRunLifecycleStatus;
  effort: NimbleAgentEffort;
  createdAt: string;
}

/** Output of the status tool: a point-in-time run snapshot. */
export interface NimbleAgentRunStatusOutput {
  runId: string;
  agentId: string;
  status: NimbleAgentRunLifecycleStatus;
  /** True while the run is still queued or running. */
  isActive: boolean;
  effort: NimbleAgentEffort;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Server-reported error details when the run failed. */
  error?: { message: string };
}

/** Result-tool output while the run is still working: try again later. */
export interface NimbleAgentRunPendingOutput {
  ready: false;
  runId: string;
  agentId: string;
  status: 'queued' | 'running';
  isActive: true;
  effort: NimbleAgentEffort;
  createdAt: string;
  startedAt?: string;
}

/** The completed run's answer: prose (`text`) or structured (`json`). */
export type NimbleAgentOutput =
  | { type: 'text'; text: string; trust: NimbleAgentTrust }
  | { type: 'json'; json: Record<string, unknown> | unknown[]; trust: NimbleAgentTrust };

/** Result-tool output once the run completed. */
export interface NimbleAgentRunCompletedOutput {
  ready: true;
  runId: string;
  agentId: string;
  status: 'completed';
  effort: NimbleAgentEffort;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  output: NimbleAgentOutput;
}

export type NimbleAgentRunResultOutput =
  | NimbleAgentRunPendingOutput
  | NimbleAgentRunCompletedOutput;

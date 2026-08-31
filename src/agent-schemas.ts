import { z } from 'zod';
import type { NimbleClientOptions } from './client';

// ── Model-facing input schemas ─────────────────────────────────────────────

/**
 * Selectable effort overrides. `max` is a promotional, gated tier: the start
 * tool recognizes it and stops before create with contact guidance.
 * When effort is omitted, Nimble applies the selected agent/template default
 * (the documented product default is `high`, while template defaults vary).
 */
export const NIMBLE_AGENT_EFFORTS = ['low', 'medium', 'high', 'x-high', 'max'] as const;

/** A selectable per-run effort override; `max` is gated before create. */
export type NimbleAgentEffort = (typeof NIMBLE_AGENT_EFFORTS)[number];

/** JSON-schema-shaped object: an open record the AI SDK can serialize. */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** One allow/block source group: a titled set of domains. */
const nimbleAgentSourceGroupSchema = z.object({
  title: z.string().min(1).describe('Human-readable name for this group of domains.'),
  domains: z
    .array(z.string().min(1))
    .min(1)
    .describe('Domains in this group, e.g. ["sec.gov", "europa.eu"].'),
  order: z.number().int().min(0).optional().describe('Zero-based position of this group.'),
});

/**
 * Per-run source guidance (`sources` on the run-create body). Overrides the
 * agent instance's own source configuration for this run only.
 */
export const nimbleAgentSourcesSchema = z.object({
  allow: z
    .array(nimbleAgentSourceGroupSchema)
    .optional()
    .describe('Only these domain groups may be used.'),
  block: z
    .array(nimbleAgentSourceGroupSchema)
    .optional()
    .describe('These domain groups must not be used.'),
  prioritize: z
    .string()
    .optional()
    .describe('Free-text guidance describing sources or domains to prefer.'),
  avoid: z
    .string()
    .optional()
    .describe('Free-text guidance describing sources or domains to avoid.'),
});

export type NimbleAgentSourcesInput = z.infer<typeof nimbleAgentSourcesSchema>;

/** How a run is routed: research, enrichment, or dataset building. */
export type NimbleAgentUseCase = 'research' | 'enrichment' | 'dataset_building';

/**
 * Input for the start-run tool. The model chooses the research task and may
 * supply the published structured run controls (`effort`, `outputSchema`,
 * `inputData`, `sources`, `skill`, `useCase`). Everything else — the agent instance, credentials,
 * and request policy — is developer configuration and never model-selectable.
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
      'Optional per-run effort override: low, medium, high, x-high, or max. ' +
        'Max is a custom-budget tier and returns contact guidance before create. ' +
        'Omit effort to use the selected agent/template default.',
    ),
  outputSchema: jsonObjectSchema
    .optional()
    .describe(
      'Optional JSON Schema describing the structured answer this run should ' +
        'produce. Use for structured research, enrichment, or dataset building.',
    ),
  inputData: z
    .union([jsonObjectSchema, z.array(jsonObjectSchema)])
    .optional()
    .describe(
      'Optional existing records to enrich: one partial object or a list of ' +
        "them, mirroring outputSchema's shape.",
    ),
  sources: nimbleAgentSourcesSchema
    .optional()
    .describe('Optional per-run source guidance (allow / block / prioritize / avoid).'),
  skill: z
    .string()
    .min(1)
    .optional()
    .describe('Optional one-time skill or operating-context override for this run.'),
  useCase: z
    .enum(['research', 'enrichment', 'dataset_building'])
    .optional()
    .describe(
      'Optional run use case. With an existing agent this must match its configured use case.',
    ),
  agentName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional stable name for the agent this run uses. Most useful on the ' +
        'generated-agent route, where it names the agent Nimble creates.',
    ),
});

export type NimbleAgentStartRunInput = z.infer<typeof nimbleAgentStartRunInputSchema>;

/**
 * Input for the status and result tools: the `{ runId, agentId }` pair the
 * start-run tool returned. Both are required — a run started without a
 * configured agent gets a *generated* agent instance, and only the returned
 * `agentId` can address it. Runs are therefore resumable from any process,
 * including one that never started them and has no agent configured.
 */
export const nimbleAgentRunIdInputSchema = z.object({
  runId: z
    .string()
    .min(1)
    .describe(
      'The Nimble agent run ID (format "task_run_<uuid>") returned when the run was started.',
    ),
  agentId: z
    .string()
    .min(1)
    .describe(
      'The Nimble agent ID (format "wsa_<uuid>") returned alongside the runId ' +
        'when the run was started. Runs can only be addressed by this pair.',
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
   * Optional Web Search Agent instance to run (format `wsa_<uuid>`), created
   * once via the Nimble console or API. Defaults to
   * `process.env.NIMBLE_AGENT_ID`.
   *
   * When it resolves to nothing, {@link nimbleAgentStartRun} uses the
   * generated-agent route (`POST /v2/agents/runs`) instead: Nimble creates a
   * minimal agent for the run and returns its id, which the start tool hands
   * back so the status/result tools can address the run.
   *
   * On the status/result tools this is only a *consistency* constraint: those
   * tools address runs by the caller-supplied `{ runId, agentId }` pair, and a
   * pair naming a different agent than the configured one is rejected rather
   * than silently redirected.
   *
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
   * Default JSON Schema for the run's structured answer, used when the model
   * does not supply `outputSchema`. Sent as the run's `output_schema`.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Default records to enrich, used when the model does not supply
   * `inputData`. Sent as the run's `input_data`.
   */
  inputData?: Record<string, unknown> | Array<Record<string, unknown>>;
  /**
   * Default per-run source guidance, used when the model does not supply
   * `sources`. Sent as the run's `sources`.
   */
  sources?: NimbleAgentSourcesInput;
  /**
   * Pin the run's effort tier. Unlike the other controls — where a
   * model-supplied value wins — this one **overrides** the model's choice,
   * because it exists to bound cost: a host that pins `low` must not be
   * talked into a more expensive tier by the model. Leave unset to let the
   * model choose, or to fall through to the agent/template default.
   */
  effort?: NimbleAgentEffort;
  /**
   * Maximum effort a model-selected value may request. Defaults to `high`.
   * A developer-set `effort` still pins the exact tier and takes precedence.
   */
  effortCap?: NimbleAgentEffort;
  /**
   * Default one-time operating-context override, used when the model does not
   * supply `skill`. Sent as the run's `skill`.
   */
  skill?: string;
  /**
   * Default run routing, used when the model does not supply `useCase`. Sent
   * as the run's `use_case`. With an existing agent it must match that
   * agent's configured use case.
   */
  useCase?: NimbleAgentUseCase;
  /**
   * Default agent name, used when the model does not supply `agentName`. Sent
   * as the run's `agent_name`.
   */
  agentName?: string;
}

/** Bounded-wait behavior for {@link nimbleAgentRunResult}. */
export interface NimbleAgentWaitOptions {
  /** Give up waiting after this long (run keeps going server-side). Default 300_000. */
  timeoutMs?: number;
  /** Delay between WSA status polls. Default 10_000, floor 100 for test overrides. */
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

/**
 * Body this package sends to both run-create routes —
 * `POST /v2/agents/{agent_id}/runs` and `POST /v2/agents/runs`. Deliberately
 * limited to fields the current published run-create schema accepts.
 */
export interface NimbleAgentRunCreateBody {
  /** User prompt or task instructions for the run. */
  input: string;
  /** Optional per-run effort override; omitted to use the agent/template default. */
  effort?: NimbleAgentEffort;
  /** JSON schema overriding the agent's default structured output. */
  output_schema?: Record<string, unknown> | null;
  /** Existing records to enrich: one partial row or a list of them. */
  input_data?: Record<string, unknown> | Array<Record<string, unknown>> | null;
  /** Source guidance overriding the agent default. */
  sources?: NimbleAgentSourcesInput | null;
  /** One-time operating-context override for the run. */
  skill?: string | null;
  /** Research, enrichment, or dataset-building routing. */
  use_case?: NimbleAgentUseCase | null;
  /** Stable name for the agent this run uses. */
  agent_name?: string | null;
}

/**
 * Per-call options this package forwards to the SDK: abort propagation, plus
 * the per-request retry override used to make run creation single-shot.
 */
export interface NimbleAgentRequestOptions {
  signal?: AbortSignal | undefined;
  /**
   * Per-request retry budget. The SDK defaults to 2 retries; the create paths
   * pass `0` because run creation is billable, non-idempotent, and has no
   * idempotency key.
   */
  maxRetries?: number;
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
 * `client.agents.run` (generated-agent create), plus
 * `client.agents.runs.create/get/result`.
 */
export interface NimbleAgentRunsClient {
  agents: {
    /**
     * Generated-agent create (`POST /v2/agents/runs`): Nimble creates a
     * minimal persistent agent for the run and returns its
     * `web_search_agent_id` on the run.
     */
    run(
      body: NimbleAgentRunCreateBody,
      options?: NimbleAgentRequestOptions,
    ): Promise<NimbleAgentRawRun>;
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

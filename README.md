# @nimble-way/ai-sdk

Nimble Web Search, Extract, and deep-research Agent runs as ready-made [Vercel AI SDK](https://ai-sdk.dev) tools. Give any AI SDK agent the ability to search the web, read pages, and run cited multi-minute research with [Nimble](https://nimbleway.com) in a few lines.

## Features

- **Web Search** — a `nimbleSearch()` tool the model can call to retrieve ranked, real-time web results and ground its answers in them.
- **Extract** — a `nimbleExtract()` tool that fetches a URL and returns clean markdown (or HTML) for the model to read, quote, or summarize.
- **Deep research (Agent runs)** — `nimbleAgentStartRun()` / `nimbleAgentRunStatus()` / `nimbleAgentRunResult()`: start an asynchronous Nimble research agent run, get the run ID back immediately, and collect a source-cited answer minutes later — from the same or a different request or process.
- **Model- and gateway-agnostic** — app-side `tool()`s; work the same with the Vercel AI Gateway or a direct provider.
- **Typed** — typed config and normalized output; an injectable client for testing.

> Map and Crawl tools are planned follow-ups.

## Install

```bash
npm install @nimble-way/ai-sdk ai
# pnpm add @nimble-way/ai-sdk ai
# yarn add @nimble-way/ai-sdk ai
```

`ai` (v6) and `zod` are peer dependencies — you provide your app's copy.

## Prerequisites

A Nimble API key (get one at [app.nimbleway.com](https://app.nimbleway.com)):

```bash
export NIMBLE_API_KEY=...      # picked up automatically
```

Or pass it directly: `nimbleSearch({ apiKey: '...' })`.

## Usage

```ts
import { generateText, stepCountIs } from 'ai';
import { nimbleSearch } from '@nimble-way/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-4o-mini',
  prompt: 'What are the latest developments in agentic web search? Cite sources.',
  tools: {
    webSearch: nimbleSearch({ searchDepth: 'lite', maxResults: 5 }),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);
```

`streamText` works the same way — register the tool under `tools`.

### Next.js route handler

```ts
// app/api/chat/route.ts
import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from 'ai';
import { nimbleSearch } from '@nimble-way/ai-sdk';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o-mini',
    messages: await convertToModelMessages(messages),
    tools: {
      webSearch: nimbleSearch({ searchDepth: 'lite', maxResults: 5 }),
    },
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
```

### With or without the Vercel AI Gateway

The tool runs **in your app** (an app-side `tool()`, not a provider/server-executed search). It is therefore **gateway-agnostic**: it behaves identically whether you route your model through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) (plain-string model IDs like `'openai/gpt-4o-mini'`) or call a provider SDK directly. The gateway, if present, only routes the *model* call.

## Extract

Give the model a URL and get back clean content to read, quote, or summarize:

```ts
import { generateText, stepCountIs } from 'ai';
import { nimbleExtract } from '@nimble-way/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-4o-mini',
  prompt: 'Summarize https://en.wikipedia.org/wiki/Web_scraping',
  tools: { extract: nimbleExtract({ format: 'markdown' }) },
  // Allow a step after the tool call so the model can summarize the page.
  stopWhen: stepCountIs(2),
});
```

Register both tools together so the model can search, then read the best result:

```ts
tools: {
  webSearch: nimbleSearch(),
  extract: nimbleExtract(),
}
```

## Deep research (Agent runs)

### Search/Extract vs Agent runs

`nimbleSearch` and `nimbleExtract` are **synchronous** building blocks: one call, one response, seconds. A Nimble **Agent run** is a different capability: an autonomous research agent that plans, searches, reads, and cross-checks many sources, then returns a final answer with per-claim citations and confidence — and it takes **minutes**, not seconds.

| | Search / Extract | Agent run |
|---|---|---|
| Latency | seconds | minutes (effort-dependent) |
| Shape | request → response | start → poll status → fetch result |
| Output | ranked results / page content | final answer (text or JSON) + sources, per-claim citations, confidence |
| Best for | grounding a chat turn | briefs, due diligence, monitoring reports, enrichment |

Because a run outlives any sensible HTTP request, the tools split the lifecycle: **no chat request ever blocks for the research duration**.

### Setup

1. An API key, as for the other tools: `export NIMBLE_API_KEY=...` (server-side only — the key never appears in model inputs or tool outputs).
2. **Optionally**, a research agent instance. Without one, Nimble generates a minimal agent for each run and returns its ID — nothing to create, nothing to configure. With one, created **once** in the [Nimble console](https://app.nimbleway.com) (or via the Agents API — see [sdk.nimbleway.com/docs](https://sdk.nimbleway.com/docs)), runs go to that instance and inherit its goals and sources:

```bash
export NIMBLE_AGENT_ID=wsa_...   # optional; picked up automatically when set
```

Credentials are always developer configuration and never reach the model. Effort is optional and creation is never retried (see [Cost and safety](#cost-and-safety)).

A run is addressed by the **pair** `{ runId, agentId }` that `nimbleAgentStartRun` returns. Both halves matter: for a generated run, the returned `agentId` is the only way to reach it afterwards.

### Start now, answer later

```ts
import { generateText, stepCountIs } from 'ai';
import { nimbleAgentStartRun, nimbleAgentRunResult } from '@nimble-way/ai-sdk';

// Request 1 — starts the run; returns in milliseconds with the real run ID.
const first = await generateText({
  model: 'openai/gpt-4o-mini',
  prompt: 'Research the EU AI Act enforcement timeline for me.',
  tools: { startResearch: nimbleAgentStartRun() },
  stopWhen: stepCountIs(2),
});
// → the tool output contains { runId: 'task_run_…', agentId: 'wsa_…', status: 'queued', … }
```

Minutes later — **a different request, server, or process**; only the `{ runId, agentId }` pair crosses over:

```ts
// Request 2 — resumes from nothing but that pair. No agent configuration needed.
const second = await generateText({
  model: 'openai/gpt-4o-mini',
  prompt: `The user is back. Fetch research run ${runId} on agent ${agentId} and answer with citations.`,
  tools: { getResearchResult: nimbleAgentRunResult() },
  stopWhen: stepCountIs(2),
});
```

If the run is still working, `nimbleAgentRunResult` returns `{ ready: false, status: 'running', … }` — an expected state the model can relay ("still researching, check back soon"), **not** an error. Register `nimbleAgentRunStatus()` too when you want cheap progress checks without result fetching.

See [`examples/agent-research.ts`](examples/agent-research.ts) for the full flow, including resuming from a separate process (`--start-only` / `--resume`).

### Cost and safety

Two deliberate, non-configurable guarantees:

- **Effort is optional.** When omitted, the selected agent or template default applies (the documented product default is `high`, while template defaults vary). Explicit choices are `low`, `medium`, `high`, `x-high`, and `max`. Max is a custom-budget tier: selecting it stops before run creation with guidance to [contact Nimble](https://www.nimbleway.com/contact); it is never silently downgraded.
- **Run creation is never retried.** Creating a run is billable, non-idempotent, and has no idempotency key, so a "transient" failure that actually reached the server would start (and bill) a second run. Both create routes pass `maxRetries: 0` per request, which also overrides the SDK's default of 2 on an injected client. Read-only status/result calls keep the SDK's normal retry behavior.

Runs still take minutes; the split lifecycle is what keeps that off your request path.

### Structured runs: schemas, records, and sources

Beyond `task`, a run accepts the published per-run controls — usable for research, enrichment, and dataset building alike. Each can be pinned by the developer and/or chosen by the model (a model-supplied value wins):

| Control | Sent as | Use it for |
|---|---|---|
| `outputSchema` | `output_schema` | A JSON Schema for a structured answer instead of prose. |
| `inputData` | `input_data` | Existing records to enrich — one object or a list, mirroring `outputSchema`. |
| `sources` | `sources` | Per-run `allow` / `block` domain groups and free-text `prioritize` / `avoid` guidance. |
| `skill` | `skill` | A one-time operating-context override for this run. |
| `useCase` | `use_case` | Route the run: `research`, `enrichment`, or `dataset_building`. With an existing agent it must match that agent's configured use case. |
| `agentName` | `agent_name` | A stable name for the agent the run uses — most useful on the generated-agent route, where it names the agent Nimble creates. |

```ts
nimbleAgentStartRun({
  outputSchema: { type: 'object', properties: { headquarters: { type: 'string' } } },
  sources: { allow: [{ title: 'Regulators', domains: ['sec.gov', 'europa.eu'] }] },
});
```

Every one of these is published on both create routes by `@nimble-way/nimble-js` 1.2, and the package's compile-time SDK contract fails the build if this package ever declares a body field the SDK does not publish.

### Bounded waiting (optional)

By default the result tool **never blocks**. If you want a single tool call to ride out short remainders (e.g. behind a queue worker rather than a chat route), opt in:

```ts
nimbleAgentRunResult({ wait: { timeoutMs: 120_000, pollIntervalMs: 10_000 } })
```

The wait polls the status endpoint, honors the AI SDK's per-call `AbortSignal` (aborting stops the *wait* — the run keeps going server-side and stays resumable), and on timeout returns `{ ready: false }` with the run still healthy. There is no unbounded polling anywhere in the package.

### Errors

Terminal problems throw a typed `NimbleAgentRunError` whose `reason` is `'failed'`, `'cancelled'`, `'protocol'`, or `'request'` — always carrying `runId` (in the fields and the message) so the model or your code can still reference the run. A still-active run is **not** an error (`ready: false`), and neither is a wait timeout.

`nimbleSearch(config)` — all fields optional:

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | `process.env.NIMBLE_API_KEY` | Nimble API key. |
| `client` | `NimbleSearchClient` | — | Inject a pre-built/mock client (tests, advanced use). |
| `maxResults` | `number` | `5` | Results when the model doesn't specify. |
| `maxResultsCap` | `number` | `10` | Hard upper bound, regardless of model request. |
| `searchDepth` | `'lite' \| 'deep'` | `'lite'` | `lite` = fast metadata; `deep` = full page content. |
| `country` | `string` | `'US'` | Result localization. |
| `locale` | `string` | `'en'` | Result localization. |
| `maxContentLength` | `number` | `10_000` | Truncate each result body. |

The **model-facing input** is just `{ query: string, maxResults?: number }` — all policy above is developer-controlled, not model-controlled.

`nimbleExtract(config)` — all fields optional:

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | `process.env.NIMBLE_API_KEY` | Nimble API key. |
| `client` | `NimbleExtractClient` | — | Inject a pre-built/mock client. |
| `format` | `'markdown' \| 'html'` | `'markdown'` | Content format returned to the model. |
| `country` | `string` | — | ISO country for geolocation / proxy. |
| `maxContentLength` | `number` | `50_000` | Truncate the extracted content. |

The **model-facing input** is just `{ url: string }`.

All three agent factories share this config (all fields optional):

| Option | Type | Default | Notes |
|---|---|---|---|
| `agentId` | `string` | `process.env.NIMBLE_AGENT_ID` | Optional `wsa_…` agent instance. Unset → runs use the generated-agent route. On the status/result tools it only constrains which agent the caller-supplied pair may name. |
| `apiKey` | `string` | `process.env.NIMBLE_API_KEY` | Nimble API key (server-side). |
| `client` | `NimbleAgentRunsClient` | — | Inject a pre-built/mock client. |
| `clientOptions` | `NimbleClientOptions` | — | `baseURL` / `fetch` / `timeout` / `maxRetries` passthrough. |

`nimbleAgentStartRun(config)` adds:

| Option | Type | Default | Notes |
|---|---|---|---|
| `outputSchema` | `Record<string, unknown>` | — | Default JSON Schema for the answer; the model may override it. |
| `inputData` | `object \| object[]` | — | Default records to enrich; the model may override them. |
| `sources` | `NimbleAgentSourcesInput` | — | Default per-run source guidance; the model may override it. |

`nimbleAgentRunResult(config)` adds:

| Option | Type | Default | Notes |
|---|---|---|---|
| `wait` | `boolean \| { timeoutMs?, pollIntervalMs? }` | off | Bounded polling before answering; off = never blocks. Defaults `300_000` / `10_000`. Shorter intervals are test-only overrides (floor 100). |

The **model-facing inputs** are `{ task, effort?: 'low' | 'medium' | 'high' | 'x-high' | 'max', outputSchema?, inputData?, sources? }` (start) and `{ runId, agentId }` (status/result) — credentials and wait policy are never model-controlled, and the lifecycle `agentId` is the handle the start tool returned, not a free choice: if a `agentId` is also configured, a pair naming a different agent is rejected rather than silently redirected.

## Output shape

`nimbleSearch`:

```ts
{
  query: string;
  requestId?: string;
  totalResults?: number;
  results: Array<{
    title: string;
    url: string;
    description?: string;
    content?: string;     // present in `deep`
    position?: number;
    entityType?: string;
  }>;
}
```

`nimbleExtract`:

```ts
{
  url: string;
  status: string;        // e.g. 'success'
  statusCode?: number;
  format: 'markdown' | 'html';
  content: string;       // truncated to maxContentLength
  links?: string[];
}
```

`nimbleAgentStartRun` — the handle to resume with:

```ts
{
  runId: string;         // real run ID, format task_run_<uuid>
  agentId: string;
  interactionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  effort: 'low' | 'medium' | 'high' | 'x-high' | 'max'; // reported value
  createdAt: string;
}
```

`nimbleAgentRunStatus` — the handle fields plus `isActive`, `startedAt?`, `completedAt?`, and `error?: { message }` on failed runs.

`nimbleAgentRunResult` — a discriminated union on `ready`:

```ts
| { ready: false; runId; agentId; status: 'queued' | 'running'; isActive: true; effort; createdAt; startedAt? }
| {
    ready: true; runId; agentId; status: 'completed'; effort; createdAt; startedAt?; completedAt?;
    output:
      | { type: 'text'; text: string; trust: NimbleAgentTrust }
      | { type: 'json'; json: object | unknown[]; trust: NimbleAgentTrust };
  }
```

`trust` is the run's citation metadata, passed through **verbatim** from the API so callout markers stay aligned with the answer text:

```ts
{
  confidence: 'high' | 'medium' | 'low' | 'pre_existing';
  reasoning: string;
  sources: Array<{ url; type: 'primary' | 'secondary'; title?; source_category?; … }>;
  claims: Array<{
    callout?: number;    // text answers: [1]-style marker in the prose
    path?: string;       // json answers: JSON path of the value
    confidence; reasoning;
    citations: Array<{ url; title?; excerpts?: string[]; … }>;
  }>;
}
```

## Limitations

- **Search + Extract + Agent runs.** Map / Crawl are follow-ups.
- **No answer generation in Search.** `include_answer` is intentionally not exposed.
- **`searchDepth: 'fast'` is not available** in this package.
- **Agent effort follows the API contract** (see [Cost and safety](#cost-and-safety)): omitted effort preserves the agent/template default, and generally available tiers can be selected explicitly. Agent creation/management is deliberately not a model-callable tool, and per-run `enable_events` / `previous_interaction_id` are not exposed yet (nor is run event streaming over SSE).
- **Runtime:** targets the **Node.js runtime** (Node ≥ 18). Edge/serverless is expected to work but not yet verified — prefer the Node runtime.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NimbleConfigError: missing API key` | Set `NIMBLE_API_KEY` or pass `apiKey`. |
| `NimbleAgentRunError` with `reason: 'protocol'` about agent identity | The `{ runId, agentId }` pair doesn't match the configured agent, or the API returned a payload for a different run/agent. Pass the pair exactly as `nimbleAgentStartRun` returned it. |
| `NimbleExtractError` with a status | The Nimble Extract API returned an error; the HTTP status is on `err.status`. |
| `NimbleSearchError` with a status | The Nimble API returned an error; the HTTP status is on `err.status`. |
| `NimbleAgentRunError` | Check `err.reason` (`failed` / `cancelled` / `protocol` / `request`) and `err.runId`; HTTP status (when any) is on `err.status`. |
| Result tool always `{ ready: false }` | The run is still working — research takes minutes; keep the `runId` and check back, or enable `wait`. |
| Tool never called | Ensure your prompt invites tool use and `stopWhen` allows multiple steps. |

## License

Apache-2.0

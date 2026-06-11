# @nimble-way/ai-sdk

Nimble Web Search as a ready-made [Vercel AI SDK](https://ai-sdk.dev) tool. Give any AI SDK agent the ability to search the web with [Nimble](https://nimbleway.com) in a few lines.

## Features

- **Web Search** — a `nimbleSearch()` tool the model can call to retrieve ranked, real-time web results and ground its answers in them.
- **Model- and gateway-agnostic** — an app-side `tool()`; works the same with the Vercel AI Gateway or a direct provider.
- **Typed** — typed config and normalized output; an injectable client for testing.

> Extract, Map, and Crawl tools are planned follow-ups.

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

## Options

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

## Output shape

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

## Limitations

- **Search only.** Extract / Map / Crawl / Agents are follow-ups.
- **No answer generation.** `include_answer` is intentionally not exposed.
- **`searchDepth: 'fast'` is not available** (enterprise-gated).
- **Runtime:** targets the **Node.js runtime** (Node ≥ 18). Edge/serverless is expected to work but not yet verified — prefer the Node runtime.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NimbleConfigError: missing API key` | Set `NIMBLE_API_KEY` or pass `apiKey`. |
| `NimbleSearchError` with a status | The Nimble API returned an error; the HTTP status is on `err.status`. |
| Tool never called | Ensure your prompt invites tool use and `stopWhen` allows multiple steps. |

## License

Apache-2.0

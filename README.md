# @nimble-way/ai-sdk

Nimble Web Search and Extract as ready-made [Vercel AI SDK](https://ai-sdk.dev) tools. Give any AI SDK agent the ability to search the web and read pages with [Nimble](https://nimbleway.com) in a few lines.

## Features

- **Web Search** — a `nimbleSearch()` tool the model can call to retrieve ranked, real-time web results and ground its answers in them.
- **Extract** — a `nimbleExtract()` tool that fetches a URL and returns clean markdown (or HTML) for the model to read, quote, or summarize.
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

`nimbleExtract(config)` — all fields optional:

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | `process.env.NIMBLE_API_KEY` | Nimble API key. |
| `client` | `NimbleExtractClient` | — | Inject a pre-built/mock client. |
| `format` | `'markdown' \| 'html'` | `'markdown'` | Content format returned to the model. |
| `country` | `string` | — | ISO country for geolocation / proxy. |
| `maxContentLength` | `number` | `50_000` | Truncate the extracted content. |

The **model-facing input** is just `{ url: string }`.

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

## Limitations

- **Search + Extract.** Map / Crawl / Agents are follow-ups.
- **No answer generation.** `include_answer` is intentionally not exposed.
- **`searchDepth: 'fast'` is not available** (enterprise-gated).
- **Runtime:** targets the **Node.js runtime** (Node ≥ 18). Edge/serverless is expected to work but not yet verified — prefer the Node runtime.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NimbleConfigError: missing API key` | Set `NIMBLE_API_KEY` or pass `apiKey`. |
| `NimbleExtractError` with a status | The Nimble Extract API returned an error; the HTTP status is on `err.status`. |
| `NimbleSearchError` with a status | The Nimble API returned an error; the HTTP status is on `err.status`. |
| Tool never called | Ensure your prompt invites tool use and `stopWhen` allows multiple steps. |

## License

Apache-2.0

# Examples — `@nimble-way/ai-sdk`

Small, runnable Node examples of the `nimbleSearch` and `nimbleExtract` tools driving a model.
They link the package in this repo (`link:..`), so they exercise the local source.

## Setup

The examples resolve `@nimble-way/ai-sdk` via `workspace:*`, so the package must
be built once before they run. From the **repo root**:

```bash
pnpm install
pnpm run build
```

Then configure keys in this directory:

```bash
cd examples
cp .env.example .env   # fill in NIMBLE_API_KEY + OPENAI_API_KEY
```

Then export the keys (or use `node --env-file=.env`):

```bash
export NIMBLE_API_KEY=...
export OPENAI_API_KEY=...
```

## Run

```bash
pnpm generate "What did Nimble announce about agentic web search?"      # search → answer
pnpm stream   "What are the latest developments in AI web search?"       # search, streamed
pnpm extract  "https://en.wikipedia.org/wiki/Web_scraping"               # extract → summary
```

- [`generate-text.ts`](generate-text.ts) — `generateText` + `nimbleSearch()`; prints the tool's
  ranked results, then the model's cited answer.
- [`stream-text.ts`](stream-text.ts) — `streamText` variant; streams the answer to stdout.
- [`extract.ts`](extract.ts) — `generateText` + `nimbleExtract()`; reads a URL and summarizes it.

All use OpenAI `gpt-4o-mini` by default (override with `OPENAI_MODEL`); any AI SDK model works.

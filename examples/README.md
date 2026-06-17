# Examples — `@nimble-way/ai-sdk`

Two small, runnable Node examples of the `nimbleSearch` tool driving a model.

## Setup

```bash
cp .env.example .env   # fill in NIMBLE_API_KEY + OPENAI_API_KEY
pnpm install
```

Then export the keys (or use `node --env-file=.env`):

```bash
export NIMBLE_API_KEY=...   export OPENAI_API_KEY=...
```

## Run

```bash
pnpm generate "What did Nimble announce about agentic web search?"   # generateText
pnpm stream   "What are the latest developments in AI web search?"    # streamText
```

- [`generate-text.ts`](generate-text.ts) — `generateText` + `nimbleSearch()`; prints the tool's
  ranked results, then the model's cited answer.
- [`stream-text.ts`](stream-text.ts) — `streamText` variant; streams the answer to stdout.

Both use OpenAI `gpt-4o-mini` by default (override with `OPENAI_MODEL`); any AI SDK model works.

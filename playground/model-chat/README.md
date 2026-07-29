# Model-driven Agent API V2 playground

This is the thin Vercel AI SDK chat counterpart to the protected direct
controller. A language model selects the real `@nimble-way/ai-sdk` tools:

1. `startResearch` creates one generated-agent run with no `agent_id`;
2. `checkResearch` exposes the asynchronous state;
3. `getResearchResult` bounded-polls every 10 seconds and returns output plus
   trust metadata.

The host pins effort to `low`, and the integration makes exactly one
non-idempotent create request. A Nimble key entered in the UI remains in React
memory and is sent only as a request header; the server-side `NIMBLE_API_KEY`
is the fallback. Deployment must place this app behind the existing Kobi-only
passkey gateway. The gateway strips a public `X-Playground-Gateway-Auth`
header and injects its private origin credential on every proxied request.
The app compares that credential with `PLAYGROUND_GATEWAY_SECRET`; a missing
or invalid credential returns 404 for UI and 401 for API.

The Cloudflare package deliberately targets the existing
`vercel-ai-sdk-nimble-v2-playground` Worker. Its `v1` migration continues to
name only the already-deployed `AdminAuthState`; `v2` adds only
`ModelChatContainer`; `v3` adds only `ChatAdmissionState`. This preserves the
Worker hostname, WebAuthn RP ID, Durable Object binding, and registered
administrator passkey. The prior direct controller remains unchanged under
`playground/cloudflare/` as adapter and deployment evidence; model-chat is the
proposed replacement runtime.

Each new user submission receives a browser-generated UUID. After session
verification, a Durable Object transaction admits that principal/request pair
once. Concurrent or replayed POSTs return `409` before the container, and an
admitted request is never automatically retried after an ambiguous forward.

Configure one model provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENROUTER_API_KEY`), then:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Local tests never create a billed Nimble run.

The three sample queries are scored 94–96/100 under the shared query-testing
rubric. Each names a human decision, primary-source hierarchy, auditable output
contract, contradiction policy, and bounded stop condition. They cover
research, enrichment, and dataset-building intent with no pre-provisioned
agent.

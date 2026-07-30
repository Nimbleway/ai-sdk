# Model-driven Agent API V2 playground

This is the thin Vercel AI SDK chat counterpart to the protected direct
controller. A language model selects the real `@nimble-way/ai-sdk` tools:

1. `startResearch` creates one generated-agent run with no `agent_id`;
2. `checkResearch` exposes the asynchronous state;
3. `getResearchResult` bounded-polls every 10 seconds and returns output plus
   trust metadata.

The host pins effort to `low`, and the integration makes exactly one
non-idempotent create request. The Nimble key is server-side only through
`NIMBLE_API_KEY`; browser-controlled key headers are stripped and ignored.
Deployment must place this app behind the existing three-lane gateway:
administrator passkey, employee email OTP, and a workspace-bound signed agent
identity. Those lanes grant access to the protected UI, but login never grants
permission to spend. Only the configured agent identity can explicitly mint
the five-minute grant for the checked-in `SPEND_GRANT_EPOCH`; that epoch can be
authorized and consumed once. Its `name:generation` value must advance
monotonically. The Durable Object retains the highest generation, so a
configuration rollback cannot re-enable an older budget. Advancing it is an
intentional new live budget, not an automatic retry or session refresh.

After session verification, the edge strips browser-controlled authorization,
identity, and Nimble-key headers. It then signs a 30-second
`X-Playground-Origin-Assertion` containing the verified role, session ID,
audience, issue time, and expiry. The container verifies that assertion with
`PLAYGROUND_GATEWAY_SECRET` and `PLAYGROUND_GATEWAY_AUDIENCE`; a missing,
altered, expired, or wrong-audience assertion returns 404 for UI and 401 for
API. The signing secret is never sent in the proxied request.

The Cloudflare package deliberately targets the existing
`vercel-ai-sdk-nimble-v2-playground` Worker. Its `v1` migration continues to
name only the already-deployed `AdminAuthState`; `v2` adds only
`ModelChatContainer`; `v3` records the previously deployed but unused
`ChatAdmissionState`; and `v4` removes that class and its unneeded binding.
Exactly-one live admission is enforced by the atomic spend-grant transaction,
not by an uninvoked duplicate control. This preserves the Worker hostname,
WebAuthn RP ID, active Durable Object bindings, and registered administrator
passkey. The direct controller remains under
`playground/cloudflare/` as adapter evidence; model-chat is the replacement
runtime for this Worker.

The container uses one stable Durable Object name across image releases.
Rotating that name creates another independently routed instance and can
exhaust the deployment's single-instance capacity.

Each new user submission receives a browser-generated UUID. Before the first
submission, the registered agent session explicitly requests a signed,
five-minute grant limited to this integration, `low` effort, and one create.
A Durable Object transaction atomically consumes the epoch grant before the
request reaches the container. A fresh caller UUID, new login, or concurrent
POST cannot bypass it; replays return `409`, and an admitted request is never
automatically retried after an ambiguous forward.

The same transaction binds that UUID to a digest of the authenticated agent
session. The create transport emits a signed, 30-second internal callback with
only a fixed phase (`pre_network_rejection`, `outbound_post_attempt`,
`provider_response`, or `transport_ambiguity`), two transport booleans, an
optional numeric HTTP status or fixed local reason, and
`retryCreateAutomatically: false`. It never copies prompts, tool inputs,
schemas, result or provider prose, reasoning, error messages, stacks, headers,
cookies, keys, or the raw session ID. The existing `AdminAuthState` stores at
most the last durable receipt. Monotonic callback sequence numbers and an
invisible success tombstone reject delayed or replayed phase updates. Both
receipts and tombstones physically expire after ten minutes or at session
expiry, whichever comes first. A CSRF-protected read returns a receipt only to
the same registered agent session, and returns an empty `204` to that session
when no receipt exists; every other principal or request ID receives `404`. The
browser renders `receipt`, authenticated `none`, and `unread` as distinct
states. If a callback itself fails, the UI can show only the last phase durably
recorded before that failure, and warns against resubmission when no receipt can
be established. Diagnostic recording does not add a create retry path.

Configure one model provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENROUTER_API_KEY`). The deployment-specific `AUTH_RP_ID`,
`AGENT_AUTH_KEY_ID`, and `AGENT_AUTH_WORKSPACE_ID` bindings are required
Worker secrets so a fork cannot silently inherit another deployment's
identity. Then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nimble-way/ai-sdk build
pnpm --dir playground/model-chat test
pnpm --dir playground/model-chat typecheck
pnpm --dir playground/model-chat build
pnpm --dir playground/model-chat dev
```

Run these commands from the repository root. Building the linked SDK first is
required in a clean checkout because the playground resolves its package entry
from `dist/`. Local tests never create a billed Nimble run.

The three sample queries are scored 94–96/100 under the shared query-testing
rubric. Each names a human decision, primary-source hierarchy, auditable output
contract, contradiction policy, and bounded stop condition. They cover
research, enrichment, and dataset-building intent with no pre-provisioned
agent. The model-facing start tool also exposes the typed Agent API V2
`agentName`, `inputData`, `outputSchema`, `sources`, `skill`, and `useCase`
controls while the host alone pins effort to `low`.

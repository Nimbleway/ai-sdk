# Protected showcase — Vercel AI SDK × Nimble Agent API V2

This Worker runs the actual `@nimble-way/ai-sdk` V2 tools:
`nimbleAgentStartRun`, `nimbleAgentRunStatus`, and
`nimbleAgentRunResult`. It supports server-provisioned and explicit-agent
modes, protected-live effort fixed to `low`, and typed per-run output-schema, input-data, source,
skill, and use-case overrides from `nimble-js` 1.2. Its browser
polls status every 10 seconds and renders the final output and trust metadata.
The reusable `@nimble-way/ai-sdk` library retains its full documented effort
contract; only this protected live UI and action boundary are low-only.

Authentication and permission to spend are separate. All three lanes can
enter the protected deployment, but only the configured agent identity can
request the signed five-minute live grant. `SPEND_GRANT_EPOCH` names one global
authorization budget for this integration: the Durable Object can issue it
once and the start boundary can consume it once. A new login or browser request
ID cannot replenish it. The checked-in `name:generation` value must advance
monotonically; a persisted high-water mark makes configuration rollback fail
closed. Advancing the generation is an explicit decision to authorize another
live create.

The edge gateway authenticates the administrator with a WebAuthn passkey
before serving assets or `/api/*`. It uses a signed
`Secure; HttpOnly; SameSite=Strict` session and CSRF protection. Configure
`ADMIN_EMAIL`, `ADMIN_PASSKEY`, `ADMIN_SESSION_SECRET`, and `NIMBLE_API_KEY`
as Worker secrets — the authorized identity is configuration, never hard-coded,
so this deploys as-is for whoever owns the Worker. `NIMBLE_API_KEY` remains
server-only; browser-provided authorization and key headers are stripped.

Employee six-digit OTP and single-use magic-link access is implemented and
restricted to exact `@nimbleway.com` addresses. Employee access fails closed
unless `AUTH_EMPLOYEE_ENABLED` is exactly `true`; this reviewed configuration
sets it explicitly. The `AUTH_EMAIL` binding is restricted to the configured
`login@auth.kadosh.dev` sender. The passkey
ceremony has been locally exercised through registration-options generation,
but still requires a real browser authenticator and deployed-origin
verification before release.

The third lane is a separate audience-bound local-agent principal. It uses a
60-second canonical challenge authenticated by the per-environment session
secret, a non-exportable P-256 signature, atomic nonce replay rejection, a
one-use fragment activation, and a 15-minute `HttpOnly; Secure;
SameSite=Strict` session. Configure `AGENT_AUTH_PUBLIC_KEY`,
`AGENT_AUTH_KEY_ID`, `AGENT_AUTH_WORKSPACE_ID`, and `AUTH_RP_ID` as Worker
secrets. The identifiers are deployment-specific even though they are not
credentials, so keeping their values out of `wrangler.jsonc` prevents a fork
from silently inheriting another deployment's identity. The generated identity
is bound to this release worktree and Worker origin. This Mac reported
`keychain-nonextractable` rather than Secure Enclave, so the documented
same-user local trust boundary still applies.

The model-chat Worker reuses this authentication state at the edge. Once a
session is verified, it strips browser-supplied identity, authorization,
Nimble-key, and origin-auth headers and signs a 30-second origin assertion for
the container. The assertion binds the verified role and session ID to the
configured RP audience; the container rejects altered, expired, or
wrong-audience assertions. The shared signing secret is not forwarded as an
HTTP header.

Everything the Worker needs lives in `src/`, including `src/auth.ts`; there are
no imports from outside this directory, so `wrangler deploy --dry-run` bundles
it standalone and the whole showcase can be reviewed on its own. If more
playgrounds adopt the auth layer, factor it into a shared package rather than
copying it again.

`GET /version` serves `src/manifest.ts`: the exact `@nimble-way/ai-sdk` commit
and version this build links against, the pull request it came from, the
`@nimble-way/nimble-js` version, and the live `low` effort policy and 10-second
poll cadence. A running deployment can therefore always be matched back to the
reviewed source. `tests/manifest.test.ts` fails if any of it drifts from what
is actually installed.

Validation:

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

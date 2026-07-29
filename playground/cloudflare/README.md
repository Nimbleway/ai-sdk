# Protected showcase — Vercel AI SDK × Nimble Agent API V2

This Worker runs the actual `@nimble-way/ai-sdk` V2 tools:
`nimbleAgentStartRun`, `nimbleAgentRunStatus`, and
`nimbleAgentRunResult`. It supports server-provisioned and explicit-agent
modes, protected-live effort fixed to `low`, and typed per-run output-schema, input-data, source,
skill, and use-case overrides from `nimble-js` 1.2. Its browser
polls status every 10 seconds and renders the final output and trust metadata.
The reusable `@nimble-way/ai-sdk` library retains its full documented effort
contract; only this protected live UI and action boundary are low-only.

The edge gateway authenticates a single administrator with a WebAuthn passkey
before serving assets or `/api/*`. It uses a signed
`Secure; HttpOnly; SameSite=Strict` session and CSRF protection. Configure
`ADMIN_EMAIL`, `ADMIN_PASSKEY`, `ADMIN_SESSION_SECRET`, and `NIMBLE_API_KEY`
as Worker secrets — the authorized identity is configuration, never hard-coded,
so this deploys as-is for whoever owns the Worker. The password field is an
ephemeral per-session key override and is never persisted.

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

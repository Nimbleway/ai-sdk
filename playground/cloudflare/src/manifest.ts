/**
 * Build provenance for this showcase, served at `GET /version`.
 *
 * A deployed Worker is otherwise opaque: you cannot tell which package state
 * or SDK it was built from. These values are filled in from the reviewed
 * commit at build-prep time, so a running deployment can always be matched
 * back to the exact pull-request head that was reviewed.
 *
 * `corePackageCommit` is the commit of `@nimble-way/ai-sdk` this playground
 * links against via `file:../..`. Refresh it whenever the playground is
 * rebuilt from a new head.
 */
export const BUILD_MANIFEST = {
  showcase: "vercel-ai-sdk-nimble-v2-playground",
  corePackage: "@nimble-way/ai-sdk",
  corePackageVersion: "0.3.0",
  corePackageCommit: "a0b740d6567c09cab692bb24eb7f7fe0ff829fc9",
  corePackagePullRequest: "https://github.com/Nimbleway/ai-sdk/pull/11",
  nimbleSdk: "@nimble-way/nimble-js",
  nimbleSdkVersion: "1.2.0",
  agentApi: "v2",
  /** Live policy this deployment enforces regardless of model input. */
  effortPolicy: "low",
  /** Browser status-poll cadence, matching the package default. */
  pollIntervalMs: 10_000,
} as const;

export type BuildManifest = typeof BUILD_MANIFEST;

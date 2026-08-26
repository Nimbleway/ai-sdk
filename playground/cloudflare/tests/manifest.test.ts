import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILD_MANIFEST } from "../src/manifest";

const require = createRequire(import.meta.url);

/**
 * Read an installed package's own manifest. `nimble-js` does not expose
 * `./package.json` through its `exports` map, so resolve its entry point and
 * walk up to the manifest beside it rather than requiring the subpath.
 */
function installedVersion(pkg: string): string {
  let dir = dirname(require.resolve(pkg));
  for (let i = 0; i < 5; i++) {
    try {
      return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string })
        .version;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`could not locate the installed package.json for ${pkg}`);
}

/**
 * The manifest is the only thing tying a deployed Worker back to the reviewed
 * source, so it has to be checked rather than trusted. A stale or placeholder
 * value here is worse than no manifest: it would assert provenance the
 * deployment does not actually have.
 */
describe("build manifest", () => {
  it("pins a real core-package commit, not a placeholder", () => {
    expect(BUILD_MANIFEST.corePackageCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports the nimble-js version actually installed", () => {
    expect(BUILD_MANIFEST.nimbleSdkVersion).toBe(installedVersion("@nimble-way/nimble-js"));
    // The typed per-run controls this showcase exercises arrived in 1.2.
    expect(BUILD_MANIFEST.nimbleSdkVersion.startsWith("1.2.")).toBe(true);
  });

  it("reports the core package version actually linked", () => {
    expect(BUILD_MANIFEST.corePackageVersion).toBe(installedVersion("@nimble-way/ai-sdk"));
  });

  it("declares the live policy this deployment enforces", () => {
    // Must match enforceLiveLowEffort and the browser's poll cadence, or the
    // manifest would advertise a policy the Worker does not apply.
    expect(BUILD_MANIFEST.effortPolicy).toBe("low");
    expect(BUILD_MANIFEST.pollIntervalMs).toBe(10_000);
  });
});

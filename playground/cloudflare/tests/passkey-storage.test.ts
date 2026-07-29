import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { employeeAuthEnabled, type AdminAuthState } from "../src/auth";

const authNamespace = (env as unknown as {
  ADMIN_AUTH: DurableObjectNamespace<AdminAuthState>;
}).ADMIN_AUTH;

describe("protected gateway passkey storage", () => {
  it("keeps employee auth denied under the initial admin-only policy", () => {
    expect(employeeAuthEnabled({ AUTH_ADMIN_ONLY: "true" } as never)).toBe(false);
  });

  it("preserves legacy login and advertises independent backup credentials", async () => {
    const stub = authNamespace.get(authNamespace.newUniqueId());
    await runInDurableObject(stub, async (instance: AdminAuthState, state) => {
      await state.storage.put("credential", {
        id: "legacy-id",
        publicKey: [1, 2, 3],
        counter: 7,
      });
      expect(await instance.hasPasskey()).toBe(true);
      const legacy = await instance.authenticationOptions("example.test");
      expect(legacy.allowCredentials?.map((entry) => entry.id)).toEqual(["legacy-id"]);

      await state.storage.put("credentials", [
        { id: "icloud-id", publicKey: [1], counter: 11 },
        { id: "backup-id", publicKey: [2], counter: 3 },
      ]);
      const multiple = await instance.authenticationOptions("example.test");
      expect(multiple.allowCredentials?.map((entry) => entry.id)).toEqual([
        "icloud-id",
        "backup-id",
      ]);
      expect(await state.storage.get("credentials")).toEqual([
        { id: "icloud-id", publicKey: [1], counter: 11 },
        { id: "backup-id", publicKey: [2], counter: 3 },
      ]);
    });
  });

  it("denies unauthenticated backup-passkey registration", async () => {
    const stub = authNamespace.get(authNamespace.idFromName("admin"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("credentials", [
        { id: "existing-id", publicKey: [1], counter: 0 },
      ]);
    });
    const response = await SELF.fetch("https://example.test/__auth/passkeys/add");
    expect(response.status).toBe(403);
  });
});

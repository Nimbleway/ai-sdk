import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ORIGIN_AUTH_HEADER, protectedUpstreamRequest } from "../src/gateway";
import { admitOnce, validChatRequestId, type TransactionalStorage } from "../src/admission";

describe("protected model-chat upstream boundary", () => {
  it("strips spoofed browser auth and injects only the verified gateway values", () => {
    const request = protectedUpstreamRequest(
      new Request("https://demo.test/api/chat", {
        method: "POST",
        headers: {
          [ORIGIN_AUTH_HEADER]: "browser-spoof",
          authorization: "Bearer browser-token",
          cookie: "session=browser",
          "x-playground-auth-email": "attacker@example.test",
        },
        body: "{}",
      }),
      "origin-secret",
      "admin@example.test",
    );
    expect(request.headers.get(ORIGIN_AUTH_HEADER)).toBe("origin-secret");
    expect(request.headers.get("x-playground-auth-email")).toBe("admin@example.test");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
  });

  it("preserves WebSocket upgrades while overwriting authorization", () => {
    const request = protectedUpstreamRequest(
      new Request("https://demo.test/ws", {
        headers: { upgrade: "websocket", [ORIGIN_AUTH_HEADER]: "spoof" },
      }),
      "origin-secret",
      "admin@example.test",
    );
    expect(request.headers.get("upgrade")).toBe("websocket");
    expect(request.headers.get(ORIGIN_AUTH_HEADER)).toBe("origin-secret");
  });

  it("preserves the existing Worker and auth migration, adding only the container", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      name: string;
      migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
    };
    expect(config.name).toBe("vercel-ai-sdk-nimble-v2-playground");
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["AdminAuthState"] },
      { tag: "v2", new_sqlite_classes: ["ModelChatContainer"] },
      { tag: "v3", new_sqlite_classes: ["ChatAdmissionState"] },
    ]);
  });

  it("admits exactly one concurrent request and permanently rejects replay", async () => {
    const values = new Map<string, unknown>();
    let queue = Promise.resolve();
    const storage: TransactionalStorage = {
      transaction<T>(closure: (transaction: {
        get<V>(key: string): Promise<V | undefined>;
        put(key: string, value: unknown): Promise<void>;
      }) => Promise<T>): Promise<T> {
        const operation = queue.then(() =>
          closure({
            async get<V>(key: string) { return values.get(key) as V | undefined; },
            async put(key: string, value: unknown) { values.set(key, value); },
          }),
        );
        queue = operation.then(() => undefined, () => undefined);
        return operation;
      },
    };

    const concurrent = await Promise.all([admitOnce(storage), admitOnce(storage)]);
    expect(concurrent.sort()).toEqual([false, true]);
    await expect(admitOnce(storage)).resolves.toBe(false);
    expect(values.get("admitted")).toMatchObject({ retryAllowed: false });
  });

  it("accepts only client-generated UUID v4 request IDs", () => {
    expect(validChatRequestId("c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60")).toBe(true);
    expect(validChatRequestId("stable-but-not-a-uuid")).toBe(false);
    expect(validChatRequestId(null)).toBe(false);
  });
});

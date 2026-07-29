import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORIGIN_ASSERTION_HEADER,
  admitConfiguredLiveCreate,
  isAllowedUpstreamRequest,
  normalizeModelRuntime,
  protectedUpstreamRequest,
} from "../src/gateway";
import { validChatRequestId } from "../src/admission";
import { MODEL_CHAT_INSTANCE_NAME } from "../src/container-name";
import { readGatewayAssertion } from "../../lib/gateway-auth";

describe("protected model-chat upstream boundary", () => {
  it("strips spoofed browser auth and injects a short-lived origin assertion", async () => {
    const request = await protectedUpstreamRequest(
      new Request("https://demo.test/api/chat", {
        method: "POST",
        headers: {
          [ORIGIN_ASSERTION_HEADER]: "browser-spoof",
          authorization: "Bearer browser-token",
          cookie: "session=browser",
          "x-nimble-api-key": "browser-key",
          "x-playground-auth-email": "attacker@example.test",
          "x-playground-auth-role": "admin",
          "x-playground-auth-key-id": "spoofed-key",
        },
        body: "{}",
      }),
      "origin-secret",
      {
        role: "agent",
        sid: "S".repeat(43),
        audience: "demo.test",
      },
    );
    const assertion = request.headers.get(ORIGIN_ASSERTION_HEADER);
    expect(assertion).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const encoded = assertion!.split(".")[0]!;
    const claims = JSON.parse(
      Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(),
    );
    expect(claims).toMatchObject({
      role: "agent",
      sid: "S".repeat(43),
      aud: "demo.test",
    });
    expect(claims.exp - claims.iat).toBe(30);
    expect(assertion).not.toContain("origin-secret");
    expect(request.headers.has("x-playground-auth-email")).toBe(false);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    expect(request.headers.has("x-nimble-api-key")).toBe(false);
    expect(request.headers.has("x-playground-auth-role")).toBe(false);
    expect(request.headers.has("x-playground-auth-key-id")).toBe(false);
  });

  it("default-denies unknown routes, methods, and WebSocket upgrades", () => {
    expect(isAllowedUpstreamRequest(new Request("https://demo.test/"))).toBe(true);
    expect(isAllowedUpstreamRequest(new Request("https://demo.test/_next/static/app.js"))).toBe(true);
    expect(isAllowedUpstreamRequest(new Request("https://demo.test/api/chat", { method: "POST" }))).toBe(true);
    expect(isAllowedUpstreamRequest(new Request("https://demo.test/api/chat"))).toBe(false);
    expect(isAllowedUpstreamRequest(new Request("https://demo.test/admin"))).toBe(false);
    expect(
      isAllowedUpstreamRequest(new Request("https://demo.test/", {
        headers: { upgrade: "websocket" },
      })),
    ).toBe(false);
  });

  it("normalizes the origin secret identically across edge signing and app verification", async () => {
    const previousSecret = process.env.PLAYGROUND_GATEWAY_SECRET;
    const previousAudience = process.env.PLAYGROUND_GATEWAY_AUDIENCE;
    const runtime = normalizeModelRuntime({
      PLAYGROUND_GATEWAY_SECRET: "  origin-secret  ",
      AUTH_RP_ID: "  demo.test  ",
      NIMBLE_API_KEY: "  nimble-key  ",
      OPENAI_API_KEY: "  model-key  ",
    });
    expect(runtime).toMatchObject({
      originSecret: "origin-secret",
      audience: "demo.test",
      nimbleApiKey: "nimble-key",
      openaiApiKey: "model-key",
      providerConfigured: true,
    });
    process.env.PLAYGROUND_GATEWAY_SECRET = runtime.originSecret;
    process.env.PLAYGROUND_GATEWAY_AUDIENCE = runtime.audience;
    try {
      const request = await protectedUpstreamRequest(
        new Request("https://demo.test/"),
        runtime.originSecret!,
        {
          role: "agent",
          sid: "S".repeat(43),
          audience: runtime.audience!,
        },
      );
      await expect(readGatewayAssertion(request)).resolves.toMatchObject({
        role: "agent",
        sid: "S".repeat(43),
        aud: "demo.test",
      });
    } finally {
      if (previousSecret === undefined) delete process.env.PLAYGROUND_GATEWAY_SECRET;
      else process.env.PLAYGROUND_GATEWAY_SECRET = previousSecret;
      if (previousAudience === undefined) delete process.env.PLAYGROUND_GATEWAY_AUDIENCE;
      else process.env.PLAYGROUND_GATEWAY_AUDIENCE = previousAudience;
    }
  });

  it("does not ready the container or consume authorization before runtime preflight", async () => {
    let readyCalls = 0;
    let consumeCalls = 0;
    const unconfigured = normalizeModelRuntime({
      AUTH_RP_ID: "demo.test",
      PLAYGROUND_GATEWAY_SECRET: "origin-secret",
      NIMBLE_API_KEY: " ",
      OPENAI_API_KEY: "model-key",
    });
    await expect(admitConfiguredLiveCreate(
      unconfigured,
      async () => { readyCalls += 1; },
      async () => { consumeCalls += 1; return true; },
    )).resolves.toBe("unconfigured");
    expect(readyCalls).toBe(0);
    expect(consumeCalls).toBe(0);

    const configured = normalizeModelRuntime({
      AUTH_RP_ID: "demo.test",
      PLAYGROUND_GATEWAY_SECRET: "origin-secret",
      NIMBLE_API_KEY: "nimble-key",
      ANTHROPIC_API_KEY: "model-key",
    });
    await expect(admitConfiguredLiveCreate(
      configured,
      async () => {
        readyCalls += 1;
        throw new Error("container unavailable");
      },
      async () => { consumeCalls += 1; return true; },
    )).resolves.toBe("runtime-unready");
    expect(readyCalls).toBe(1);
    expect(consumeCalls).toBe(0);
  });

  it("preserves the existing Worker migrations and enables three auth lanes", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      name: string;
      vars: Record<string, string>;
      durable_objects: {
        bindings: Array<{ name: string; class_name: string }>;
      };
      migrations: Array<{
        tag: string;
        new_sqlite_classes?: string[];
        deleted_classes?: string[];
      }>;
    };
    expect(config.name).toBe("vercel-ai-sdk-nimble-v2-playground");
    expect(config.vars).toEqual({
      AUTH_EMPLOYEE_ENABLED: "true",
      SPEND_GRANT_EPOCH: "pr11-native-v2-review:1",
    });
    expect(config.durable_objects.bindings).not.toContainEqual(
      expect.objectContaining({ name: "CHAT_ADMISSION" }),
    );
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["AdminAuthState"] },
      { tag: "v2", new_sqlite_classes: ["ModelChatContainer"] },
      { tag: "v3", new_sqlite_classes: ["ChatAdmissionState"] },
      { tag: "v4", deleted_classes: ["ChatAdmissionState"] },
    ]);
  });

  it("reuses one stable container identity across image deployments", () => {
    expect(MODEL_CHAT_INSTANCE_NAME).toBe("model-chat-v1");
  });

  it("accepts only client-generated UUID v4 request IDs", () => {
    expect(validChatRequestId("c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60")).toBe(true);
    expect(validChatRequestId("stable-but-not-a-uuid")).toBe(false);
    expect(validChatRequestId(null)).toBe(false);
  });
});

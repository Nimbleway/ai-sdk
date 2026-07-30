import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORIGIN_ASSERTION_HEADER,
  admitConfiguredLiveCreate,
  handleCreateDiagnosticCallback,
  isAllowedUpstreamRequest,
  normalizeModelRuntime,
  protectedUpstreamRequest,
  type CreateDiagnosticState,
} from "../src/gateway";
import {
  CHAT_REQUEST_ID_HEADER,
  validChatRequestId,
} from "../src/admission";
import { MODEL_CHAT_INSTANCE_NAME } from "../src/container-name";
import { readGatewayAssertion } from "../../lib/gateway-auth";
import {
  createDiagnosticCallbackBody,
  createDiagnosticEvent,
  type CreateDiagnosticCallbackBody,
  type CreateDiagnosticEvent,
} from "../../lib/create-diagnostics";

const CALLBACK_NOW = 1_800_000_000;
const CALLBACK_SECRET = "origin-secret-callback-test";
const CALLBACK_AUDIENCE = "demo.test";
const CALLBACK_SID = "S".repeat(43);
const CALLBACK_REQUEST_ID = "c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60";
const REQUEST_CANARY = "request-canary-private-user-prompt";
const PROSE_CANARY = "prose-canary-private-provider-detail";
const HEADER_CANARY = "Bearer header-canary-private-token";
const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

async function sidDigest(sid: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(sid)),
    ),
  );
}

async function signDiagnosticPayload(
  secret: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`create-diagnostic\n${payload}`),
      ),
    ),
  );
}

function diagnosticRuntime() {
  return normalizeModelRuntime({
    AUTH_RP_ID: CALLBACK_AUDIENCE,
    PLAYGROUND_GATEWAY_SECRET: CALLBACK_SECRET,
    NIMBLE_API_KEY: "nimble-key",
    OPENAI_API_KEY: "model-key",
  });
}

function diagnosticState(accepted = true) {
  const recordCreateDiagnostic = vi.fn(
    async (
      _sidDigest: string,
      _requestId: string,
      _sequence: number,
      _event: CreateDiagnosticEvent,
      _now: number,
    ): Promise<boolean> => accepted,
  );
  const clearCreateDiagnostic = vi.fn(
    async (
      _sidDigest: string,
      _requestId: string,
      _sequence: number,
      _now: number,
    ): Promise<boolean> => accepted,
  );
  const state: CreateDiagnosticState = {
    recordCreateDiagnostic,
    clearCreateDiagnostic,
  };
  return { state, recordCreateDiagnostic, clearCreateDiagnostic };
}

function expectNoCanaries(value: unknown): void {
  const surface = JSON.stringify(value);
  expect(surface).not.toContain(REQUEST_CANARY);
  expect(surface).not.toContain(PROSE_CANARY);
  expect(surface).not.toContain(HEADER_CANARY);
}

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
          [CHAT_REQUEST_ID_HEADER]: CALLBACK_REQUEST_ID,
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
    expect(request.headers.get(CHAT_REQUEST_ID_HEADER)).toBe(
      CALLBACK_REQUEST_ID,
    );
  });

  it("records a valid signed diagnostic using only the exact safe state arguments", async () => {
    const event = createDiagnosticEvent({
      correlationId: CALLBACK_REQUEST_ID,
      phase: "provider_response",
      httpStatus: 422,
    });
    const body = await createDiagnosticCallbackBody({
      secret: CALLBACK_SECRET,
      audience: CALLBACK_AUDIENCE,
      sid: CALLBACK_SID,
      correlationId: CALLBACK_REQUEST_ID,
      sequence: 1,
      action: "record",
      event,
      now: CALLBACK_NOW,
    });
    const {
      state,
      recordCreateDiagnostic,
      clearCreateDiagnostic,
    } = diagnosticState();

    const response = await handleCreateDiagnosticCallback(
      body,
      diagnosticRuntime(),
      state,
      CALLBACK_NOW,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("");
    expect(recordCreateDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordCreateDiagnostic).toHaveBeenCalledWith(
      await sidDigest(CALLBACK_SID),
      CALLBACK_REQUEST_ID,
      1,
      event,
      CALLBACK_NOW,
    );
    expect(recordCreateDiagnostic.mock.calls[0]).toHaveLength(5);
    expect(clearCreateDiagnostic).not.toHaveBeenCalled();
    expectNoCanaries(recordCreateDiagnostic.mock.calls);
  });

  it("clears a valid signed diagnostic using only the exact safe state arguments", async () => {
    const body = await createDiagnosticCallbackBody({
      secret: CALLBACK_SECRET,
      audience: CALLBACK_AUDIENCE,
      sid: CALLBACK_SID,
      correlationId: CALLBACK_REQUEST_ID,
      sequence: 2,
      action: "clear",
      now: CALLBACK_NOW,
    });
    const {
      state,
      recordCreateDiagnostic,
      clearCreateDiagnostic,
    } = diagnosticState();

    const response = await handleCreateDiagnosticCallback(
      body,
      diagnosticRuntime(),
      state,
      CALLBACK_NOW,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("");
    expect(clearCreateDiagnostic).toHaveBeenCalledTimes(1);
    expect(clearCreateDiagnostic).toHaveBeenCalledWith(
      await sidDigest(CALLBACK_SID),
      CALLBACK_REQUEST_ID,
      2,
      CALLBACK_NOW,
    );
    expect(clearCreateDiagnostic.mock.calls[0]).toHaveLength(4);
    expect(recordCreateDiagnostic).not.toHaveBeenCalled();
    expectNoCanaries(clearCreateDiagnostic.mock.calls);
  });

  it("returns an opaque 404 without touching state for invalid signed callbacks", async () => {
    const event = createDiagnosticEvent({
      correlationId: CALLBACK_REQUEST_ID,
      phase: "provider_response",
      httpStatus: 422,
    });
    const validBody = await createDiagnosticCallbackBody({
      secret: CALLBACK_SECRET,
      audience: CALLBACK_AUDIENCE,
      sid: CALLBACK_SID,
      correlationId: CALLBACK_REQUEST_ID,
      sequence: 1,
      action: "record",
      event,
      now: CALLBACK_NOW,
    });
    const wrongAudience = await createDiagnosticCallbackBody({
      secret: CALLBACK_SECRET,
      audience: "other.test",
      sid: CALLBACK_SID,
      correlationId: CALLBACK_REQUEST_ID,
      sequence: 1,
      action: "record",
      event,
      now: CALLBACK_NOW,
    });
    const stale = await createDiagnosticCallbackBody({
      secret: CALLBACK_SECRET,
      audience: CALLBACK_AUDIENCE,
      sid: CALLBACK_SID,
      correlationId: CALLBACK_REQUEST_ID,
      sequence: 1,
      action: "record",
      event,
      now: CALLBACK_NOW - 31,
    });
    expect(
      await signDiagnosticPayload(CALLBACK_SECRET, validBody.payload),
    ).toBe(validBody.signature);
    const payloadWithExtraFields = JSON.stringify({
      ...JSON.parse(validBody.payload) as Record<string, unknown>,
      request: REQUEST_CANARY,
      prose: PROSE_CANARY,
      headers: { authorization: HEADER_CANARY },
    });
    const extraFields: CreateDiagnosticCallbackBody = {
      payload: payloadWithExtraFields,
      signature: await signDiagnosticPayload(
        CALLBACK_SECRET,
        payloadWithExtraFields,
      ),
    };
    const invalidSignature: CreateDiagnosticCallbackBody = {
      ...validBody,
      signature: `${
        validBody.signature.startsWith("A") ? "B" : "A"
      }${validBody.signature.slice(1)}`,
    };
    const cases: Array<[string, CreateDiagnosticCallbackBody]> = [
      ["signature", invalidSignature],
      ["audience", wrongAudience],
      ["stale timestamp", stale],
      ["signed extra fields", extraFields],
    ];

    for (const [name, body] of cases) {
      const {
        state,
        recordCreateDiagnostic,
        clearCreateDiagnostic,
      } = diagnosticState();
      const response = await handleCreateDiagnosticCallback(
        body,
        diagnosticRuntime(),
        state,
        CALLBACK_NOW,
      );
      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      expect(response.status, name).toBe(404);
      expect(response.headers.get("cache-control"), name).toBe("no-store");
      expect(responseBody, name).toBe("");
      expect(recordCreateDiagnostic, name).not.toHaveBeenCalled();
      expect(clearCreateDiagnostic, name).not.toHaveBeenCalled();
      expectNoCanaries({
        stateArguments: [
          recordCreateDiagnostic.mock.calls,
          clearCreateDiagnostic.mock.calls,
        ],
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
        },
      });
    }
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

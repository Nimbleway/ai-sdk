import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CREATE_DIAGNOSTIC_READ_PATH,
  CREATE_DIAGNOSTIC_RETENTION_SECONDS,
  createDiagnosticEvent,
  type CreateDiagnosticEvent,
  type CreateDiagnosticReceipt,
} from "../../model-chat/lib/create-diagnostics";
import {
  authenticate,
  type AdminAuthState,
  type AuthEnv,
} from "../src/auth";

const ORIGIN = "https://example.test";
const TEST_AGENT_KEY_ID = "test-agent-key-id";
const TEST_WORKSPACE_ID = "test-workspace";
const TEST_SESSION_SECRET = "test-session-secret-not-real";
const authNamespace = (env as unknown as AuthEnv).ADMIN_AUTH;
const CREATE_DIAGNOSTIC_STORAGE_KEY = "create-diagnostic-current";
const DIAGNOSTIC_REQUEST_ID = "c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60";
const OTHER_DIAGNOSTIC_REQUEST_ID = "d45bca83-42cb-46af-a248-03c74af09c97";
const DIAGNOSTIC_SID = "S".repeat(43);
const OTHER_DIAGNOSTIC_SID = "T".repeat(43);
const DIAGNOSTIC_GRANT = "G".repeat(43);

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

async function sidDigest(sid: string): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid)),
    ),
  );
}

async function testHmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

function isolatedAuthEnv(
  stub: DurableObjectStub<AdminAuthState>,
): AuthEnv {
  const base = env as unknown as AuthEnv;
  return {
    ...base,
    ADMIN_AUTH: {
      idFromName: () => authNamespace.newUniqueId(),
      get: () => stub,
    } as unknown as AuthEnv["ADMIN_AUTH"],
  };
}

type TestAuthSession = {
  cookieHeader: string;
  csrf: string;
  sid: string;
};

async function signedTestSession(input: {
  role: "admin" | "employee" | "agent";
  email: string;
  sid: string;
  now: number;
}): Promise<TestAuthSession> {
  const payload = {
    sid: input.sid,
    authzVersion: 1,
    authenticatedAt: input.now,
    email: input.email,
    role: input.role,
    aud: "example.test",
    expiresAt: input.now + 15 * 60,
  };
  const encoded = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const csrf = `csrf-${input.role}-${input.sid.slice(0, 4)}`;
  return {
    cookieHeader:
      `nimble_playground_session=${encoded}.` +
      `${await testHmac(TEST_SESSION_SECRET, encoded)}; ` +
      `nimble_playground_csrf=${csrf}`,
    csrf,
    sid: input.sid,
  };
}

async function registeredAgentSession(
  stub: DurableObjectStub<AdminAuthState>,
  authEnv: AuthEnv,
): Promise<TestAuthSession> {
  const token = "R".repeat(43);
  await runInDurableObject(stub, async (instance: AdminAuthState) => {
    await expect(
      instance.beginAgentActivation(
        token,
        TEST_AGENT_KEY_ID,
        "/",
        Math.floor(Date.now() / 1_000) + 60,
      ),
    ).resolves.toBe(true);
  });
  const activated = await authenticate(
    new Request(`${ORIGIN}/__agent/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
    authEnv,
  );
  expect(activated).toBeInstanceOf(Response);
  if (!(activated instanceof Response)) {
    throw new Error("expected agent activation response");
  }
  expect(activated.status).toBe(200);
  const setCookies =
    (
      activated.headers as Headers & {
        getSetCookie?: () => string[];
      }
    ).getSetCookie?.() ?? [activated.headers.get("set-cookie") ?? ""];
  const cookieHeader = setCookies
    .flatMap((value) => value.split(/,(?=\s*nimble_playground_)/))
    .map((value) => value.trim().split(";")[0])
    .join("; ");
  const csrf =
    cookieHeader.match(/nimble_playground_csrf=([^;]+)/)?.[1] ?? "";
  expect(cookieHeader).toContain("nimble_playground_session=");
  expect(csrf).toBeTruthy();

  const principal = await authenticate(
    new Request(`${ORIGIN}/version`, {
      headers: { cookie: cookieHeader },
    }),
    authEnv,
  );
  expect(principal).not.toBeInstanceOf(Response);
  if (principal instanceof Response) {
    throw new Error("expected activated agent principal");
  }
  expect(principal).toMatchObject({
    role: "agent",
    keyId: TEST_AGENT_KEY_ID,
  });
  return { cookieHeader, csrf, sid: principal.sid };
}

type DiagnosticReadFixture = {
  stub: DurableObjectStub<AdminAuthState>;
  authEnv: AuthEnv;
  session: TestAuthSession;
  receipt: CreateDiagnosticReceipt;
};

async function diagnosticReadFixture(): Promise<DiagnosticReadFixture> {
  const stub = authNamespace.get(authNamespace.newUniqueId());
  const authEnv = isolatedAuthEnv(stub);
  const session = await registeredAgentSession(stub, authEnv);
  const now = Math.floor(Date.now() / 1_000);
  const receipt: CreateDiagnosticReceipt = {
    ...createDiagnosticEvent({
      correlationId: DIAGNOSTIC_REQUEST_ID,
      phase: "provider_response",
      httpStatus: 422,
    }),
    observedAt: now,
    expiresAt: now + CREATE_DIAGNOSTIC_RETENTION_SECONDS,
  };
  await runInDurableObject(stub, async (instance: AdminAuthState, state) => {
    await expect(
      instance.issueSpendGrant(
        "diagnostic-read:1",
        session.sid,
        DIAGNOSTIC_GRANT,
        now + 5 * 60,
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      instance.consumeSpendGrant(
        "diagnostic-read:1",
        session.sid,
        DIAGNOSTIC_GRANT,
        now,
        DIAGNOSTIC_REQUEST_ID,
        now + 15 * 60,
      ),
    ).resolves.toBe(true);
    await state.storage.put(CREATE_DIAGNOSTIC_STORAGE_KEY, {
      ...receipt,
      sidDigest: await sidDigest(session.sid),
      sequence: 1,
      cleared: false,
    });
  });
  return { stub, authEnv, session, receipt };
}

function diagnosticReadRequest(
  session: Pick<TestAuthSession, "cookieHeader" | "csrf">,
  requestId = DIAGNOSTIC_REQUEST_ID,
  includeCsrf = true,
): Request {
  return new Request(`${ORIGIN}${CREATE_DIAGNOSTIC_READ_PATH}`, {
    method: "POST",
    headers: {
      cookie: session.cookieHeader,
      "content-type": "application/json",
      ...(includeCsrf ? { "x-csrf-token": session.csrf } : {}),
    },
    body: JSON.stringify({ requestId }),
  });
}

async function bindDiagnosticGrant(
  instance: AdminAuthState,
  {
    now,
    sid = DIAGNOSTIC_SID,
    grant = DIAGNOSTIC_GRANT,
    requestId = DIAGNOSTIC_REQUEST_ID,
    sessionExpiresAt = now + 30 * 60,
  }: {
    now: number;
    sid?: string;
    grant?: string;
    requestId?: string;
    sessionExpiresAt?: number;
  },
): Promise<string> {
  await expect(
    instance.issueSpendGrant("diagnostic:1", sid, grant, now + 5 * 60, now),
  ).resolves.toBe(true);
  await expect(
    instance.consumeSpendGrant(
      "diagnostic:1",
      sid,
      grant,
      now,
      requestId,
      sessionExpiresAt,
    ),
  ).resolves.toBe(true);
  return sidDigest(sid);
}

describe("three-lane hosted authentication", () => {
  it("exposes independent administrator and exact-domain employee lanes", async () => {
    const response = await SELF.fetch(`${ORIGIN}/__auth/login`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("One-time administrator bootstrap password");
    expect(body).toContain("Nimble employees");
    expect(body).toContain("Email sign-in link");
  });

  it("rejects non-Nimble email before attempting delivery", async () => {
    const login = await SELF.fetch(`${ORIGIN}/__auth/login`);
    const body = await login.text();
    const csrf = body.match(/name=csrf value="([^"]+)"/)?.[1];
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(csrf).toBeTruthy();
    expect(cookie).toBeTruthy();
    const response = await SELF.fetch(`${ORIGIN}/__auth/otp/request`, {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: csrf!, email: "attacker@example.com" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "use an official @nimbleway.com email" });
  });

  it("issues an exact canonical, audience-bound agent challenge", async () => {
    const response = await SELF.fetch(`${ORIGIN}/__agent/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next: "/version" }),
    });
    expect(response.status).toBe(200);
    const result = await response.json<{ payload: string; challenge_token: string }>();
    const payload = JSON.parse(result.payload);
    expect(Object.keys(payload)).toEqual([
      "v", "kid", "nonce", "iat", "exp", "origin", "next", "workspace_id",
    ]);
    expect(payload).toMatchObject({
      v: 1,
      kid: TEST_AGENT_KEY_ID,
      origin: ORIGIN,
      next: "/version",
      workspace_id: TEST_WORKSPACE_ID,
    });
    expect(payload.exp - payload.iat).toBe(60);
    expect(result.challenge_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects extra challenge fields and altered signatures", async () => {
    const extra = await SELF.fetch(`${ORIGIN}/__agent/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next: "/", descriptor: "copied" }),
    });
    expect(extra.status).toBe(400);

    const challenge = await SELF.fetch(`${ORIGIN}/__agent/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next: "/version" }),
    }).then((response) => response.json<{ payload: string; challenge_token: string }>());
    const rejected = await SELF.fetch(`${ORIGIN}/__agent/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...challenge,
        signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "agent proof was rejected" });
  });

  it("fails closed at nonce capacity without evicting a live replay guard", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stub = authNamespace.get(authNamespace.newUniqueId());
    await runInDurableObject(stub, async (instance: AdminAuthState, state) => {
      const active = Array.from({ length: 64 }, (_, index) => ({
        nonce: `active-${index}`,
        expiresAt: now + 60,
      }));
      await state.storage.put("used-agent-nonces", active);
      await expect(
        instance.consumeAgentNonce("capacity-overflow", now + 60, now),
      ).resolves.toBe(false);
      await expect(
        instance.consumeAgentNonce("active-0", now + 60, now),
      ).resolves.toBe(false);
      expect(await state.storage.get("used-agent-nonces")).toEqual(active);
    });
  });

  it("fails closed at activation capacity without evicting live activations", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stub = authNamespace.get(authNamespace.newUniqueId());
    await runInDurableObject(stub, async (instance: AdminAuthState, state) => {
      for (let index = 0; index < 8; index += 1) {
        await expect(
          instance.beginAgentActivation(
            String(index).padEnd(43, "A"),
            "key-id",
            "/",
            now + 60,
            now,
          ),
        ).resolves.toBe(true);
      }
      await expect(
        instance.beginAgentActivation("overflow".padEnd(43, "A"), "key-id", "/", now + 60, now),
      ).resolves.toBe(false);
      expect(await state.storage.get<unknown[]>("agent-activations")).toHaveLength(8);
    });
  });

  it("bounds OTP challenges in one expiring collection and fails closed at capacity", async () => {
    const now = 1_000;
    const stub = authNamespace.get(authNamespace.newUniqueId());
    await runInDurableObject(stub, async (instance: AdminAuthState, state) => {
      for (let index = 0; index < 128; index += 1) {
        await expect(
          instance.beginOtp(
            `employee-${index}@nimbleway.com`,
            `code-${index}`,
            `magic-${index}`,
            now,
          ),
        ).resolves.toMatchObject({ accepted: true, capacity: false });
      }
      await expect(
        instance.beginOtp(
          "overflow@nimbleway.com",
          "overflow-code",
          "overflow-magic",
          now,
        ),
      ).resolves.toMatchObject({ accepted: false, capacity: true });
      expect(await state.storage.get<unknown[]>("otp-challenges")).toHaveLength(128);

      await expect(
        instance.beginOtp(
          "after-expiry@nimbleway.com",
          "fresh-code",
          "fresh-magic",
          now + 601,
        ),
      ).resolves.toMatchObject({ accepted: true, capacity: false });
      expect(await state.storage.get<unknown[]>("otp-challenges")).toHaveLength(1);
    });
  });

  it("issues one explicit epoch budget and atomically consumes it once", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stub = authNamespace.get(authNamespace.newUniqueId());
    await runInDurableObject(stub, async (instance: AdminAuthState) => {
      const sid = "S".repeat(43);
      const grant = "G".repeat(43);
      await expect(
        instance.issueSpendGrant("test:1", sid, grant, now + 60, now),
      ).resolves.toBe(true);
      await expect(
        instance.issueSpendGrant("test:1", "T".repeat(43), "H".repeat(43), now + 60, now),
      ).resolves.toBe(false);
      const concurrent = await Promise.all([
        instance.consumeSpendGrant("test:1", sid, grant, now),
        instance.consumeSpendGrant("test:1", sid, grant, now),
      ]);
      expect(concurrent.sort()).toEqual([false, true]);
      await expect(
        instance.consumeSpendGrant("test:1", "T".repeat(43), grant, now),
      ).resolves.toBe(false);
      await expect(
        instance.issueSpendGrant(
          "test:2",
          "T".repeat(43),
          "H".repeat(43),
          now + 60,
          now,
        ),
      ).resolves.toBe(true);
      await expect(
        instance.issueSpendGrant(
          "test:1",
          "U".repeat(43),
          "I".repeat(43),
          now + 60,
          now,
        ),
      ).resolves.toBe(false);
    });
  });

  describe("principal-scoped create diagnostics", () => {
    it("binds only after chat-grant consumption and isolates SID and request lookups", async () => {
      const now = 10_000;
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await sidDigest(DIAGNOSTIC_SID);
          const otherDigest = await sidDigest(OTHER_DIAGNOSTIC_SID);
          const event = createDiagnosticEvent({
            correlationId: DIAGNOSTIC_REQUEST_ID,
            phase: "provider_response",
            httpStatus: 422,
          });

          await expect(
            instance.issueSpendGrant(
              "diagnostic:1",
              DIAGNOSTIC_SID,
              DIAGNOSTIC_GRANT,
              now + 5 * 60,
              now,
            ),
          ).resolves.toBe(true);
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(false);
          expect(
            await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
          ).toBeUndefined();

          await expect(
            instance.consumeSpendGrant(
              "diagnostic:1",
              DIAGNOSTIC_SID,
              DIAGNOSTIC_GRANT,
              now,
              DIAGNOSTIC_REQUEST_ID,
              now + 15 * 60,
            ),
          ).resolves.toBe(true);
          await expect(
            instance.recordCreateDiagnostic(
              otherDigest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(false);
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              OTHER_DIAGNOSTIC_REQUEST_ID,
              1,
              createDiagnosticEvent({
                correlationId: OTHER_DIAGNOSTIC_REQUEST_ID,
                phase: "provider_response",
                httpStatus: 422,
              }),
              now,
            ),
          ).resolves.toBe(false);
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(true);

          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              now,
            ),
          ).resolves.toMatchObject({
            kind: "receipt",
            receipt: {
              ...event,
              observedAt: now,
              expiresAt: now + CREATE_DIAGNOSTIC_RETENTION_SECONDS,
            },
          });
          await expect(
            instance.readCreateDiagnostic(
              OTHER_DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              now,
            ),
          ).resolves.toEqual({ kind: "denied" });
          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              OTHER_DIAGNOSTIC_REQUEST_ID,
              now,
            ),
          ).resolves.toEqual({ kind: "denied" });
          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              now,
            ),
          ).resolves.toMatchObject({
            kind: "receipt",
            receipt: event,
          });
        },
      );
    });

    it("allows phase upgrades but rejects downgrades and conflicting terminal phases", async () => {
      const now = 20_000;
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(stub, async (instance: AdminAuthState) => {
        const digest = await bindDiagnosticGrant(instance, { now });
        const preNetwork = createDiagnosticEvent({
          correlationId: DIAGNOSTIC_REQUEST_ID,
          phase: "pre_network_rejection",
          localReason: "sdk_local_rejection",
        });
        const outbound = createDiagnosticEvent({
          correlationId: DIAGNOSTIC_REQUEST_ID,
          phase: "outbound_post_attempt",
        });
        const response = createDiagnosticEvent({
          correlationId: DIAGNOSTIC_REQUEST_ID,
          phase: "provider_response",
          httpStatus: 429,
        });
        const ambiguous = createDiagnosticEvent({
          correlationId: DIAGNOSTIC_REQUEST_ID,
          phase: "transport_ambiguity",
        });

        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            1,
            preNetwork,
            now,
          ),
        ).resolves.toBe(true);
        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            2,
            outbound,
            now + 1,
          ),
        ).resolves.toBe(true);
        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            1,
            response,
            now + 2,
          ),
        ).resolves.toBe(false);
        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            3,
            preNetwork,
            now + 2,
          ),
        ).resolves.toBe(false);
        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            4,
            response,
            now + 2,
          ),
        ).resolves.toBe(true);
        await expect(
          instance.recordCreateDiagnostic(
            digest,
            DIAGNOSTIC_REQUEST_ID,
            5,
            ambiguous,
            now + 3,
          ),
        ).resolves.toBe(false);

        await expect(
          instance.readCreateDiagnostic(
            DIAGNOSTIC_SID,
            DIAGNOSTIC_REQUEST_ID,
            now + 3,
          ),
        ).resolves.toMatchObject({
          kind: "receipt",
          receipt: {
            phase: "provider_response",
            httpStatus: 429,
            observedAt: now + 2,
          },
        });
      });
    });

    it("replaces a bound receipt with an invisible replay-blocking tombstone", async () => {
      const now = 30_000;
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await bindDiagnosticGrant(instance, { now });
          const event = createDiagnosticEvent({
            correlationId: DIAGNOSTIC_REQUEST_ID,
            phase: "outbound_post_attempt",
          });
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(true);
          expect(await state.storage.getAlarm()).not.toBeNull();

          await expect(
            instance.clearCreateDiagnostic(
              await sidDigest(OTHER_DIAGNOSTIC_SID),
              DIAGNOSTIC_REQUEST_ID,
              2,
              now,
            ),
          ).resolves.toBe(false);
          expect(
            await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
          ).toBeDefined();

          await expect(
            instance.clearCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              2,
              now,
            ),
          ).resolves.toBe(true);
          await expect(
            state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
          ).resolves.toMatchObject({
            sidDigest: digest,
            correlationId: DIAGNOSTIC_REQUEST_ID,
            sequence: 2,
            cleared: true,
            observedAt: now,
            expiresAt: now + CREATE_DIAGNOSTIC_RETENTION_SECONDS,
          });
          expect(await state.storage.getAlarm()).not.toBeNull();
          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              now,
            ),
          ).resolves.toEqual({ kind: "none" });
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now + 1,
            ),
          ).resolves.toBe(false);
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              3,
              createDiagnosticEvent({
                correlationId: DIAGNOSTIC_REQUEST_ID,
                phase: "provider_response",
                httpStatus: 202,
              }),
              now + 1,
            ),
          ).resolves.toBe(false);
        },
      );
    });

    it("stores a success tombstone even without a prior receipt and expires it by alarm", async () => {
      const now = Math.floor(Date.now() / 1_000);
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await bindDiagnosticGrant(instance, { now });
          await expect(
            instance.clearCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              now,
            ),
          ).resolves.toBe(true);
          const stored = await state.storage.get<Record<string, unknown>>(
            CREATE_DIAGNOSTIC_STORAGE_KEY,
          );
          if (!stored) throw new Error("expected diagnostic tombstone");
          expect(stored).toMatchObject({
            correlationId: DIAGNOSTIC_REQUEST_ID,
            sequence: 1,
            cleared: true,
          });
          await state.storage.put(CREATE_DIAGNOSTIC_STORAGE_KEY, {
            ...stored,
            expiresAt: Math.floor(Date.now() / 1_000),
          });
        },
      );

      await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
        ).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      });
    });

    it("rejects at the exact expiry boundary and physically deletes the record", async () => {
      const now = 40_000;
      const sessionExpiresAt = now + 30;
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await bindDiagnosticGrant(instance, {
            now,
            sessionExpiresAt,
          });
          const event = createDiagnosticEvent({
            correlationId: DIAGNOSTIC_REQUEST_ID,
            phase: "transport_ambiguity",
          });
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(true);
          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              sessionExpiresAt - 1,
            ),
          ).resolves.toMatchObject({
            kind: "receipt",
            receipt: { expiresAt: sessionExpiresAt },
          });
          await expect(
            instance.readCreateDiagnostic(
              DIAGNOSTIC_SID,
              DIAGNOSTIC_REQUEST_ID,
              sessionExpiresAt,
            ),
          ).resolves.toEqual({ kind: "denied" });
          expect(
            await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
          ).toBeUndefined();
        },
      );
    });

    it("physically deletes an expired receipt when the Durable Object alarm runs", async () => {
      const now = Math.floor(Date.now() / 1_000);
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await bindDiagnosticGrant(instance, { now });
          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              createDiagnosticEvent({
                correlationId: DIAGNOSTIC_REQUEST_ID,
                phase: "provider_response",
                httpStatus: 503,
              }),
              now,
            ),
          ).resolves.toBe(true);
          const stored = await state.storage.get<Record<string, unknown>>(
            CREATE_DIAGNOSTIC_STORAGE_KEY,
          );
          expect(stored).toBeDefined();
          await state.storage.put(CREATE_DIAGNOSTIC_STORAGE_KEY, {
            ...stored,
            expiresAt: Math.floor(Date.now() / 1_000),
          });
        },
      );

      await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
        ).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      });
    });

    it("stores only the allowlisted receipt schema, a SID digest, and no canaries", async () => {
      const now = 50_000;
      const stub = authNamespace.get(authNamespace.newUniqueId());
      await runInDurableObject(
        stub,
        async (instance: AdminAuthState, state) => {
          const digest = await bindDiagnosticGrant(instance, { now });
          const event = createDiagnosticEvent({
            correlationId: DIAGNOSTIC_REQUEST_ID,
            phase: "provider_response",
            httpStatus: 422,
          });
          const canaries = [
            "nimble-api-key-canary",
            "Bearer authorization-canary",
            "session-cookie-canary",
            "request prose canary",
            "result prose canary",
            "hidden reasoning canary",
          ];
          const unsafeEvent = {
            ...event,
            apiKey: canaries[0],
            authorization: canaries[1],
            cookie: canaries[2],
            requestProse: canaries[3],
            resultProse: canaries[4],
            hiddenReasoning: canaries[5],
          } as unknown as CreateDiagnosticEvent;

          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              unsafeEvent,
              now,
            ),
          ).resolves.toBe(false);
          expect(
            await state.storage.get(CREATE_DIAGNOSTIC_STORAGE_KEY),
          ).toBeUndefined();

          await expect(
            instance.recordCreateDiagnostic(
              digest,
              DIAGNOSTIC_REQUEST_ID,
              1,
              event,
              now,
            ),
          ).resolves.toBe(true);
          const stored = await state.storage.get<Record<string, unknown>>(
            CREATE_DIAGNOSTIC_STORAGE_KEY,
          );
          expect(stored).toBeDefined();
          expect(Object.keys(stored!).sort()).toEqual([
            "cleared",
            "correlationId",
            "expiresAt",
            "httpStatus",
            "observedAt",
            "phase",
            "providerPostAttempted",
            "providerResponseReceived",
            "retryCreateAutomatically",
            "schema",
            "sequence",
            "sidDigest",
          ]);
          expect(stored?.sidDigest).toBe(digest);
          expect(stored?.sidDigest).not.toBe(DIAGNOSTIC_SID);
          const serialized = JSON.stringify(stored);
          expect(serialized).not.toContain(DIAGNOSTIC_SID);
          expect(serialized).not.toContain(DIAGNOSTIC_GRANT);
          for (const canary of canaries) {
            expect(serialized).not.toContain(canary);
          }
        },
      );
    });

    it("returns the exact receipt only to its registered agent with private no-store", async () => {
      const fixture = await diagnosticReadFixture();
      const response = await authenticate(
        diagnosticReadRequest(fixture.session),
        fixture.authEnv,
      );
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        throw new Error("expected diagnostic read response");
      }
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        diagnostic: fixture.receipt,
      });
    });

    it("returns an authenticated empty 204 when no durable receipt exists", async () => {
      const fixture = await diagnosticReadFixture();
      await runInDurableObject(fixture.stub, async (_instance, state) => {
        await state.storage.delete(CREATE_DIAGNOSTIC_STORAGE_KEY);
        await state.storage.deleteAlarm();
      });

      const response = await authenticate(
        diagnosticReadRequest(fixture.session),
        fixture.authEnv,
      );
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        throw new Error("expected empty diagnostic response");
      }
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.text()).resolves.toBe("");
    });

    it("requires CSRF for the registered agent diagnostic read", async () => {
      const fixture = await diagnosticReadFixture();
      const response = await authenticate(
        diagnosticReadRequest(fixture.session, DIAGNOSTIC_REQUEST_ID, false),
        fixture.authEnv,
      );
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        throw new Error("expected diagnostic CSRF response");
      }
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "invalid csrf",
      });
    });

    it("returns one opaque 404 for other roles, SIDs, and request IDs", async () => {
      const fixture = await diagnosticReadFixture();
      const now = Math.floor(Date.now() / 1_000);
      const sessions = [
        await signedTestSession({
          role: "admin",
          email: "admin@example.test",
          sid: "A".repeat(43),
          now,
        }),
        await signedTestSession({
          role: "employee",
          email: "reader@nimbleway.com",
          sid: "E".repeat(43),
          now,
        }),
        await signedTestSession({
          role: "agent",
          email: `agent:${TEST_AGENT_KEY_ID}`,
          sid: OTHER_DIAGNOSTIC_SID,
          now,
        }),
      ];
      const requests = [
        ...sessions.map((session) => diagnosticReadRequest(session)),
        diagnosticReadRequest(
          fixture.session,
          OTHER_DIAGNOSTIC_REQUEST_ID,
        ),
      ];

      for (const request of requests) {
        const response = await authenticate(request, fixture.authEnv);
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) {
          throw new Error("expected opaque diagnostic denial");
        }
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: "not found",
        });
      }
    });
  });

  it("keeps activation material in the fragment and rejects malformed tokens", async () => {
    const page = await SELF.fetch(`${ORIGIN}/__agent/activate`);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    const body = await page.text();
    expect(body).toContain("location.hash.slice(1)");
    expect(body).toContain("history.replaceState");

    const rejected = await SELF.fetch(`${ORIGIN}/__agent/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    });
    expect(rejected.status).toBe(400);
  });

  it("gives an activated agent both session and CSRF cookies for protected posts", async () => {
    const token = "A".repeat(43);
    const keyId = TEST_AGENT_KEY_ID;
    const stub = authNamespace.get(authNamespace.idFromName("admin"));
    await runInDurableObject(stub, async (instance: AdminAuthState) => {
      await instance.beginAgentActivation(
        token,
        keyId,
        "/",
        Math.floor(Date.now() / 1000) + 60,
      );
    });

    const activated = await SELF.fetch(`${ORIGIN}/__agent/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(activated.status).toBe(200);

    const setCookies =
      (activated.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [activated.headers.get("set-cookie") ?? ""];
    const cookieHeader = setCookies
      .flatMap((value) => value.split(/,(?=\s*nimble_playground_)/))
      .map((value) => value.trim().split(";")[0])
      .join("; ");
    const csrf = cookieHeader.match(/nimble_playground_csrf=([^;]+)/)?.[1];
    expect(cookieHeader).toContain("nimble_playground_session=");
    expect(csrf).toBeTruthy();

    const principal = await authenticate(
      new Request(`${ORIGIN}/api/chat`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrf!,
        },
      }),
      env as unknown as AuthEnv,
    );
    expect(principal).toMatchObject({ email: `agent:${keyId}`, role: "agent", keyId });
    expect(principal).not.toBeInstanceOf(Response);
    if (principal instanceof Response) throw new Error("expected an authenticated principal");
    expect(principal.sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(principal.spendGrant).toBeUndefined();

    const authorized = await authenticate(
      new Request(`${ORIGIN}/__auth/spend/authorize`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json",
          "x-csrf-token": csrf!,
        },
        body: JSON.stringify({
          integration: "vercel-ai-sdk-agent-v2",
          effortCeiling: "low",
          createLimit: 1,
        }),
      }),
      env as unknown as AuthEnv,
    );
    expect(authorized).toBeInstanceOf(Response);
    expect((authorized as Response).status).toBe(200);
    const spendCookie = (authorized as Response).headers
      .get("set-cookie")
      ?.split(";")[0];
    expect(spendCookie).toMatch(/^nimble_playground_spend=/);
    const authorizedCookies = `${cookieHeader}; ${spendCookie}`;
    const authorizedPrincipal = await authenticate(
      new Request(`${ORIGIN}/api/chat`, {
        method: "POST",
        headers: {
          cookie: authorizedCookies,
          "x-csrf-token": csrf!,
        },
      }),
      env as unknown as AuthEnv,
    );
    expect(authorizedPrincipal).not.toBeInstanceOf(Response);
    if (authorizedPrincipal instanceof Response) {
      throw new Error("expected an explicitly authorized principal");
    }
    expect(authorizedPrincipal.spendGrant).toMatchObject({
      integration: "vercel-ai-sdk-agent-v2",
      effortCeiling: "low",
      createLimit: 1,
    });

    const sessionOnly = cookieHeader
      .split("; ")
      .filter((value) => value.startsWith("nimble_playground_session="))
      .join("; ");
    const missingCsrf = await authenticate(
      new Request(`${ORIGIN}/api/chat`, {
        method: "POST",
        headers: { cookie: sessionOnly },
      }),
      env as unknown as AuthEnv,
    );
    expect(missingCsrf).toBeInstanceOf(Response);
    expect((missingCsrf as Response).status).toBe(403);

    const logout = await authenticate(
      new Request(`${ORIGIN}/__auth/logout`, {
        method: "POST",
        headers: {
          cookie: authorizedCookies,
          "x-csrf-token": csrf!,
        },
      }),
      env as unknown as AuthEnv,
    );
    expect(logout).toBeInstanceOf(Response);
    expect((logout as Response).status).toBe(303);

    const copiedSession = await authenticate(
      new Request(`${ORIGIN}/version`, {
        headers: { cookie: sessionOnly },
      }),
      env as unknown as AuthEnv,
    );
    expect(copiedSession).toBeInstanceOf(Response);
    expect((copiedSession as Response).status).toBe(303);
  });
});

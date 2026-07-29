import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authenticate,
  type AdminAuthState,
  type AuthEnv,
} from "../src/auth";

const ORIGIN = "https://vercel-ai-sdk-nimble-v2-playground.kadosh.workers.dev";
const authNamespace = (env as unknown as AuthEnv).ADMIN_AUTH;

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
      kid: "e1720965dfcdfb07992ce256",
      origin: ORIGIN,
      next: "/version",
      workspace_id: "vercel-ai-sdk-nimble-v2-playground",
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
    const keyId = "e1720965dfcdfb07992ce256";
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

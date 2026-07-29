import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://vercel-ai-sdk-nimble-v2-playground.kadosh.workers.dev";

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
});

import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

/**
 * The single administrator this deployment authorizes, read from the
 * `ADMIN_EMAIL` secret. Deliberately not hard-coded: a checked-in address is a
 * personal detail in a public repo, and it would also make the Worker
 * un-authorizable for anyone deploying their own copy.
 */
export function adminEmail(env: AuthEnv): string {
  const email = env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("ADMIN_EMAIL is not configured as a Worker secret.");
  return email;
}
const SESSION = "nimble_playground_session";
const BOOTSTRAP = "nimble_playground_bootstrap";
const CSRF = "nimble_playground_csrf";
const SESSION_SECONDS = 12 * 60 * 60;
const BOOTSTRAP_SECONDS = 10 * 60;

export interface AuthEnv {
  ADMIN_AUTH: DurableObjectNamespace<AdminAuthState>;
  /** The only identity this deployment authorizes. Required. */
  ADMIN_EMAIL?: string;
  ADMIN_PASSKEY?: string;
  ADMIN_SESSION_SECRET?: string;
  AUTH_RP_ID?: string;
}

interface StoredCredential {
  id: string;
  publicKey: number[];
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

export class AdminAuthState extends DurableObject<AuthEnv> {
  async hasPasskey(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get("credential"));
  }
  async registrationOptions(rpID: string) {
    if (await this.hasPasskey()) throw new Error("A passkey is already registered");
    const options = await generateRegistrationOptions({
      rpName: "Nimble Integration Playground",
      rpID,
      userName: adminEmail(this.env),
      userDisplayName: "Kobi Kadosh",
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await this.ctx.storage.put("registrationChallenge", options.challenge);
    return options;
  }
  async completeRegistration(response: RegistrationResponseJSON, rpID: string, origin: string) {
    if (await this.hasPasskey()) throw new Error("A passkey is already registered");
    const challenge = await this.ctx.storage.get<string>("registrationChallenge");
    if (!challenge) throw new Error("Registration challenge expired");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) throw new Error("Registration failed");
    const credential = result.registrationInfo.credential;
    await this.ctx.storage.put("credential", {
      id: credential.id,
      publicKey: Array.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    } satisfies StoredCredential);
    await this.ctx.storage.delete("registrationChallenge");
  }
  async authenticationOptions(rpID: string) {
    const credential = await this.ctx.storage.get<StoredCredential>("credential");
    if (!credential) throw new Error("No passkey is registered");
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: [{ id: credential.id, transports: credential.transports }],
    });
    await this.ctx.storage.put("authenticationChallenge", options.challenge);
    return options;
  }
  async completeAuthentication(response: AuthenticationResponseJSON, rpID: string, origin: string) {
    const credential = await this.ctx.storage.get<StoredCredential>("credential");
    const challenge = await this.ctx.storage.get<string>("authenticationChallenge");
    if (!credential || !challenge) throw new Error("Authentication challenge expired");
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      } satisfies WebAuthnCredential,
    });
    if (!result.verified) throw new Error("Authentication failed");
    credential.counter = result.authenticationInfo.newCounter;
    await this.ctx.storage.put("credential", credential);
    await this.ctx.storage.delete("authenticationChallenge");
  }
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (value: string) => {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value))));
}
function same(a: string, b: string): boolean {
  const aa = enc.encode(a), bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
async function signedCookie(name: string, secret: string, payload: object, seconds: number) {
  const data = b64(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, data);
  return `${name}=${data}.${sig}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
async function readSigned<T>(request: Request, name: string, secret: string): Promise<T | null> {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  if (!match) return null;
  const [data, sig] = match[1]!.split(".");
  if (!data || !sig || !same(await hmac(secret, data), sig)) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64(data))) as T; } catch { return null; }
}
function csrf(request: Request): string | null {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${CSRF}=([^;]+)`))?.[1] ?? null;
}
function csrfCookie(value: string) {
  return `${CSRF}=${value}; Max-Age=${SESSION_SECONDS}; Path=/; Secure; SameSite=Strict`;
}
function clear(name: string) {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
function page(body: string, token: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Nimble playground login</title><style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:1rem;color:#163126}button,input{width:100%;padding:.8rem;margin:.5rem 0;box-sizing:border-box}button{background:#087848;color:white;border:0;border-radius:7px}</style><h1>Protected Nimble playground</h1><p>Kobi-only administrator access.</p>${body}`, {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8", "set-cookie": csrfCookie(token) },
  });
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json", ...extra } });
}
function webauthnScript(mode: "register" | "authenticate", token: string) {
  return `<button id=passkey>${mode === "register" ? "Register passkey" : "Sign in with passkey"}</button><pre id=error></pre><script>
const b=v=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(v.length/4)*4,'=')),c=>c.charCodeAt(0));
const s=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
passkey.onclick=async()=>{try{let o=await fetch('/__auth/${mode}/options',{headers:{'x-csrf-token':'${token}'}}).then(r=>r.json());o.challenge=b(o.challenge);${mode === "register" ? "o.user.id=b(o.user.id);o.excludeCredentials=(o.excludeCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.create({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),attestationObject:s(c.response.attestationObject),transports:c.response.getTransports?.()||[]},clientExtensionResults:c.getClientExtensionResults()};" : "o.allowCredentials=(o.allowCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.get({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),authenticatorData:s(c.response.authenticatorData),signature:s(c.response.signature),userHandle:c.response.userHandle?s(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults()};"}let r=await fetch('/__auth/${mode}/verify',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'${token}'},body:JSON.stringify(body)});if(!r.ok)throw Error((await r.json()).error);location='/';}catch(e){error.textContent=e.message}}</script>`;
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Response | { email: string }> {
  if (!env.ADMIN_PASSKEY || !env.ADMIN_SESSION_SECRET || !env.ADMIN_EMAIL) {
    return json({ error: "auth secrets are not configured" }, 503);
  }
  const admin = adminEmail(env);
  const url = new URL(request.url);
  const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
  const rpID = env.AUTH_RP_ID || url.hostname;
  const origin = url.origin;
  const token = csrf(request) || b64(crypto.getRandomValues(new Uint8Array(24)));
  const validCsrf = () => request.headers.get("x-csrf-token") === csrf(request);
  const session = await readSigned<{ email: string; exp: number }>(request, SESSION, env.ADMIN_SESSION_SECRET);
  if (session?.email === admin && session.exp > Date.now()) {
    if (url.pathname === "/__auth/logout" && request.method === "POST") {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/login", "set-cookie": clear(SESSION) } });
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/api/")) &&
      !validCsrf()
    ) {
      return json({ error: "invalid csrf" }, 403);
    }
    if (url.pathname === "/__auth/status") return json({ authenticated: true, email: admin });
    return { email: admin };
  }
  const hasPasskey = await state.hasPasskey();
  if (url.pathname === "/__auth/bootstrap" && request.method === "POST") {
    const body = await request.formData();
    if (hasPasskey || String(body.get("csrf") || "") !== csrf(request)) return json({ error: "bootstrap unavailable" }, 403);
    if (!same(String(body.get("password") || ""), env.ADMIN_PASSKEY)) return page(`<p>Incorrect temporary password.</p><form method=post action=/__auth/bootstrap><input type=hidden name=csrf value="${token}"><input type=password name=password><button>Continue</button></form>`, token, 401);
    return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/setup", "set-cookie": await signedCookie(BOOTSTRAP, env.ADMIN_SESSION_SECRET, { email: admin, exp: Date.now() + BOOTSTRAP_SECONDS * 1000 }, BOOTSTRAP_SECONDS) } });
  }
  const boot = await readSigned<{ email: string; exp: number }>(request, BOOTSTRAP, env.ADMIN_SESSION_SECRET);
  if (url.pathname === "/__auth/register/options" && request.method === "GET") {
    if (!validCsrf() || hasPasskey || boot?.email !== admin || boot.exp < Date.now()) return json({ error: "not authorized" }, 403);
    return json(await state.registrationOptions(rpID));
  }
  if (url.pathname === "/__auth/register/verify" && request.method === "POST") {
    if (!validCsrf() || hasPasskey || boot?.email !== admin || boot.exp < Date.now()) return json({ error: "not authorized" }, 403);
    try { await state.completeRegistration(await request.json() as RegistrationResponseJSON, rpID, origin); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "registration failed" }, 400); }
    return json({ verified: true }, 200, { "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, { email: admin, exp: Date.now() + SESSION_SECONDS * 1000 }, SESSION_SECONDS) });
  }
  if (url.pathname === "/__auth/authenticate/options" && request.method === "GET") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    return json(await state.authenticationOptions(rpID));
  }
  if (url.pathname === "/__auth/authenticate/verify" && request.method === "POST") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    try { await state.completeAuthentication(await request.json() as AuthenticationResponseJSON, rpID, origin); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "authentication failed" }, 401); }
    return json({ verified: true }, 200, { "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, { email: admin, exp: Date.now() + SESSION_SECONDS * 1000 }, SESSION_SECONDS) });
  }
  if (url.pathname === "/__auth/setup" && !hasPasskey && boot?.email === admin && boot.exp > Date.now()) return page(webauthnScript("register", token), token);
  if (url.pathname === "/__auth/status") return json({ authenticated: false }, 401);
  if (url.pathname === "/__auth/login" || url.pathname === "/") {
    return hasPasskey
      ? page(webauthnScript("authenticate", token), token)
      : page(`<form method=post action=/__auth/bootstrap><input type=hidden name=csrf value="${token}"><label>One-time administrator bootstrap password</label><input type=password name=password autocomplete=current-password><button>Continue</button></form>`, token);
  }
  if (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
  return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/login" } });
}

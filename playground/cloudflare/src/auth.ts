import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
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
const OTP_SECONDS = 10 * 60;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 6;
const AUTH_EMAIL_ADDRESS = "login@auth.kadosh.dev";
const AGENT_CHALLENGE_SECONDS = 60;
const AGENT_SESSION_SECONDS = 15 * 60;

export interface AuthEnv {
  ADMIN_AUTH: DurableObjectNamespace<AdminAuthState>;
  /** The only identity this deployment authorizes. Required. */
  ADMIN_EMAIL?: string;
  ADMIN_PASSKEY?: string;
  ADMIN_SESSION_SECRET?: string;
  AUTH_RP_ID?: string;
  AUTH_ADMIN_ONLY?: string;
  AUTH_EMAIL?: { send(message: EmailMessage): Promise<unknown> };
  AGENT_AUTH_PUBLIC_KEY?: string;
  AGENT_AUTH_KEY_ID?: string;
  AGENT_AUTH_WORKSPACE_ID?: string;
}

interface OtpChallenge {
  codeDigest: string;
  magicDigest: string;
  expiresAt: number;
  attemptsRemaining: number;
  lastSentAt: number;
}

interface StoredCredential {
  id: string;
  publicKey: number[];
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

interface AgentActivation {
  tokenDigest: string;
  keyId: string;
  next: string;
  expiresAt: number;
}

interface AuthSession {
  email: string;
  role: "admin" | "employee" | "agent";
  aud: string;
  expiresAt: number;
}

export class AdminAuthState extends DurableObject<AuthEnv> {
  async consumeAgentNonce(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    const key = "used-agent-nonces";
    const existing = (await this.ctx.storage.get<{ nonce: string; expiresAt: number }[]>(key)) || [];
    const active = existing.filter((entry) => entry.expiresAt >= now);
    if (active.some((entry) => same(entry.nonce, nonce))) return false;
    active.push({ nonce, expiresAt });
    await this.ctx.storage.put(key, active.slice(-64));
    return true;
  }
  async beginAgentActivation(token: string, keyId: string, next: string, expiresAt: number) {
    const key = "agent-activations";
    const existing = (await this.ctx.storage.get<AgentActivation[]>(key)) || [];
    const active = existing.filter((entry) => entry.expiresAt >= Math.floor(Date.now() / 1000));
    active.push({ tokenDigest: await digest(token), keyId, next, expiresAt });
    await this.ctx.storage.put(key, active.slice(-8));
  }
  async consumeAgentActivation(token: string, now: number): Promise<AgentActivation | null> {
    const key = "agent-activations";
    const existing = (await this.ctx.storage.get<AgentActivation[]>(key)) || [];
    const tokenDigest = await digest(token);
    const index = existing.findIndex((entry) => entry.expiresAt >= now && same(entry.tokenDigest, tokenDigest));
    if (index < 0) {
      await this.ctx.storage.put(key, existing.filter((entry) => entry.expiresAt >= now));
      return null;
    }
    const [activation] = existing.splice(index, 1);
    await this.ctx.storage.put(key, existing.filter((entry) => entry.expiresAt >= now));
    return activation || null;
  }
  private async credentials(): Promise<StoredCredential[]> {
    const current = await this.ctx.storage.get<StoredCredential[]>("credentials");
    if (current) return current;
    const legacy = await this.ctx.storage.get<StoredCredential>("credential");
    return legacy ? [legacy] : [];
  }
  async beginOtp(email: string, codeDigest: string, magicDigest: string, now: number) {
    const key = `otp:${await digest(email)}`;
    const existing = await this.ctx.storage.get<OtpChallenge>(key);
    if (existing && now - existing.lastSentAt < OTP_RESEND_SECONDS) {
      return { accepted: false, retryAfter: OTP_RESEND_SECONDS - (now - existing.lastSentAt) };
    }
    await this.ctx.storage.put(key, {
      codeDigest, magicDigest, expiresAt: now + OTP_SECONDS,
      attemptsRemaining: OTP_MAX_ATTEMPTS, lastSentAt: now,
    } satisfies OtpChallenge);
    return { accepted: true, retryAfter: 0 };
  }
  async verifyOtp(email: string, codeDigest: string, now: number) {
    const key = `otp:${await digest(email)}`;
    const challenge = await this.ctx.storage.get<OtpChallenge>(key);
    if (!challenge || challenge.expiresAt < now || challenge.attemptsRemaining <= 0) {
      await this.ctx.storage.delete(key);
      return false;
    }
    if (!same(challenge.codeDigest, codeDigest)) {
      challenge.attemptsRemaining -= 1;
      await this.ctx.storage.put(key, challenge);
      return false;
    }
    await this.ctx.storage.delete(key);
    return true;
  }
  async verifyMagicLink(email: string, magicDigest: string, now: number) {
    const key = `otp:${await digest(email)}`;
    const challenge = await this.ctx.storage.get<OtpChallenge>(key);
    if (!challenge || challenge.expiresAt < now || !same(challenge.magicDigest, magicDigest)) {
      if (!challenge || challenge.expiresAt < now) await this.ctx.storage.delete(key);
      return false;
    }
    await this.ctx.storage.delete(key);
    return true;
  }
  async clearOtp(email: string) {
    await this.ctx.storage.delete(`otp:${await digest(email)}`);
  }
  async hasPasskey(): Promise<boolean> {
    return (await this.credentials()).length > 0;
  }
  async registrationOptions(rpID: string, addBackup = false) {
    const credentials = await this.credentials();
    if (credentials.length && !addBackup) throw new Error("A passkey is already registered");
    const options = await generateRegistrationOptions({
      rpName: "Nimble Integration Playground",
      rpID,
      userName: adminEmail(this.env),
      userDisplayName: "Kobi Kadosh",
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
    });
    await this.ctx.storage.put("registrationChallenge", options.challenge);
    return options;
  }
  async completeRegistration(response: RegistrationResponseJSON, rpID: string, origin: string, addBackup = false) {
    const credentials = await this.credentials();
    if (credentials.length && !addBackup) throw new Error("A passkey is already registered");
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
    const stored = {
      id: credential.id,
      publicKey: Array.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    } satisfies StoredCredential;
    await this.ctx.storage.put("credentials", [...credentials, stored]);
    await this.ctx.storage.delete("credential");
    await this.ctx.storage.delete("registrationChallenge");
  }
  async authenticationOptions(rpID: string) {
    const credentials = await this.credentials();
    if (!credentials.length) throw new Error("No passkey is registered");
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports })),
    });
    await this.ctx.storage.put("authenticationChallenge", options.challenge);
    return options;
  }
  async completeAuthentication(response: AuthenticationResponseJSON, rpID: string, origin: string) {
    const credentials = await this.credentials();
    const credential = credentials.find((candidate) => candidate.id === response.id);
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
    await this.ctx.storage.put("credentials", credentials.map((candidate) => candidate.id === credential.id ? credential : candidate));
    await this.ctx.storage.delete("credential");
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
async function digest(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
function same(a: string, b: string): boolean {
  const aa = enc.encode(a), bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
function safeNext(value: unknown): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid") return "/";
    const next = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return next.startsWith("/__") ? "/" : next;
  } catch {
    return "/";
  }
}
function canonicalAgentPayload(fields: {
  v: number; kid: string; nonce: string; iat: number; exp: number;
  origin: string; next: string; workspace_id: string;
}) {
  return JSON.stringify({
    v: fields.v, kid: fields.kid, nonce: fields.nonce, iat: fields.iat, exp: fields.exp,
    origin: fields.origin, next: fields.next, workspace_id: fields.workspace_id,
  });
}
async function verifyAgentSignature(publicKey: string, payload: string, signature: string) {
  try {
    const key = await crypto.subtle.importKey(
      "raw", unb64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, unb64(signature), enc.encode(payload),
    );
  } catch {
    return false;
  }
}
async function readAuthSession(
  request: Request,
  secret: string,
  audience: string,
  admin: string,
  allowEmployees: boolean,
  agentKeyId?: string,
  agentPublicKey?: string,
): Promise<AuthSession | null> {
  const session = await readSigned<AuthSession>(request, SESSION, secret);
  if (!session || session.aud !== audience || session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (session.role === "admin" && session.email === admin) return session;
  if (allowEmployees && session.role === "employee" && employeeEmail(session.email) === session.email) return session;
  if (session.role === "agent" && agentPublicKey && agentKeyId &&
      session.email === `agent:${agentKeyId}`) return session;
  return null;
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
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Nimble playground login</title><style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:1rem;color:#163126}button,input{width:100%;padding:.8rem;margin:.5rem 0;box-sizing:border-box}button{background:#087848;color:white;border:0;border-radius:7px}</style><h1>Protected Nimble playground</h1><p>Use administrator passkey, Nimble employee email, or the registered local agent identity.</p>${body}`, {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8", "set-cookie": csrfCookie(token) },
  });
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json", ...extra } });
}
function agentActivationPage(): Response {
  const nonce = randomToken();
  const script = `const p=new URLSearchParams(location.hash.slice(1));const token=p.get('token')||'';history.replaceState(null,'','/__agent/activate');fetch('/__agent/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error||'Agent sign-in failed');location=b.next||'/';}).catch(e=>document.querySelector('p').textContent=e.message);`;
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Nimble agent sign-in</title><p>Verifying single-use agent authentication…</p><script nonce="${nonce}">${script}</script>`,
    { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } },
  );
}
function employeeMagicPage(token: string): Response {
  const nonce = randomToken();
  const script = `const p=new URLSearchParams(location.hash.slice(1));const body=new URLSearchParams({csrf:${JSON.stringify(token)},email:p.get('email')||'',token:p.get('token')||''});history.replaceState(null,'','/__auth/magic');fetch('/__auth/magic/verify',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body}).then(async r=>{if(r.redirected)location=r.url;else throw Error(await r.text());}).catch(e=>document.querySelector('p').textContent=e.message);`;
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Nimble employee sign-in</title><p>Verifying single-use employee authentication…</p><script nonce="${nonce}">${script}</script>`,
    { headers: { ...headers, "content-type": "text/html; charset=utf-8", "set-cookie": csrfCookie(token), "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } },
  );
}
function webauthnScript(mode: "register" | "authenticate", token: string) {
  return `<button id=passkey>${mode === "register" ? "Register passkey" : "Sign in with passkey"}</button><pre id=error></pre><script>
const b=v=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(v.length/4)*4,'=')),c=>c.charCodeAt(0));
const s=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
passkey.onclick=async()=>{try{let o=await fetch('/__auth/${mode}/options',{headers:{'x-csrf-token':'${token}'}}).then(r=>r.json());o.challenge=b(o.challenge);${mode === "register" ? "o.user.id=b(o.user.id);o.excludeCredentials=(o.excludeCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.create({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),attestationObject:s(c.response.attestationObject),transports:c.response.getTransports?.()||[]},clientExtensionResults:c.getClientExtensionResults()};" : "o.allowCredentials=(o.allowCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.get({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),authenticatorData:s(c.response.authenticatorData),signature:s(c.response.signature),userHandle:c.response.userHandle?s(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults()};"}let r=await fetch('/__auth/${mode}/verify',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'${token}'},body:JSON.stringify(body)});if(!r.ok)throw Error((await r.json()).error);location='/';}catch(e){error.textContent=e.message}}</script>`;
}

export function employeeAuthEnabled(env: AuthEnv): boolean {
  return env.AUTH_ADMIN_ONLY !== "true";
}
function employeeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@nimbleway\.com$/.test(email) ? email : null;
}
function otpCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0]! % 1_000_000).padStart(6, "0");
}
function magicToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
async function sendLoginEmail(binding: NonNullable<AuthEnv["AUTH_EMAIL"]>, email: string, code: string, token: string, origin: string) {
  const link = `${origin}/__auth/magic#email=${encodeURIComponent(email)}&token=${token}`;
  const raw = [
    `From: Nimble Agent Playground <${AUTH_EMAIL_ADDRESS}>`,
    `To: ${email}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@auth.kadosh.dev>`,
    "Subject: Your Nimble sign-in code",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Auto-Submitted: auto-generated",
    "",
    `Open this single-use magic link: ${link}`,
    "",
    `Or enter this six-digit code: ${code}`,
    "",
    "This sign-in expires in 10 minutes.",
  ].join("\r\n");
  await binding.send(new EmailMessage(AUTH_EMAIL_ADDRESS, email, raw));
}
function employeeForms(token: string): string {
  return `<hr><p>Nimble employees can receive a single-use code or magic link.</p><form method=post action=/__auth/otp/request><input type=hidden name=csrf value="${token}"><label>Work email</label><input name=email type=email autocomplete=email required><button>Email sign-in link</button></form>`;
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Response | { email: string; role: AuthSession["role"]; keyId?: string }> {
  if (!env.ADMIN_PASSKEY || !env.ADMIN_SESSION_SECRET || !env.ADMIN_EMAIL) {
    return json({ error: "auth secrets are not configured" }, 503);
  }
  const admin = adminEmail(env);
  const url = new URL(request.url);
  const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
  const rpID = env.AUTH_RP_ID || url.hostname;
  const origin = url.origin;
  const agentOrigin = `https://${rpID}`;
  const token = csrf(request) || b64(crypto.getRandomValues(new Uint8Array(24)));
  const validCsrf = () => request.headers.get("x-csrf-token") === csrf(request);
  const adminOnly = !employeeAuthEnabled(env);
  const now = Math.floor(Date.now() / 1000);

  if (url.pathname === "/__agent/challenge" && request.method === "POST") {
    if (!env.AGENT_AUTH_PUBLIC_KEY || !env.AGENT_AUTH_KEY_ID || !env.AGENT_AUTH_WORKSPACE_ID) {
      return json({ error: "agent authentication is not configured" }, 503);
    }
    const body = await request.json().catch(() => ({})) as { next?: string };
    if (Object.keys(body).some((key) => key !== "next")) return json({ error: "invalid challenge request" }, 400);
    const payload = canonicalAgentPayload({
      v: 1, kid: env.AGENT_AUTH_KEY_ID, nonce: randomToken(), iat: now,
      exp: now + AGENT_CHALLENGE_SECONDS, origin: agentOrigin,
      next: safeNext(body.next), workspace_id: env.AGENT_AUTH_WORKSPACE_ID,
    });
    return json({ payload, challenge_token: await hmac(env.ADMIN_SESSION_SECRET, `agent-challenge\n${payload}`) });
  }
  if (url.pathname === "/__agent/exchange" && request.method === "POST") {
    if (!env.AGENT_AUTH_PUBLIC_KEY || !env.AGENT_AUTH_KEY_ID || !env.AGENT_AUTH_WORKSPACE_ID) {
      return json({ error: "agent authentication is not configured" }, 503);
    }
    const body = await request.json().catch(() => ({})) as {
      payload?: string; signature?: string; challenge_token?: string;
    };
    if (typeof body.payload !== "string" || typeof body.signature !== "string" ||
        typeof body.challenge_token !== "string" || body.payload.length > 2048 ||
        body.signature.length > 256 || body.challenge_token.length > 128 ||
        Object.keys(body).some((key) => !["payload", "signature", "challenge_token"].includes(key))) {
      return json({ error: "invalid agent proof" }, 400);
    }
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(body.payload) as Record<string, unknown>; }
    catch { return json({ error: "invalid agent proof" }, 400); }
    const expected = canonicalAgentPayload({
      v: 1, kid: env.AGENT_AUTH_KEY_ID, nonce: String(fields.nonce || ""),
      iat: Number(fields.iat), exp: Number(fields.exp), origin: agentOrigin,
      next: safeNext(fields.next), workspace_id: env.AGENT_AUTH_WORKSPACE_ID,
    });
    const exp = Number(fields.exp), iat = Number(fields.iat), nonce = String(fields.nonce || "");
    if (body.payload !== expected || !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        exp < now || exp > now + AGENT_CHALLENGE_SECONDS ||
        iat < now - AGENT_CHALLENGE_SECONDS || iat > now + 5) {
      return json({ error: "expired or invalid agent proof" }, 401);
    }
    if (!same(body.challenge_token, await hmac(env.ADMIN_SESSION_SECRET, `agent-challenge\n${body.payload}`)) ||
        !await verifyAgentSignature(env.AGENT_AUTH_PUBLIC_KEY, body.payload, body.signature)) {
      return json({ error: "agent proof was rejected" }, 401);
    }
    if (!await state.consumeAgentNonce(nonce, exp, now)) return json({ error: "agent proof was already used" }, 401);
    const activation = randomToken();
    await state.beginAgentActivation(activation, env.AGENT_AUTH_KEY_ID, safeNext(fields.next), now + AGENT_CHALLENGE_SECONDS);
    return json({ activation_url: `${agentOrigin}/__agent/activate#token=${activation}` });
  }
  if (url.pathname === "/__agent/activate" && request.method === "GET") return agentActivationPage();
  if (url.pathname === "/__agent/activate" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as { token?: string };
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      return json({ error: "invalid agent activation" }, 400);
    }
    const activation = await state.consumeAgentActivation(body.token, now);
    if (!activation) return json({ error: "agent activation is invalid, expired, or already used" }, 401);
    return json({ authenticated: true, next: activation.next }, 200, {
      "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, {
        email: `agent:${activation.keyId}`, role: "agent", aud: rpID,
        expiresAt: now + AGENT_SESSION_SECONDS,
      }, AGENT_SESSION_SECONDS),
    });
  }

  const session = await readAuthSession(
    request,
    env.ADMIN_SESSION_SECRET,
    rpID,
    admin,
    !adminOnly,
    env.AGENT_AUTH_KEY_ID,
    env.AGENT_AUTH_PUBLIC_KEY,
  );
  if (session) {
    if (session.role === "admin" && url.pathname === "/__auth/passkeys/add" && request.method === "GET") {
      return page(webauthnScript("register", token).replaceAll("/__auth/register/", "/__auth/passkeys/add/"), token);
    }
    if (session.role === "admin" && url.pathname === "/__auth/passkeys/add/options" && request.method === "GET") {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      return json(await state.registrationOptions(rpID, true));
    }
    if (session.role === "admin" && url.pathname === "/__auth/passkeys/add/verify" && request.method === "POST") {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      try { await state.completeRegistration(await request.json() as RegistrationResponseJSON, rpID, origin, true); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "registration failed" }, 400); }
      return json({ verified: true });
    }
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
    if (url.pathname === "/__auth/status") return json({
      authenticated: true, role: session.role,
      email: session.role === "agent" ? undefined : session.email,
      keyId: session.role === "agent" ? session.email.slice("agent:".length) : undefined,
      expiresAt: session.expiresAt,
    });
    return {
      email: session.email,
      role: session.role,
      keyId: session.role === "agent" ? session.email.slice("agent:".length) : undefined,
    };
  }
  const hasPasskey = await state.hasPasskey();
  if (url.pathname.startsWith("/__auth/passkeys/add")) return json({ error: "not authorized" }, 403);
  if (adminOnly && (url.pathname.startsWith("/__auth/otp/") || url.pathname.startsWith("/__auth/magic"))) {
    return json({ error: "not found" }, 404);
  }
  if (url.pathname === "/__auth/otp/request" && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    if (!env.AUTH_EMAIL) return json({ error: "employee email authentication is not configured" }, 503);
    const email = employeeEmail(String(form.get("email") || ""));
    if (!email) return json({ error: "use an official @nimbleway.com email" }, 400);
    const code = otpCode();
    const linkToken = magicToken();
    const now = Math.floor(Date.now() / 1000);
    const started = await state.beginOtp(
      email,
      await hmac(env.ADMIN_SESSION_SECRET, `otp\n${email}\n${code}`),
      await hmac(env.ADMIN_SESSION_SECRET, `magic\n${email}\n${linkToken}`),
      now,
    );
    if (!started.accepted) return json({ error: "code already sent", retryAfter: started.retryAfter }, 429);
    try { await sendLoginEmail(env.AUTH_EMAIL, email, code, linkToken, agentOrigin); }
    catch { await state.clearOtp(email); return json({ error: "login email could not be delivered" }, 502); }
    return page(`<p>Check ${email} for a code or magic link.</p><form method=post action=/__auth/otp/verify><input type=hidden name=csrf value="${token}"><input type=hidden name=email value="${email}"><input name=code inputmode=numeric pattern="[0-9]{6}" required><button>Verify code</button></form>`, token);
  }
  if (url.pathname === "/__auth/otp/verify" && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    const email = employeeEmail(String(form.get("email") || ""));
    const code = String(form.get("code") || "").replace(/\D/g, "");
    if (!email || !/^\d{6}$/.test(code)) return json({ error: "invalid email or code" }, 400);
    const ok = await state.verifyOtp(email, await hmac(env.ADMIN_SESSION_SECRET, `otp\n${email}\n${code}`), Math.floor(Date.now() / 1000));
    if (!ok) return json({ error: "invalid or expired code" }, 401);
    return new Response(null, { status: 303, headers: { ...headers, location: "/", "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, {
      email, role: "employee", aud: rpID, expiresAt: now + SESSION_SECONDS,
    }, SESSION_SECONDS) } });
  }
  if (url.pathname === "/__auth/magic" && request.method === "GET") {
    return employeeMagicPage(token);
  }
  if (url.pathname === "/__auth/magic/verify" && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    const email = employeeEmail(String(form.get("email") || ""));
    const linkToken = String(form.get("token") || "");
    if (!email || !/^[A-Za-z0-9_-]{43}$/.test(linkToken)) return json({ error: "invalid magic link" }, 400);
    const ok = await state.verifyMagicLink(email, await hmac(env.ADMIN_SESSION_SECRET, `magic\n${email}\n${linkToken}`), Math.floor(Date.now() / 1000));
    if (!ok) return json({ error: "invalid or expired magic link" }, 401);
    return new Response(null, { status: 303, headers: { ...headers, location: "/", "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, {
      email, role: "employee", aud: rpID, expiresAt: now + SESSION_SECONDS,
    }, SESSION_SECONDS) } });
  }
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
    return json({ verified: true }, 200, { "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, {
      email: admin, role: "admin", aud: rpID, expiresAt: now + SESSION_SECONDS,
    }, SESSION_SECONDS) });
  }
  if (url.pathname === "/__auth/authenticate/options" && request.method === "GET") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    return json(await state.authenticationOptions(rpID));
  }
  if (url.pathname === "/__auth/authenticate/verify" && request.method === "POST") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    try { await state.completeAuthentication(await request.json() as AuthenticationResponseJSON, rpID, origin); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "authentication failed" }, 401); }
    return json({ verified: true }, 200, { "set-cookie": await signedCookie(SESSION, env.ADMIN_SESSION_SECRET, {
      email: admin, role: "admin", aud: rpID, expiresAt: now + SESSION_SECONDS,
    }, SESSION_SECONDS) });
  }
  if (url.pathname === "/__auth/setup" && !hasPasskey && boot?.email === admin && boot.exp > Date.now()) return page(webauthnScript("register", token), token);
  if (url.pathname === "/__auth/status") return json({ authenticated: false }, 401);
  if (url.pathname === "/__auth/login" || url.pathname === "/") {
    return hasPasskey
      ? page(`${webauthnScript("authenticate", token)}${adminOnly ? "" : employeeForms(token)}`, token)
      : page(`<form method=post action=/__auth/bootstrap><input type=hidden name=csrf value="${token}"><label>One-time administrator bootstrap password</label><input type=password name=password autocomplete=current-password><button>Continue</button></form>${adminOnly ? "" : employeeForms(token)}`, token);
  }
  if (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
  return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/login" } });
}

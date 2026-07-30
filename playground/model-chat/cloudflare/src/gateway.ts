import {
  verifyDiagnosticCallbackBody,
  type CreateDiagnosticCallbackBody,
  type CreateDiagnosticEvent,
} from "../../lib/create-diagnostics";

export const ORIGIN_ASSERTION_HEADER = "x-playground-origin-assertion";
const LEGACY_ORIGIN_AUTH_HEADER = "x-playground-gateway-auth";
const encoder = new TextEncoder();

export interface ModelRuntimeEnvironment {
  AUTH_RP_ID?: string;
  PLAYGROUND_GATEWAY_SECRET?: string;
  NIMBLE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}

export interface NormalizedModelRuntime {
  audience?: string;
  originSecret?: string;
  nimbleApiKey?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
  providerConfigured: boolean;
}

const configured = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

export function normalizeModelRuntime(
  env: ModelRuntimeEnvironment,
): NormalizedModelRuntime {
  const runtime = {
    audience: configured(env.AUTH_RP_ID),
    originSecret: configured(env.PLAYGROUND_GATEWAY_SECRET),
    nimbleApiKey: configured(env.NIMBLE_API_KEY),
    openaiApiKey: configured(env.OPENAI_API_KEY),
    openaiModel: configured(env.OPENAI_MODEL),
    anthropicApiKey: configured(env.ANTHROPIC_API_KEY),
    anthropicModel: configured(env.ANTHROPIC_MODEL),
    openrouterApiKey: configured(env.OPENROUTER_API_KEY),
    openrouterModel: configured(env.OPENROUTER_MODEL),
  };
  return {
    ...runtime,
    providerConfigured: Boolean(
      runtime.openaiApiKey ||
      runtime.anthropicApiKey ||
      runtime.openrouterApiKey
    ),
  };
}

export type LiveCreateAdmission =
  | "authorized"
  | "unconfigured"
  | "runtime-unready"
  | "unavailable";

export async function admitConfiguredLiveCreate(
  runtime: NormalizedModelRuntime,
  ensureReady: () => Promise<void>,
  consume: () => Promise<boolean>,
): Promise<LiveCreateAdmission> {
  if (!runtime.nimbleApiKey || !runtime.providerConfigured) return "unconfigured";
  try {
    await ensureReady();
  } catch {
    return "runtime-unready";
  }
  return await consume() ? "authorized" : "unavailable";
}

export interface CreateDiagnosticState {
  recordCreateDiagnostic(
    sidDigest: string,
    requestId: string,
    sequence: number,
    event: CreateDiagnosticEvent,
    now: number,
  ): Promise<boolean>;
  clearCreateDiagnostic(
    sidDigest: string,
    requestId: string,
    sequence: number,
    now: number,
  ): Promise<boolean>;
}

export async function handleCreateDiagnosticCallback(
  body: CreateDiagnosticCallbackBody | null,
  runtime: NormalizedModelRuntime,
  state: CreateDiagnosticState,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  if (!body || !runtime.originSecret || !runtime.audience) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const callback = await verifyDiagnosticCallbackBody({
    body,
    secret: runtime.originSecret,
    audience: runtime.audience,
    now,
  });
  if (!callback) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  let accepted = false;
  if (callback.action === "record") {
    if (callback.event) {
      accepted = await state.recordCreateDiagnostic(
        callback.sidDigest,
        callback.correlationId,
        callback.sequence,
        callback.event,
        now,
      );
    }
  } else {
    accepted = await state.clearCreateDiagnostic(
      callback.sidDigest,
      callback.correlationId,
      callback.sequence,
      now,
    );
  }
  return new Response(null, {
    status: accepted ? 204 : 404,
    headers: { "cache-control": "no-store" },
  });
}

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function originAssertion(
  secret: string,
  principal: {
    role: "admin" | "employee" | "agent";
    sid: string;
    audience: string;
  },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1_000);
  const encoded = b64(encoder.encode(JSON.stringify({
    role: principal.role,
    sid: principal.sid,
    aud: principal.audience,
    iat,
    exp: iat + 30,
  })));
  return `${encoded}.${await sign(secret, encoded)}`;
}

export function isAllowedUpstreamRequest(request: Request): boolean {
  if (request.headers.has("upgrade")) return false;
  const { pathname } = new URL(request.url);
  if (pathname === "/api/chat") return request.method === "POST";
  if (
    pathname === "/" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/_next/")
  ) {
    return request.method === "GET" || request.method === "HEAD";
  }
  return false;
}

export async function protectedUpstreamRequest(
  request: Request,
  originSecret: string,
  principal: {
    role: "admin" | "employee" | "agent";
    sid: string;
    audience: string;
  },
): Promise<Request> {
  const headers = new Headers(request.headers);
  // Strip all browser-controlled authorization material before adding the
  // server-only origin credential after session verification.
  headers.delete(LEGACY_ORIGIN_AUTH_HEADER);
  headers.delete(ORIGIN_ASSERTION_HEADER);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-nimble-api-key");
  headers.delete("x-playground-auth-email");
  headers.delete("x-playground-auth-role");
  headers.delete("x-playground-auth-key-id");
  headers.set(
    ORIGIN_ASSERTION_HEADER,
    await originAssertion(originSecret, principal),
  );
  return new Request(request, { headers });
}

import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
  type NimbleAgentRunIdInput,
  type NimbleAgentStartRunInput,
} from "@nimble-way/ai-sdk";
import { AdminAuthState, authenticate, type AuthEnv } from "./auth";
import { BUILD_MANIFEST } from "./manifest";
import { safeErrorResponse } from "./errors";
import { enforceLiveLowEffort } from "./live-policy";

interface Env extends AuthEnv {
  ASSETS: Fetcher;
  NIMBLE_API_KEY?: string;
}
export { AdminAuthState };

const jsonHeaders = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function apiKey(request: Request, env: Env): string {
  const override = request.headers.get("x-nimble-api-key")?.trim();
  const selected = override || env.NIMBLE_API_KEY;
  if (!selected) throw new Error("No Nimble API key is configured");
  return selected;
}

type Executable = {
  execute?: (
    input: never,
    options: { toolCallId: string; messages: never[] },
  ) => unknown | PromiseLike<unknown> | AsyncIterable<unknown>;
};

async function execute(tool: Executable, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("The Vercel AI SDK tool is not executable");
  const result = tool.execute(input as never, {
    toolCallId: crypto.randomUUID(),
    messages: [],
  });
  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    throw new Error("Streaming tool execution is not supported by this lifecycle controller");
  }
  return Promise.resolve(result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const trustedHeaders = new Headers(request.headers);
    trustedHeaders.delete("authorization");
    trustedHeaders.set("x-playground-auth-email", auth.email);
    request = new Request(request, { headers: trustedHeaders });

    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        authenticated: true,
        integration: "@nimble-way/ai-sdk",
        agentApi: "v2",
        serverKeyConfigured: Boolean(env.NIMBLE_API_KEY),
      });
    }

    // Provenance: proves which reviewed package state and SDK this deployment
    // was built from, so a running Worker can be matched back to the PR.
    if (url.pathname === "/version") {
      return json(BUILD_MANIFEST);
    }

    // The passkey gateway above already authenticated the single configured
    // administrator and rewrote the trusted identity header; this re-checks it
    // against the same configured value rather than a hard-coded address.
    if (url.pathname.startsWith("/api/")) {
      if (
        !env.ADMIN_EMAIL ||
        request.headers.get("x-playground-auth-email") !== env.ADMIN_EMAIL.trim()
      ) {
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const key = apiKey(request, env);
        if (url.pathname === "/api/start") {
          const agentId =
            typeof body.agentId === "string" && body.agentId.trim()
              ? body.agentId.trim()
              : undefined;
          return json(
            await execute(
              nimbleAgentStartRun({ apiKey: key, ...(agentId ? { agentId } : {}) }),
              enforceLiveLowEffort(body.input as NimbleAgentStartRunInput),
            ),
          );
        }
        const input = body.input as NimbleAgentRunIdInput;
        if (url.pathname === "/api/status") {
          return json(await execute(nimbleAgentRunStatus({ apiKey: key }), input));
        }
        if (url.pathname === "/api/result") {
          return json(await execute(nimbleAgentRunResult({ apiKey: key }), input));
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        return safeErrorResponse(error, json);
      }
    }

    const asset = await env.ASSETS.fetch(request);
    const assetHeaders = new Headers(asset.headers);
    // The UI is behind a per-user session; never let an intermediary cache a
    // successfully authenticated response and replay it to another request.
    assetHeaders.set("cache-control", "private, no-store");
    assetHeaders.set("x-content-type-options", "nosniff");
    assetHeaders.set("referrer-policy", "no-referrer");
    assetHeaders.set(
      "content-security-policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: assetHeaders,
    });
  },
} satisfies ExportedHandler<Env>;

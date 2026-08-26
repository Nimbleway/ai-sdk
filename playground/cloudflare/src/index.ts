import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
  type NimbleAgentRunIdInput,
  type NimbleAgentStartRunInput,
} from "@nimble-way/ai-sdk";
import {
  AdminAuthState,
  authenticate,
  readBoundedJson,
  type AuthEnv,
} from "./auth";
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

function apiKey(env: Env): string {
  const configured = env.NIMBLE_API_KEY?.trim();
  if (!configured) throw new Error("No Nimble API key is configured");
  return configured;
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
    trustedHeaders.delete("x-nimble-api-key");
    trustedHeaders.delete("x-playground-auth-email");
    trustedHeaders.delete("x-playground-auth-role");
    trustedHeaders.delete("x-playground-auth-key-id");
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

    // The gateway above has authenticated one of the three independent
    // principals. Identity stays at the edge and is not forwarded downstream.
    if (url.pathname.startsWith("/api/")) {
      if (!["admin", "employee", "agent"].includes(auth.role)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      try {
        const body = await readBoundedJson<Record<string, unknown>>(
          request,
          64 * 1_024,
        );
        if (!body) return json({ error: "invalid or oversized request body" }, 400);
        const key = apiKey(env);
        if (url.pathname === "/api/start") {
          const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
          if (!auth.spendGrant) {
            return json({ error: "explicit one-run authorization required" }, 403);
          }
          if (!await state.consumeSpendGrantAndReserveDirectRun(
            auth.spendGrant.epoch,
            auth.sid,
            auth.spendGrant.grantId,
            auth.expiresAt,
            Math.floor(Date.now() / 1000),
          )) {
            return json(
              { error: "the one-run authorization or ownership capacity is unavailable; no run was created" },
              409,
            );
          }
          const agentId =
            typeof body.agentId === "string" && body.agentId.trim()
              ? body.agentId.trim()
              : undefined;
          const created = await execute(
            nimbleAgentStartRun({ apiKey: key, ...(agentId ? { agentId } : {}) }),
            enforceLiveLowEffort(body.input as NimbleAgentStartRunInput),
          );
          const record = created && typeof created === "object"
            ? created as Record<string, unknown>
            : {};
          const runId = typeof record.runId === "string" ? record.runId : "";
          const createdAgentId =
            typeof record.agentId === "string" ? record.agentId : "";
          if (!await state.bindDirectRunOwner(
            auth.spendGrant.epoch,
            auth.sid,
            runId,
            createdAgentId,
            Math.floor(Date.now() / 1000),
          )) {
            return json(
              {
                error: "created run ownership could not be recorded",
                ...(runId ? { runId } : {}),
                ...(createdAgentId ? { agentId: createdAgentId } : {}),
              },
              500,
            );
          }
          return json(created);
        }
        const input = body.input as NimbleAgentRunIdInput;
        const inputRecord = input && typeof input === "object"
          ? input as unknown as Record<string, unknown>
          : {};
        const runId = typeof inputRecord.runId === "string" ? inputRecord.runId : "";
        const agentId = typeof inputRecord.agentId === "string" ? inputRecord.agentId : "";
        const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
        if (!await state.ownsDirectRun(
          auth.sid,
          runId,
          agentId,
          Math.floor(Date.now() / 1000),
        )) {
          return json({ error: "run not found for this session" }, 404);
        }
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

import { Container } from "@cloudflare/containers";
import {
  AdminAuthState,
  authenticate,
  readBoundedJson,
  type AuthEnv,
} from "../../../cloudflare/src/auth";
import {
  admitConfiguredLiveCreate,
  isAllowedUpstreamRequest,
  normalizeModelRuntime,
  protectedUpstreamRequest,
  type ModelRuntimeEnvironment,
} from "./gateway";
import {
  CHAT_REQUEST_ID_HEADER,
  validChatRequestId,
} from "./admission";
import { MODEL_CHAT_INSTANCE_NAME } from "./container-name";

interface Env extends AuthEnv, ModelRuntimeEnvironment {
  MODEL_CHAT: DurableObjectNamespace<ModelChatContainer>;
}

export { AdminAuthState };

export class ModelChatContainer extends Container<Env> {
  defaultPort = 3211;
  requiredPorts = [3211];
  sleepAfter = "30m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const runtime = normalizeModelRuntime(env);
    this.envVars = {
      PLAYGROUND_GATEWAY_SECRET: runtime.originSecret || "",
      PLAYGROUND_GATEWAY_AUDIENCE: runtime.audience || "",
      ...(runtime.nimbleApiKey ? { NIMBLE_API_KEY: runtime.nimbleApiKey } : {}),
      ...(runtime.openaiApiKey ? { OPENAI_API_KEY: runtime.openaiApiKey } : {}),
      ...(runtime.openaiModel ? { OPENAI_MODEL: runtime.openaiModel } : {}),
      ...(runtime.anthropicApiKey ? { ANTHROPIC_API_KEY: runtime.anthropicApiKey } : {}),
      ...(runtime.anthropicModel ? { ANTHROPIC_MODEL: runtime.anthropicModel } : {}),
      ...(runtime.openrouterApiKey
        ? { OPENROUTER_API_KEY: runtime.openrouterApiKey }
        : {}),
      ...(runtime.openrouterModel
        ? { OPENROUTER_MODEL: runtime.openrouterModel }
        : {}),
    };
  }

  async ensureReady(): Promise<void> {
    await this.startAndWaitForPorts(this.requiredPorts, {
      portReadyTimeoutMS: 90_000,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runtime = normalizeModelRuntime(env);
    if (!runtime.originSecret || !runtime.audience) {
      return new Response("Origin authentication is not configured.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const url = new URL(request.url);
    if (!isAllowedUpstreamRequest(request)) {
      const knownPath =
        url.pathname === "/api/chat" ||
        url.pathname === "/" ||
        url.pathname === "/favicon.ico" ||
        url.pathname.startsWith("/_next/");
      return Response.json(
        { error: knownPath ? "Method not allowed." : "Not found." },
        {
          status: knownPath ? 405 : 404,
          headers: { "cache-control": "no-store" },
        },
      );
    }
    const container = env.MODEL_CHAT.getByName(MODEL_CHAT_INSTANCE_NAME);
    let containerReady = false;
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const requestId = request.headers.get(CHAT_REQUEST_ID_HEADER);
      if (!validChatRequestId(requestId)) {
        return Response.json(
          { error: "A valid chat request ID is required." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      const body = await readBoundedJson<{ messages?: unknown }>(request, 64 * 1_024);
      if (!body || !Array.isArray(body.messages) || body.messages.length > 100) {
        return Response.json(
          { error: "The chat request body is invalid or exceeds 64 KiB." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      if (!auth.spendGrant) {
        return Response.json(
          { error: "An explicit one-run authorization is required." },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
      const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
      const admission = await admitConfiguredLiveCreate(
        runtime,
        () => container.ensureReady(),
        () => state.consumeSpendGrant(
          auth.spendGrant!.epoch,
          auth.sid,
          auth.spendGrant!.grantId,
          Math.floor(Date.now() / 1000),
        ),
      );
      if (admission === "unconfigured") {
        return Response.json(
          { error: "The live model and Nimble runtime are not configured." },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      if (admission === "runtime-unready") {
        return Response.json(
          { error: "The model chat runtime is not ready." },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      if (admission === "unavailable") {
        return Response.json(
          { error: "The configured one-run authorization is unavailable or was already used." },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
      containerReady = true;
      const boundedHeaders = new Headers(request.headers);
      boundedHeaders.delete("content-length");
      request = new Request(request.url, {
        method: "POST",
        headers: boundedHeaders,
        body: JSON.stringify(body),
      });
    }

    if (!containerReady) {
      try {
        await container.ensureReady();
      } catch {
        return Response.json(
          { error: "The model chat runtime is not ready." },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
    return container.fetch(
      await protectedUpstreamRequest(
        request,
        runtime.originSecret,
        {
          role: auth.role,
          sid: auth.sid,
          audience: runtime.audience,
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;

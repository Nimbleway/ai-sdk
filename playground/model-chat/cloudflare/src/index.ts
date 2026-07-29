import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import {
  AdminAuthState,
  authenticate,
  type AuthEnv,
} from "../../../cloudflare/src/auth";
import { protectedUpstreamRequest } from "./gateway";
import {
  CHAT_REQUEST_ID_HEADER,
  admitOnce,
  validChatRequestId,
} from "./admission";

interface Env extends AuthEnv {
  MODEL_CHAT: DurableObjectNamespace<ModelChatContainer>;
  CHAT_ADMISSION: DurableObjectNamespace<ChatAdmissionState>;
  PLAYGROUND_GATEWAY_SECRET?: string;
  NIMBLE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}

export { AdminAuthState };

export class ChatAdmissionState extends DurableObject<Env> {
  async admit(): Promise<boolean> {
    return admitOnce(this.ctx.storage);
  }
}

export class ModelChatContainer extends Container<Env> {
  defaultPort = 3211;
  requiredPorts = [3211];
  sleepAfter = "30m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      PLAYGROUND_GATEWAY_SECRET: env.PLAYGROUND_GATEWAY_SECRET || "",
      ...(env.NIMBLE_API_KEY ? { NIMBLE_API_KEY: env.NIMBLE_API_KEY } : {}),
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.OPENAI_MODEL ? { OPENAI_MODEL: env.OPENAI_MODEL } : {}),
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: env.ANTHROPIC_MODEL } : {}),
      ...(env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY } : {}),
      ...(env.OPENROUTER_MODEL ? { OPENROUTER_MODEL: env.OPENROUTER_MODEL } : {}),
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
    if (!env.PLAYGROUND_GATEWAY_SECRET) {
      return new Response("Origin authentication is not configured.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const principal = auth.email;

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const requestId = request.headers.get(CHAT_REQUEST_ID_HEADER);
      if (!validChatRequestId(requestId)) {
        return Response.json(
          { error: "A valid chat request ID is required." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      const admission = env.CHAT_ADMISSION.getByName(
        `${principal}\n${requestId}`,
      );
      if (!(await admission.admit())) {
        return Response.json(
          { error: "This chat request was already admitted and will not be retried." },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
    }

    const container = env.MODEL_CHAT.getByName("model-chat-v1");
    await container.ensureReady();
    return container.fetch(
      protectedUpstreamRequest(
        request,
        env.PLAYGROUND_GATEWAY_SECRET,
        principal,
      ),
    );
  },
} satisfies ExportedHandler<Env>;

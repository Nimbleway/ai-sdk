import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  validateUIMessages,
  type UIMessage,
} from 'ai';
import { buildAgentTools } from '../../../lib/agent-tools';
import {
  createDiagnosticEvent,
  createDiagnosticReporter,
  validChatRequestId,
} from '../../../lib/create-diagnostics';
import { resolveModel } from '../../../lib/model';
import { readGatewayAssertion } from '../../../lib/gateway-auth';
import { CHAT_REQUEST_ID_HEADER } from '../../../lib/request-id';

export const runtime = 'nodejs';
export const maxDuration = 360;

const SYSTEM_PROMPT = `You operate Nimble Agent API V2 through three tools.
For an open-ended research request:
1. Call startResearch once. The server pins low effort, so omit effort. Never
   invent or request an agent id.
2. If you use outputSchema, use the playground's constrained schema form:
   "type" plus typed "properties" or "items", with optional "required",
   "additionalProperties", scalar "enum"/"const", descriptions, formats, and
   basic bounds. A type may pair with "null". Never use shorthand such as
   {"field":"string"}, references, or composition. Omit outputSchema when a
   structured answer is unnecessary.
3. Only when the fixed diagnostic has providerPostAttempted=false and
   localReason=schema_validation or input_data_without_schema may you correct
   the schema or omit it and call startResearch once more. Treat every other
   start error as terminal. Never retry run creation.
4. Preserve both returned runId and agentId.
5. Call checkResearch once so the user sees the asynchronous lifecycle.
6. Call getResearchResult with both ids. It waits with bounded 10-second polling.
7. Report the actual output and trust metadata. Clearly label a completed result
   with low confidence or no citations as degraded, not authoritative.
Never claim completion from status alone.`;

const MAX_CHAT_BODY_BYTES = 64 * 1_024;
const MAX_CHAT_MESSAGES = 100;

function configuredNimbleKey(): string | undefined {
  return process.env.NIMBLE_API_KEY?.trim();
}

function invalidChatRequest(): Response {
  return Response.json(
    { error: 'The chat request body is invalid or exceeds 64 KiB.' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

async function readBoundedMessages(request: Request): Promise<unknown[] | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (
      !/^\d+$/.test(declaredLength) ||
      !Number.isSafeInteger(bytes) ||
      bytes > MAX_CHAT_BODY_BYTES
    ) {
      return null;
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CHAT_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length > MAX_CHAT_MESSAGES) return null;
  return messages;
}

export async function POST(request: Request) {
  const assertion = await readGatewayAssertion(request);
  if (assertion?.role !== 'agent') {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const requestId = request.headers.get(CHAT_REQUEST_ID_HEADER);
  if (!validChatRequestId(requestId)) {
    return Response.json(
      { error: 'A valid chat request ID is required.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  const apiKey = configuredNimbleKey();
  if (!apiKey) {
    return Response.json(
      { error: 'A Nimble API key is required for this protected action.' },
      { status: 401 },
    );
  }
  const messages = await readBoundedMessages(request);
  if (!messages) return invalidChatRequest();

  let modelMessages;
  try {
    const validatedMessages = await validateUIMessages<UIMessage>({
      messages,
    });
    modelMessages = await convertToModelMessages(validatedMessages);
  } catch {
    return invalidChatRequest();
  }

  const originSecret = process.env.PLAYGROUND_GATEWAY_SECRET!.trim();
  const diagnostics = createDiagnosticReporter({
    secret: originSecret,
    audience: assertion.aud,
    sid: assertion.sid,
    correlationId: requestId,
  });
  const tools = buildAgentTools(
    apiKey,
    undefined,
    diagnostics,
  );
  try {
    const result = streamText({
      model: resolveModel(),
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(8),
      onStepFinish: async ({ toolCalls }) => {
        const invalidStart = toolCalls.some(
          (call) =>
            call.toolName === 'startResearch' &&
            'invalid' in call &&
            call.invalid === true,
        );
        if (invalidStart) {
          await diagnostics.report(
            createDiagnosticEvent({
              correlationId: requestId,
              phase: 'pre_network_rejection',
              localReason: 'sdk_local_rejection',
            }),
          );
        }
      },
    });
    return result.toUIMessageStreamResponse({
      headers: {
        [CHAT_REQUEST_ID_HEADER]: requestId,
        'cache-control': 'no-store',
      },
      onError: () =>
        `The research request stopped. Diagnostic correlation: ${requestId}.`,
    });
  } catch {
    return Response.json(
      { error: 'The research service is not configured or could not start.' },
      { status: 502 },
    );
  }
}

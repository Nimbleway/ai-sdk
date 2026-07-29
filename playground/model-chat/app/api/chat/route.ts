import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { buildAgentTools } from '../../../lib/agent-tools';
import { resolveModel } from '../../../lib/model';
import { isGatewayAuthorized } from '../../../lib/gateway-auth';

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
3. Only when the tool explicitly says it rejected input before any Agent API
   request may you correct the schema or omit it and call startResearch once
   more. Treat every other start error as terminal. Never retry run creation.
4. Preserve both returned runId and agentId.
5. Call checkResearch once so the user sees the asynchronous lifecycle.
6. Call getResearchResult with both ids. It waits with bounded 10-second polling.
7. Report the actual output and trust metadata. Clearly label a completed result
   with low confidence or no citations as degraded, not authoritative.
Never claim completion from status alone.`;

function configuredNimbleKey(): string | undefined {
  return process.env.NIMBLE_API_KEY?.trim();
}

export async function POST(request: Request) {
  if (!await isGatewayAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const apiKey = configuredNimbleKey();
  if (!apiKey) {
    return Response.json(
      { error: 'A Nimble API key is required for this protected action.' },
      { status: 401 },
    );
  }
  const { messages }: { messages: UIMessage[] } = await request.json();
  try {
    const result = streamText({
      model: resolveModel(),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools: buildAgentTools(apiKey),
      stopWhen: stepCountIs(8),
    });
    return result.toUIMessageStreamResponse({
      onError: () => 'The research request failed. Check the protected server logs for details.',
    });
  } catch {
    return Response.json(
      { error: 'The research service is not configured or could not start.' },
      { status: 502 },
    );
  }
}

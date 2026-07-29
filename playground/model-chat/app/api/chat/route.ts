import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { buildAgentTools } from '../../../lib/agent-tools';
import { resolveModel } from '../../../lib/model';
import { isGatewayAuthorized } from '../../../lib/gateway-auth';

export const runtime = 'nodejs';
export const maxDuration = 360;

const SYSTEM_PROMPT = `You operate Nimble Agent API V2 through three tools.
For an open-ended research request:
1. Call startResearch exactly once. Never invent or request an agent id.
2. Preserve both returned runId and agentId.
3. Call checkResearch once so the user sees the asynchronous lifecycle.
4. Call getResearchResult with both ids. It waits with bounded 10-second polling.
5. Report the actual output and trust metadata. Clearly label a completed result
   with low confidence or no citations as degraded, not authoritative.
Never retry run creation. Never claim completion from status alone.`;

function resolveNimbleKey(request: Request): string | undefined {
  const supplied = request.headers.get('x-nimble-api-key')?.trim();
  const fallback = process.env.NIMBLE_API_KEY?.trim();
  return supplied || fallback;
}

export async function POST(request: Request) {
  if (!isGatewayAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const apiKey = resolveNimbleKey(request);
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

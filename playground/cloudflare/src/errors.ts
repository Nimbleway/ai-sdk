type JsonResponder = (body: unknown, status?: number) => Response;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Integration request failed";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key.{0,8})[A-Za-z0-9._-]{8,}/gi, "$1[REDACTED]")
    .slice(0, 600);
}

export function safeErrorResponse(
  error: unknown,
  respond: JsonResponder = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
): Response {
  const candidate = error as {
    status?: unknown;
    reason?: unknown;
    runId?: unknown;
    agentId?: unknown;
  };
  const upstreamStatus =
    typeof candidate?.status === "number" ? candidate.status : undefined;
  const status = upstreamStatus === 429 ? 429 : upstreamStatus === 400 ? 400 : 502;
  return respond(
    {
      error: safeError(error),
      type:
        upstreamStatus === 429
          ? "rate_limited"
          : upstreamStatus === 400
            ? "invalid_live_configuration"
            : "integration_error",
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(typeof candidate?.reason === "string" ? { reason: candidate.reason } : {}),
      ...(typeof candidate?.runId === "string" ? { runId: candidate.runId } : {}),
      ...(typeof candidate?.agentId === "string" ? { agentId: candidate.agentId } : {}),
      retryCreateAutomatically: false,
      nextAction:
        upstreamStatus === 429
          ? "Wait for quota or rate-limit reset, then start a new run manually."
          : "Review the sanitized error and integration configuration.",
    },
    status,
  );
}

import { describe, expect, it } from "vitest";
import { safeErrorResponse } from "../src/errors";

describe("playground structured errors", () => {
  it("renders a create-time 429 as actionable and never recommends automatic retry", async () => {
    const error = Object.assign(new Error("Daily run quota exhausted"), {
      name: "NimbleAgentRunError",
      status: 429,
      reason: "request",
    });
    const response = safeErrorResponse(error);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "Daily run quota exhausted",
      type: "rate_limited",
      upstreamStatus: 429,
      reason: "request",
      retryCreateAutomatically: false,
      nextAction: expect.stringMatching(/manually/),
    });
  });

  it("redacts bearer credentials in displayed errors", async () => {
    const response = safeErrorResponse(new Error("Bearer secret-token-value failed"));
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Bearer [REDACTED] failed");
    expect(body.error).not.toContain("secret-token-value");
  });

  it("renders a live-policy rejection as a client configuration error", async () => {
    const error = Object.assign(new Error("fixed to low"), { status: 400 });
    const response = safeErrorResponse(error);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: "invalid_live_configuration",
      upstreamStatus: 400,
      retryCreateAutomatically: false,
    });
  });
});

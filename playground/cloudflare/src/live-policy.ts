import type { NimbleAgentStartRunInput } from "@nimble-way/ai-sdk";

export class LiveEffortPolicyError extends Error {
  readonly status = 400;
}

/** Protected-live policy only; the reusable AI SDK tool keeps its full contract. */
export function enforceLiveLowEffort(
  input: NimbleAgentStartRunInput,
): NimbleAgentStartRunInput {
  if (input.effort !== undefined && input.effort !== "low") {
    throw new LiveEffortPolicyError(
      "This protected live playground is fixed to effort 'low'",
    );
  }
  return { ...input, effort: "low" };
}

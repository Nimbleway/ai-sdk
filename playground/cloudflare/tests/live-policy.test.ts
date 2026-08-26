import { describe, expect, it } from "vitest";
import { enforceLiveLowEffort } from "../src/live-policy";

describe("protected live effort policy", () => {
  it("normalizes an omitted effort to low", () => {
    expect(enforceLiveLowEffort({ task: "task" })).toEqual({
      task: "task",
      effort: "low",
    });
  });

  it("preserves explicit low", () => {
    expect(enforceLiveLowEffort({ task: "task", effort: "low" }).effort).toBe("low");
  });

  it.each(["medium", "high", "x-high", "max"])(
    "rejects %s before calling nimbleAgentStartRun",
    (effort) => {
      try {
        enforceLiveLowEffort({ task: "task", effort } as never);
        throw new Error("expected policy rejection");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect(error).toHaveProperty(
          "message",
          "This protected live playground is fixed to effort 'low'",
        );
      }
    },
  );
});

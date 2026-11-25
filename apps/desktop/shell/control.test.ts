import { describe, expect, it } from "vitest";
import { controlSchema } from "./control";

describe("shell control message", () => {
  it.each([
    "release-tool",
    "finish-demo",
    "compact-context-fixture",
    "confirm-context-fixture",
  ])("accepts %s", (action) => {
    expect(controlSchema.safeParse({ taskId: "t", action }).success).toBe(true);
  });

  it("refuses an unknown action, a missing task and an extra field", () => {
    expect(
      controlSchema.safeParse({ taskId: "t", action: "stop" }).success,
    ).toBe(false);
    expect(controlSchema.safeParse({ action: "finish-demo" }).success).toBe(
      false,
    );
    expect(
      controlSchema.safeParse({
        taskId: "t",
        action: "finish-demo",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

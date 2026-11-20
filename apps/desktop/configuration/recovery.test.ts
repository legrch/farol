import { describe, expect, it } from "vitest";
import { qualifyContinuityRecovery } from "./recovery";

const absent = {
  present: false,
  restricted: false,
  entryCount: 0,
  delivery: "not_recorded",
};
const present = { ...absent, present: true, entryCount: 1 };
const pending = { ...present, restricted: true, pendingOperationId: "pending" };
const qualified = {
  platform: "darwin",
  managedBuild: true,
  capabilities: [
    ...[
      "status",
      "begin",
      "confirm",
      "plan",
      "record",
      "withdraw",
      "stage",
      "finish",
      "qualify",
    ].map((name) => `computer.continuity.${name}`),
    "computer.stop.status",
  ],
  continuity: { ...absent, currentQualified: false },
  stop: absent,
};

describe("workspace continuity recovery qualification", () => {
  it("accepts absent journals on the attested macOS build", () => {
    expect(qualifyContinuityRecovery(qualified)).toBe(true);
  });

  it("accepts settled present journals before current operation activation", () => {
    expect(
      qualifyContinuityRecovery({
        ...qualified,
        continuity: { ...present, currentQualified: false },
        stop: present,
      }),
    ).toBe(true);
  });

  it.each([
    { platform: "linux" },
    { platform: "" },
    { managedBuild: false },
    { capabilities: undefined },
    {
      capabilities: qualified.capabilities.filter(
        (method) => method !== "computer.continuity.qualify",
      ),
    },
    { continuity: undefined },
    { continuity: { ...qualified.continuity, present: undefined } },
    { continuity: { ...present, currentQualified: false, restricted: true } },
    {
      continuity: {
        ...pending,
        currentQualified: false,
        pendingPhase: "intent",
      },
    },
    {
      continuity: {
        ...present,
        currentQualified: false,
        pendingPhase: "intent",
      },
    },
    { continuity: { ...qualified.continuity, entryCount: 1 } },
    { continuity: { ...qualified.continuity, currentQualified: true } },
    { stop: undefined },
    { stop: { ...present, restricted: undefined } },
    { stop: { ...pending, pendingPhase: "stop_intent" } },
    { stop: { ...present, pendingOperationId: "pending" } },
  ])("returns unavailable for %j", (facts) => {
    expect(qualifyContinuityRecovery({ ...qualified, ...facts })).toBe(
      "unavailable",
    );
  });
});

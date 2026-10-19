import { expect, it } from "vitest";
import {
  ownerStopPresentationCurrent,
  type OwnerStopPresentation,
  type OwnerStopPresentationFrame,
} from "../../apps/desktop/owner-stop-presentation";
// Pure presentation correlation only, not Go authority or native drain evidence.
function fixture() {
  const original: OwnerStopPresentation = {
    owner: {},
    connector: {},
    core: {},
    computerGeneration: 3,
    connectorGeneration: 7,
    receipt: {
      requestId: "original-request",
      operationId: "original-operation",
      reason: "owner_stop",
      result: {
        binding: {
          profileId: "profile",
          backendGeneration: "backend",
          buildId: "build",
          runtimeId: "runtime",
          connectorGeneration: "7",
        },
        closed: true,
        recovery: "settled",
      },
    },
  };
  const frame: OwnerStopPresentationFrame = {
    ...original,
    backendAvailable: true,
    stoppedSettings: true,
    setupOutcomeUnknown: false,
    helperRunning: false,
    helperOutcomeUnknown: false,
    tunnelObserved: false,
    currentBinding: false,
    admissionInProgress: false,
    quitting: false,
    updating: false,
  };
  return { original, frame };
}
it("requires the original completed stop identity and current negative facts", () => {
  const { original, frame } = fixture();
  expect(ownerStopPresentationCurrent(original, frame)).toBe(true);
});
it.each(["owner", "connector", "core"] as const)(
  "retires a replaced %s",
  (field) => {
    const { original, frame } = fixture();
    expect(
      ownerStopPresentationCurrent(original, { ...frame, [field]: {} }),
    ).toBe(false);
  },
);
it.each(["computerGeneration", "connectorGeneration"] as const)(
  "retires changed %s",
  (field) => {
    const { original, frame } = fixture();
    expect(
      ownerStopPresentationCurrent(original, {
        ...frame,
        [field]: frame[field] + 1,
      }),
    ).toBe(false);
  },
);
it.each([
  "setupOutcomeUnknown",
  "helperRunning",
  "helperOutcomeUnknown",
  "tunnelObserved",
  "currentBinding",
  "admissionInProgress",
  "quitting",
  "updating",
] as const)("fences %s", (field) => {
  const { original, frame } = fixture();
  expect(
    ownerStopPresentationCurrent(original, { ...frame, [field]: true }),
  ).toBe(false);
});
it.each(["backendAvailable", "stoppedSettings"] as const)(
  "requires %s",
  (field) => {
    const { original, frame } = fixture();
    expect(
      ownerStopPresentationCurrent(original, { ...frame, [field]: false }),
    ).toBe(false);
  },
);
it("rejects a missing or reconstructed receipt and ordinary close", () => {
  const { original, frame } = fixture();
  expect(
    ownerStopPresentationCurrent(original, { ...frame, receipt: undefined }),
  ).toBe(false);
  expect(
    ownerStopPresentationCurrent(original, {
      ...frame,
      receipt: { ...original.receipt },
    }),
  ).toBe(false);
  const receipt = { ...original.receipt };
  delete receipt.reason;
  const generic = { ...original, receipt };
  expect(
    ownerStopPresentationCurrent(generic, {
      ...frame,
      receipt: generic.receipt,
    }),
  ).toBe(false);
});

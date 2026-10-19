import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { ConnectionStatusTracker } from "../../apps/desktop/connection-status";
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
    settingsEditPending: false,
    settingsOutcomeUnknown: false,
    workspaceMutationInProgress: false,
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
  "settingsEditPending",
  "settingsOutcomeUnknown",
  "workspaceMutationInProgress",
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

// Exercise the actual main-process joins with injected settings/Go ports. This
// proves presentation fencing, not native Settings delivery or process cleanup.
const mainSource = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const mainDeclarations = parse(mainSource, {
  sourceType: "module",
  plugins: ["typescript"],
}).program.body.filter(
  (node) =>
    node.type === "FunctionDeclaration" &&
    ["captureConnectorStop", "ownerStoppedCurrent"].includes(
      node.id?.name ?? "",
    ),
);
if (mainDeclarations.length !== 2)
  throw Error("OWNER_STOP_MAIN_PRESENTATION_SOURCE_MISSING");
const mainCompiled = stripTypeScriptTypes(
  mainDeclarations
    .map((node) => {
      if (node.start == null || node.end == null)
        throw Error("OWNER_STOP_MAIN_PRESENTATION_RANGE_MISSING");
      return mainSource.slice(node.start, node.end);
    })
    .join("\n") +
    "; ({ capture: captureConnectorStop, current: ownerStoppedCurrent });",
);

const settingsFences = [
  "pending-edit",
  "unknown-delivery",
  "mutation-admitted",
] as const;
function mainFixture() {
  const { original } = fixture();
  const state = {
    status: "ready",
    settings: {
      computer: {
        generation: original.computerGeneration,
        pendingEdit: null as null | { operationId: string },
      },
      setup: {
        computer: { outcomeUnknown: false },
        connect: { outcomeUnknown: false },
      },
      connectors: {
        secureMcp: { generation: original.connectorGeneration, runtime: null },
      },
    },
  };
  let binding: object | undefined = original.receipt.result.binding;
  const owner = { snapshot: () => state };
  const connector = {
    isRunning: () => false,
    hasUnresolvedEffect: () => false,
    getTunnelObservation: () => null,
  };
  const core = {
    backendAvailable: true,
    currentComputerConnectorBinding: () => binding,
    computerConnectorOwnerStoppedReceipt: () => original.receipt,
  };
  const saved = { ...original, owner, connector, core };
  const context = {
    configuration: owner,
    secureMcpConnectorRuntime: connector,
    desktopGoCore: core,
    buildIdentity: { buildId: original.receipt.result.binding.buildId },
    completedOwnerStop: saved,
    ownerStopPresentationCurrent,
    connectorTaskAdmission: false,
    workspaceMutationAdmission: false,
    quitInProgress: false,
    installedUpdateAdmission: false,
  };
  const actual = vm.runInNewContext(mainCompiled, context) as {
    capture(): unknown;
    current(value: OwnerStopPresentation): boolean;
  };
  return {
    actual,
    saved,
    stopBinding: () => {
      binding = undefined;
    },
    fence: (reason: (typeof settingsFences)[number]) => {
      if (reason === "pending-edit")
        state.settings.computer.pendingEdit = { operationId: "pending-edit" };
      else if (reason === "unknown-delivery")
        state.settings.setup.computer.outcomeUnknown = true;
      else context.workspaceMutationAdmission = true;
    },
  };
}

it.each(settingsFences)(
  "does not capture a stop while Settings has %s",
  (reason) => {
    const f = mainFixture();
    expect(f.actual.capture()).not.toBeNull();
    f.fence(reason);
    expect(f.actual.capture()).toBeNull();
  },
);
it.each(settingsFences)(
  "retires cached stopped presentation immediately on Settings %s",
  async (reason) => {
    const f = mainFixture();
    f.stopBinding();
    const tracker = new ConnectionStatusTracker({
      capture: () => f.saved,
      current: (saved) => f.actual.current(saved),
      observe: async () => ({
        binding: f.saved.receipt.result.binding,
        expectedInstanceId: "runtime",
        state: "stopped" as const,
        reason: "owner_stopped" as const,
        localReady: false,
        observedAtMillis: "200000",
        validUntilMillis: "245000",
      }),
      now: () => 200000,
      monotonic: () => 0,
    });
    await tracker.sample();
    expect(tracker.view().state).toBe("stopped");
    f.fence(reason);
    // No new observation, clock advance, receipt or explicit invalidation.
    expect(tracker.view().state).toBe("unobserved");
  },
);

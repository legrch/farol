import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  DevProofPorts,
  DevProofPreparation,
  DevProofReceipt,
} from "../../apps/desktop/dev/proof";
import { DesktopAdmission } from "../../apps/desktop/host/admission";
import { configurationAdmission } from "../../src/apps/desktop/configuration-admission";
import { isolatedDevMcpProofAllowed } from "../../src/apps/desktop/desktop-environment";
import { workspaceDescriptor } from "../../src/apps/desktop/workspace-descriptor";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

// Test-only. Every owner is scripted and every call is appended to one ordered
// log, so a test can assert refusal order and call order together. This
// exercises the dev-proof orchestration, not a ChatGPT page, a live connector,
// a native workspace helper or an installation.
export const proofSentinel = "FAROL_DEV_scripted-sentinel";
export const proofAnswerSha256 = createHash("sha256")
  .update(proofSentinel)
  .digest("hex");

type Settings = ReturnType<typeof guidedSettingsFixture>;
type ConfigurationOwner = ReturnType<DevProofPorts["configuration"]>;

export function devProofPreparation(
  overrides: Partial<DevProofPreparation> = {},
): DevProofPreparation {
  return {
    schema: 1,
    proofId: "11111111-1111-4111-8111-111111111111",
    environment: "dev",
    buildId: fixtureBuildId,
    workspaceId: fixtureWorkspaceId,
    workspaceRoot: "/tmp/farol-onboarding-fixture",
    computerGeneration: 1,
    sentinelSha256: proofAnswerSha256,
    allowedPath: "sentinel.txt",
    deniedPath: "outside-link.txt",
    preparedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const call = (recordedAt: string) => ({
  callIdSha256: "",
  ownerId: "owner-desktop",
  sessionId: "session-1",
  taskId: "task-1",
  taskEpoch: 1,
  participantId: "participant-1",
  turnId: "turn-1",
  generation: 1,
  recordedAt,
});

export function devProofReceipt(
  overrides: Partial<DevProofReceipt> = {},
): DevProofReceipt {
  return {
    proofId: "11111111-1111-4111-8111-111111111111",
    environment: "dev",
    buildId: fixtureBuildId,
    computerGeneration: 1,
    workspaceId: fixtureWorkspaceId,
    sentinelSha256: proofAnswerSha256,
    allowed: {
      ...call("2026-01-01T00:00:02.000Z"),
      callIdSha256: "1".repeat(64),
      outputSha256: proofAnswerSha256,
    },
    denied: {
      ...call("2026-01-01T00:00:03.000Z"),
      callIdSha256: "2".repeat(64),
      errorCode: "WORKSPACE_PATH_REFUSED",
    },
    ...overrides,
  };
}

export function devProofHarness(
  options: {
    buildEnvironment?: DevProofPorts["buildEnvironment"];
    runtimeEnvironment?: DevProofPorts["runtimeEnvironment"];
  } = {},
) {
  const events: string[] = [];
  const state = {
    settings: guidedSettingsFixture() as Settings,
    configurationPresent: true,
    routePresent: true,
    connectorPresent: true,
    connectorRunning: true,
    agentActive: false,
    taskAdmissionReady: true,
    preparation: null as DevProofPreparation | null,
    preparationError: false,
    receipts: [] as (DevProofReceipt | null)[],
    receiptError: false,
    claimError: false,
    claimedAt: "2026-01-01T00:00:01.000Z",
    runtime: { identity: "runtime-1" } as { identity: string } | null,
    rootIdentity: { device: "1", inode: "2" } as {
      device: string;
      inode: string;
    } | null,
    listResult: { ok: true, value: { kind: "workspace.entries" } } as
      { ok: false } | { ok: true; value: { kind: string } },
    fixtureError: false,
    writeError: false,
    removeResult: null as unknown,
    addResult: null as unknown,
    recordResult: null as unknown,
    taskResult: {
      state: "completed",
      outputText: proofSentinel,
    } as unknown,
    snapshotStatuses: [] as string[],
  };
  const readySnapshot = () => ({ status: "ready", settings: state.settings });
  const snapshot = () => {
    const next = state.snapshotStatuses.shift();
    events.push(`snapshot${next ? `:${next}` : ""}`);
    return next && next !== "ready" ? { status: next } : readySnapshot();
  };
  const configuration = {
    snapshot,
    removeWorkspace: vi.fn(async (id: string) => {
      events.push(`removeWorkspace:${id}`);
      return state.removeResult ?? { ok: true, snapshot: readySnapshot() };
    }),
    addReadonlyWorkspace: vi.fn(async (input: { root: string }) => {
      events.push(`addReadonlyWorkspace:${input.root}`);
      return state.addResult ?? { ok: true, snapshot: readySnapshot() };
    }),
    recordComputerVerification: vi.fn(async (id: string) => {
      events.push(`recordComputerVerification:${id}`);
      return state.recordResult ?? { ok: true, snapshot: readySnapshot() };
    }),
  };
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const runReadonlyTask = vi.fn(async (prompt: string) => {
    events.push("runReadonlyTask");
    void prompt;
    return state.taskResult;
  });
  const ports: DevProofPorts = {
    buildEnvironment: options.buildEnvironment ?? "dev",
    runtimeEnvironment: options.runtimeEnvironment ?? "dev",
    isolatedDevMcpProofAllowed,
    configuration: () =>
      state.configurationPresent
        ? (configuration as unknown as NonNullable<ConfigurationOwner>)
        : null,
    chatGptRoute: () =>
      state.routePresent
        ? ({ runReadonlyTask } as unknown as ReturnType<
            DevProofPorts["chatGptRoute"]
          >)
        : null,
    secureMcpConnectorRuntime: () =>
      state.connectorPresent
        ? {
            isRunning: () => {
              events.push("connectorIsRunning");
              return state.connectorRunning;
            },
          }
        : null,
    runtime: () => state.runtime,
    desktopAdmission: {
      acquire: (kind) => {
        events.push(`acquire:${kind}`);
        const reservation = admission.acquire(kind);
        if (!reservation) return null;
        return {
          release: () => {
            events.push(`release:${kind}`);
            reservation.release();
          },
        };
      },
      occupied: (kind) => {
        events.push(`occupied:${kind}`);
        return admission.occupied(kind);
      },
    },
    buildIdentity: { buildId: fixtureBuildId },
    statePaths: () => ({ devMcpProof: "/fixture/dev-proof" }),
    configurationFailure: (code) => ({ ok: false, error: code }) as never,
    configurationAdmission: (kind, admissionState) => {
      events.push(`configurationAdmission:${kind}`);
      return configurationAdmission(kind, admissionState);
    },
    codexAgentOperationActive: () => {
      events.push("agentActive");
      return state.agentActive;
    },
    chatGptTaskAdmissionReady: () => {
      events.push("taskAdmissionReady");
      return state.taskAdmissionReady;
    },
    measuredRootIdentity: async (root) => {
      events.push(`measuredRootIdentity:${root}`);
      return state.rootIdentity;
    },
    workspaceDescriptor,
    nativeWorkspace: {
      execute: async () => {
        events.push("workspace.list");
        return state.listResult;
      },
    },
    DEV_MCP_PROOF_ALLOWED_PATH: "sentinel.txt",
    DEV_MCP_PROOF_DENIED_PATH: "outside-link.txt",
    readDevMcpProofPreparation: async () => {
      events.push("readPreparation");
      if (state.preparationError) throw new Error("unreadable");
      return state.preparation;
    },
    writeDevMcpProofPreparation: async (_root, preparation) => {
      events.push("writePreparation");
      if (state.writeError) throw new Error("write failed");
      state.preparation = preparation;
    },
    createDevMcpProofFixture: async () => {
      events.push("createFixture");
      if (state.fixtureError) throw new Error("fixture failed");
      return {
        proofId: "11111111-1111-4111-8111-111111111111",
        workspaceRoot: "/tmp/farol-onboarding-fixture",
        sentinelSha256: proofAnswerSha256,
      };
    },
    claimDevMcpProofAttempt: async () => {
      events.push("claimAttempt");
      if (state.claimError) throw new Error("claimed");
      return state.claimedAt;
    },
    readDevMcpProofReceipt: async () => {
      events.push("readReceipt");
      if (state.receiptError) throw new Error("unreadable");
      return state.receipts.length > 0 ? state.receipts.shift()! : null;
    },
  };
  return { ports, state, events, runReadonlyTask, configuration, admission };
}

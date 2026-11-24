import { createHash } from "node:crypto";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
  type WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";
import type { configurationAdmission } from "../../../src/apps/desktop/configuration-admission";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  DesktopEnvironment,
  isolatedDevMcpProofAllowed,
} from "../../../src/apps/desktop/desktop-environment";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { workspaceDescriptor } from "../../../src/apps/desktop/workspace-descriptor";
import type { DesktopAdmission } from "../host/admission";

// The record the prepare step writes and the run step reads. It mirrors the
// module's own schema field for field: this folder may not import module
// internals, so main hands the module's functions over as ports and the shape
// is checked where they are bound.
export type DevProofPreparation = Readonly<{
  schema: 1;
  proofId: string;
  environment: "dev";
  buildId: string;
  workspaceId: string;
  workspaceRoot: string;
  computerGeneration: number;
  sentinelSha256: string;
  allowedPath: "sentinel.txt";
  deniedPath: "outside-link.txt";
  preparedAt: string;
}>;

type DevProofCall = Readonly<{
  callIdSha256: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
  recordedAt: string;
}>;

// Only the fields the verification reads. The receipt is hashed whole, so main
// passes the module's parsed record through untouched.
export type DevProofReceipt = Readonly<{
  proofId: string;
  environment: string;
  buildId: string;
  computerGeneration: number;
  workspaceId: string;
  sentinelSha256: string;
  allowed: (DevProofCall & Readonly<{ outputSha256: string }>) | null;
  denied: (DevProofCall & Readonly<{ errorCode: string }>) | null;
}>;

type DevProofListResult =
  | Readonly<{ ok: false }>
  | Readonly<{ ok: true; value: Readonly<{ kind: string }> }>;

// Main owns the mutable state and the helper definitions. `configuration`,
// `chatGptRoute`, `secureMcpConnectorRuntime` and `runtime` are `let` in main,
// so they are late getters read afresh at every use, across each await. The
// environments, `desktopAdmission`, `buildIdentity` and `nativeWorkspace` are
// `const` in main and are shared by reference. The proof state functions are the
// computer module's own; main binds them, this module never imports them.
export type DevProofPorts = Readonly<{
  buildEnvironment: DesktopEnvironment;
  runtimeEnvironment: DesktopEnvironment;
  isolatedDevMcpProofAllowed: typeof isolatedDevMcpProofAllowed;
  configuration: () => ProductConfigurationService | null;
  chatGptRoute: () => Pick<ChatGptRoute, "runReadonlyTask"> | null;
  secureMcpConnectorRuntime: () => Pick<
    SecureMcpConnectorRuntime,
    "isRunning"
  > | null;
  runtime: () => Readonly<{ identity: string }> | null;
  desktopAdmission: Pick<DesktopAdmission, "acquire" | "occupied">;
  buildIdentity: Readonly<{ buildId: string }>;
  statePaths: () => Readonly<{ devMcpProof: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  configurationAdmission: typeof configurationAdmission;
  codexAgentOperationActive: () => boolean;
  chatGptTaskAdmissionReady: () => boolean;
  measuredRootIdentity: (root: string) => Promise<WorkspaceRootIdentity | null>;
  workspaceDescriptor: typeof workspaceDescriptor;
  nativeWorkspace: Readonly<{
    execute: (
      request: Readonly<{
        workspace: ReturnType<typeof workspaceDescriptor>;
        operation: Readonly<{ kind: "workspace.list"; relativePath: string }>;
      }>,
    ) => Promise<DevProofListResult>;
  }>;
  DEV_MCP_PROOF_ALLOWED_PATH: "sentinel.txt";
  DEV_MCP_PROOF_DENIED_PATH: "outside-link.txt";
  readDevMcpProofPreparation: (
    stateRoot: string,
  ) => Promise<DevProofPreparation | null>;
  writeDevMcpProofPreparation: (
    stateRoot: string,
    preparation: DevProofPreparation,
  ) => Promise<void>;
  createDevMcpProofFixture: (stateRoot: string) => Promise<
    Readonly<{
      proofId: string;
      workspaceRoot: string;
      sentinelSha256: string;
    }>
  >;
  claimDevMcpProofAttempt: (
    stateRoot: string,
    proofId: string,
  ) => Promise<string>;
  readDevMcpProofReceipt: (
    stateRoot: string,
  ) => Promise<DevProofReceipt | null>;
}>;

export function createDevProof(ports: DevProofPorts) {
  const {
    buildEnvironment,
    runtimeEnvironment,
    isolatedDevMcpProofAllowed,
    configuration,
    chatGptRoute,
    secureMcpConnectorRuntime,
    runtime,
    desktopAdmission,
    buildIdentity,
    statePaths,
    configurationFailure,
    configurationAdmission,
    codexAgentOperationActive,
    chatGptTaskAdmissionReady,
    measuredRootIdentity,
    workspaceDescriptor,
    nativeWorkspace,
    DEV_MCP_PROOF_ALLOWED_PATH,
    DEV_MCP_PROOF_DENIED_PATH,
    readDevMcpProofPreparation,
    writeDevMcpProofPreparation,
    createDevMcpProofFixture,
    claimDevMcpProofAttempt,
    readDevMcpProofReceipt,
  } = ports;

  async function prepareDevMcpProof(): Promise<ProductConfigurationResult> {
    if (!isolatedDevMcpProofAllowed(buildEnvironment, runtimeEnvironment)) {
      return configurationFailure("DEV_MCP_PROOF_DEV_ONLY");
    }
    if (!configuration()) {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    // `configureProduct` takes the authority-transition reservation for this
    // command, but its first admission read happens before that await. Re-read
    // the live holders after the reservation is ours so an Agent or connector
    // that won the race cannot have its carried grant replaced underneath it.
    const readmitted = configurationAdmission("dev-proof.prepare", {
      agentActive: codexAgentOperationActive(),
      connectorRunning:
        desktopAdmission.occupied("connector-task") ||
        secureMcpConnectorRuntime()?.isRunning() === true,
    });
    if (readmitted !== "admitted") {
      return configurationFailure(
        readmitted === "CONNECTOR_STOP_REQUIRED"
          ? "DEV_MCP_PROOF_CONNECTOR_MUST_STOP"
          : readmitted,
      );
    }
    try {
      const previous = await readDevMcpProofPreparation(
        statePaths().devMcpProof,
      ).catch(() => null);
      let snapshot = configuration()!.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (
        previous !== null &&
        snapshot.settings.computer.workspaces.some(
          (workspace) => workspace.workspaceId === previous.workspaceId,
        )
      ) {
        const removed = await configuration()!.removeWorkspace(
          previous.workspaceId,
        );
        if (!removed.ok) return ProductConfigurationResultSchema.parse(removed);
        snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
      }

      const fixture = await createDevMcpProofFixture(statePaths().devMcpProof);
      const rootIdentity = await measuredRootIdentity(fixture.workspaceRoot);
      if (rootIdentity === null) {
        return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
      }
      const added = await configuration()!.addReadonlyWorkspace({
        root: fixture.workspaceRoot,
        label: "Farol Dev verification fixture",
        rootIdentity,
      });
      if (!added.ok) return ProductConfigurationResultSchema.parse(added);
      const addedSnapshot = configuration()!.snapshot();
      if (addedSnapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const workspace = addedSnapshot.settings.computer.workspaces.find(
        (candidate) => candidate.root === fixture.workspaceRoot,
      );
      if (!workspace) {
        return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
      }
      const listed = await nativeWorkspace.execute({
        workspace: workspaceDescriptor(workspace, rootIdentity),
        operation: { kind: "workspace.list", relativePath: "." },
      });
      if (!listed.ok || listed.value.kind !== "workspace.entries") {
        return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
      }
      const recorded = await configuration()!.recordComputerVerification(
        workspace.workspaceId,
        {
          profile: "computer.local.read/1",
          runtimeGeneration: `${runtime()?.identity ?? "runtime-offline"}:${buildIdentity.buildId}`,
          buildId: buildIdentity.buildId,
          protocol: "readonly-workspace/1",
        },
        { rootIdentity, gitMetadata: null },
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      const verifiedSnapshot = configuration()!.snapshot();
      if (verifiedSnapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const preparation = {
        schema: 1 as const,
        proofId: fixture.proofId,
        environment: "dev" as const,
        buildId: buildIdentity.buildId,
        workspaceId: workspace.workspaceId,
        workspaceRoot: fixture.workspaceRoot,
        computerGeneration: verifiedSnapshot.settings.computer.generation,
        sentinelSha256: fixture.sentinelSha256,
        allowedPath: DEV_MCP_PROOF_ALLOWED_PATH,
        deniedPath: DEV_MCP_PROOF_DENIED_PATH,
        preparedAt: new Date().toISOString(),
      } satisfies DevProofPreparation;
      await writeDevMcpProofPreparation(statePaths().devMcpProof, preparation);
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: verifiedSnapshot,
        evidence: {
          kind: "dev-proof.prepared",
          proofId: preparation.proofId,
          workspaceId: preparation.workspaceId,
          computerGeneration: preparation.computerGeneration,
          buildId: preparation.buildId,
          allowedPath: preparation.allowedPath,
          deniedPath: preparation.deniedPath,
        },
      });
    } catch {
      return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
    }
  }

  async function runDevMcpProof(): Promise<ProductConfigurationResult> {
    if (!isolatedDevMcpProofAllowed(buildEnvironment, runtimeEnvironment)) {
      return configurationFailure("DEV_MCP_PROOF_DEV_ONLY");
    }
    if (!configuration() || !chatGptRoute() || !secureMcpConnectorRuntime()) {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    const chatAdmission = desktopAdmission.acquire("chatgpt-task");
    if (!chatAdmission) return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    try {
      const snapshot = configuration()!.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const connector = snapshot.settings.connectors.secureMcp;
      const runtimeProof = connector.runtime;
      if (
        runtimeProof?.state !== "ready" ||
        connector.attachment === null ||
        !secureMcpConnectorRuntime()!.isRunning() ||
        !chatGptTaskAdmissionReady()
      ) {
        return configurationFailure("DEV_MCP_PROOF_CONNECTOR_NOT_READY");
      }
      const preparation = await readDevMcpProofPreparation(
        statePaths().devMcpProof,
      ).catch(() => null);
      if (preparation === null) {
        return configurationFailure("DEV_MCP_PROOF_NOT_PREPARED");
      }
      if (
        preparation.environment !== "dev" ||
        preparation.buildId !== buildIdentity.buildId ||
        preparation.computerGeneration !==
          snapshot.settings.computer.generation ||
        runtimeProof.computerGeneration !== preparation.computerGeneration ||
        runtimeProof.buildId !== preparation.buildId ||
        !snapshot.settings.computer.workspaces.some(
          (workspace) =>
            workspace.workspaceId === preparation.workspaceId &&
            workspace.root === preparation.workspaceRoot &&
            workspace.rootIdentity !== undefined,
        )
      ) {
        return configurationFailure("DEV_MCP_PROOF_STALE");
      }
      if (
        (await readDevMcpProofReceipt(statePaths().devMcpProof).catch(
          () => null,
        )) !== null
      ) {
        // A prior live attempt exists. Its outcome must never be overwritten or
        // retried as though nothing happened; prepare a fresh fixture instead.
        return configurationFailure("DEV_MCP_PROOF_STALE");
      }
      let attemptedAt: string;
      try {
        attemptedAt = await claimDevMcpProofAttempt(
          statePaths().devMcpProof,
          preparation.proofId,
        );
      } catch {
        // The claim is exclusive and durable. Any previous attempt, including one
        // whose provider outcome is unknown, requires a newly prepared fixture.
        return configurationFailure("DEV_MCP_PROOF_STALE");
      }
      const prompt = [
        "Use the selected app's Computer tool computer_workspace_read.",
        `First read workspaceId ${preparation.workspaceId} at relativePath ${preparation.allowedPath}.`,
        `Then attempt the same tool and workspaceId at relativePath ${preparation.deniedPath}; it must be refused because it leaves the grant through a link.`,
        "If and only if the first read succeeds and the second is refused, reply with exactly the first file's text and nothing else.",
      ].join(" ");

      try {
        const result = await chatGptRoute()!.runReadonlyTask(prompt);
        if (
          result.state !== "completed" ||
          typeof result.outputText !== "string"
        ) {
          return configurationFailure("DEV_MCP_PROOF_CHATGPT_FAILED");
        }
        const answerSha256 = createHash("sha256")
          .update(result.outputText.trim())
          .digest("hex");
        if (answerSha256 !== preparation.sentinelSha256) {
          return configurationFailure("DEV_MCP_PROOF_ANSWER_MISMATCH");
        }
        const receipt = await readDevMcpProofReceipt(
          statePaths().devMcpProof,
        ).catch(() => null);
        if (
          receipt === null ||
          receipt.allowed === null ||
          receipt.denied === null
        ) {
          return configurationFailure("DEV_MCP_PROOF_RECEIPT_MISSING");
        }
        const sameProofBinding =
          receipt.allowed.ownerId === receipt.denied.ownerId &&
          receipt.allowed.sessionId === receipt.denied.sessionId &&
          receipt.allowed.taskId === receipt.denied.taskId &&
          receipt.allowed.taskEpoch === receipt.denied.taskEpoch &&
          receipt.allowed.participantId === receipt.denied.participantId &&
          receipt.allowed.turnId === receipt.denied.turnId &&
          receipt.allowed.generation === receipt.denied.generation;
        if (
          receipt.proofId !== preparation.proofId ||
          receipt.environment !== "dev" ||
          receipt.buildId !== preparation.buildId ||
          receipt.computerGeneration !== preparation.computerGeneration ||
          receipt.workspaceId !== preparation.workspaceId ||
          receipt.sentinelSha256 !== preparation.sentinelSha256 ||
          receipt.allowed.outputSha256 !== preparation.sentinelSha256 ||
          receipt.allowed.generation !== preparation.computerGeneration ||
          receipt.allowed.taskEpoch !== preparation.computerGeneration ||
          receipt.denied.generation !== preparation.computerGeneration ||
          receipt.denied.taskEpoch !== preparation.computerGeneration ||
          receipt.denied.errorCode !== "WORKSPACE_PATH_REFUSED" ||
          receipt.allowed.ownerId !== "owner-desktop" ||
          receipt.allowed.callIdSha256 === receipt.denied.callIdSha256 ||
          receipt.allowed.recordedAt < attemptedAt ||
          receipt.denied.recordedAt < receipt.allowed.recordedAt ||
          !sameProofBinding
        ) {
          return configurationFailure("DEV_MCP_PROOF_RECEIPT_INVALID");
        }
        const receiptSha256 = createHash("sha256")
          .update(`${JSON.stringify(receipt, null, 2)}\n`)
          .digest("hex");
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "dev-proof.verified",
            proofId: preparation.proofId,
            workspaceId: preparation.workspaceId,
            environment: "dev",
            runtimeGeneration: runtimeProof.runtimeGeneration,
            computerGeneration: preparation.computerGeneration,
            buildId: preparation.buildId,
            sentinelSha256: preparation.sentinelSha256,
            answerSha256,
            receiptSha256,
            outsideGrantError: receipt.denied.errorCode,
          },
        });
      } finally {
        chatAdmission.release();
      }
    } finally {
      // Also covers preparation exits before the existing dispatch finalizer.
      // Release is identity-bound: a repeated release cannot clear a successor.
      chatAdmission.release();
    }
  }

  return {
    prepare: prepareDevMcpProof,
    run: runDevMcpProof,
  };
}

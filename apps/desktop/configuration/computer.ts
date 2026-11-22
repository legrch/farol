import type { ReadonlyComputerCallResponse } from "../../../src/modules/computer/contract/readonly-computer-contract";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { DesktopAdmission } from "../host/admission";
import { DesktopGoCore } from "../go-core-host";
import { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import {
  ProductConfigurationService,
  workspaceCheckEvidence,
} from "../../../src/apps/desktop/product-configuration";
import { BridgeError } from "../bridge/client";
import type { SettingsDeliveryResult } from "../bridge/wire";
import {
  workspaceEditPreview,
  observeWorkspaceEdit,
} from "../../../src/apps/desktop/workspace-edit";
import type { PendingWorkspaceEdit } from "../../../src/apps/desktop/workspace-edit";
import { readGoWorkspaceSnapshot } from "../go-workspace-snapshot";
import { withSettingsEditLease } from "../with-settings-edit-lease";

import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
  type ProductSettings,
  type WorkspaceRootIdentity,
  type ApprovedProductWorkspace,
  type WorkspaceGitMetadata,
} from "../../../src/pkg/product-settings/contract";
import { configurationAdmission } from "../../../src/apps/desktop/configuration-admission";
import type { VerifiedProductWorkspaceResult } from "../../../src/apps/desktop/workspace-descriptor";
import { classifyWorkspaceRootDrift } from "./drift";

export type SelectedWorkspace = Readonly<{
  root: string;
  label: string;
  rootIdentity: WorkspaceRootIdentity;
}>;

export type PendingWorkspacePickValue = Readonly<{
  id: string;
  selected: SelectedWorkspace;
  expiresAt: number;
}>;

export type ComputerConfigurationCommand = Extract<
  ProductConfigurationCommand,
  { kind: `computer.${string}` }
>;

type PublishedVerificationOutput = Extract<
  ReadonlyComputerCallResponse,
  { ok: true }
>["value"]["output"];
type VerificationOutput =
  | Omit<
      Extract<PublishedVerificationOutput, { kind: "workspace.command" }>,
      "relativePath"
    >
  | Readonly<{
      kind: Exclude<PublishedVerificationOutput["kind"], "workspace.command">;
    }>;

export type VerificationWorkspaceAction = Readonly<{
  execute(
    request: Readonly<{
      ownerId: string;
      sessionId: string;
      taskId: string;
      taskEpoch: number;
      participantId: string;
      turnId: string;
      generation: number;
      callId: string;
      workspaceId: string;
      operation: Readonly<{
        kind: "verification.run";
        command: "git.status" | "git.head";
        relativePath: ".";
      }>;
    }>,
  ): Promise<
    | Readonly<{
        ok: true;
        value: Readonly<{
          output: VerificationOutput;
        }>;
      }>
    | Readonly<{ ok: false; error: Readonly<{ code: string }> }>
  >;
}>;

export type ConfigurationComputerPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  codexAgentOperationActive: () => boolean;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
    connectorAttempt?: Extract<
      ProductConfigurationResult,
      { ok: false }
    >["connectorAttempt"],
  ) => ProductConfigurationResult;
  getPendingWorkspacePick: () => PendingWorkspacePickValue | null;
  setPendingWorkspacePick: (value: PendingWorkspacePickValue | null) => void;
  selectedWorkspace: () => Promise<SelectedWorkspace | "cancelled" | "invalid">;
  measuredRootIdentity: (root: string) => Promise<WorkspaceRootIdentity | null>;
  inspectOwnerWorkspace: (
    generation: number,
    workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
    identity: WorkspaceRootIdentity,
    diagnosticAction: string,
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  buildIdentity: () => Readonly<{ buildId: string }>;
  workspaceReadFailure: (code: string) => ProductConfigurationResult;
  desktopAdmission: Pick<
    DesktopAdmission,
    "occupied" | "reserveAdmitted" | "closed"
  >;
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  runtime: () => { identity: string | null } | null;
  verifiedProductWorkspace: (
    workspaceId: string,
  ) => VerifiedProductWorkspaceResult;
  listOwnerWorkspace: (
    generation: number,
    workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
    identity: WorkspaceRootIdentity,
    relativePath: string,
  ) => Promise<
    | { ok: true; entries: string[]; truncated: boolean }
    | { ok: false; code: string }
  >;
  desktopGoCore: () => DesktopGoCore | null;
  compiledGoCore: () => unknown;
  discoverWorkspaceGitMetadata: (
    root: string,
    gitHistoryApproved: boolean,
  ) => Promise<WorkspaceGitMetadata | null>;
  verificationWorkspaceAction: (
    settings: ProductSettings,
    workspace: ApprovedProductWorkspace,
    expiresAt: number,
  ) => VerificationWorkspaceAction | null;
  getPendingWorkspaceEdit: () => PendingWorkspaceEdit | null;
  setPendingWorkspaceEdit: (value: PendingWorkspaceEdit | null) => void;
  selectedWorkspaceFile: (
    workspace: ApprovedProductWorkspace,
    labels: Readonly<{ title: string; buttonLabel: string }>,
  ) => Promise<string | "cancelled" | "invalid">;
  goWorkspaceEditResult: (
    delivery: SettingsDeliveryResult,
    redelivered: boolean,
  ) => ProductConfigurationResult;
  statePaths: () => { workspaceMutations: string };
  workspaceMutationFailure: (code: string) => ProductConfigurationResult;
  workspaceCommandFailure: (code: string) => ProductConfigurationResult;
}>;

export function createConfigurationComputer(
  ports: ConfigurationComputerPorts,
): Readonly<{
  configureAdmittedComputer: (
    command: ComputerConfigurationCommand,
  ) => Promise<ProductConfigurationResult>;
}> {
  const {
    configuration,
    codexAgentOperationActive,
    configurationFailure,
    getPendingWorkspacePick,
    setPendingWorkspacePick,
    selectedWorkspace,
    measuredRootIdentity,
    inspectOwnerWorkspace,
    buildIdentity,
    workspaceReadFailure,
    desktopAdmission,
    secureMcpConnectorRuntime,
    runtime,
    verifiedProductWorkspace,
    listOwnerWorkspace,
    desktopGoCore,
    compiledGoCore,
    discoverWorkspaceGitMetadata,
    verificationWorkspaceAction,
    getPendingWorkspaceEdit,
    setPendingWorkspaceEdit,
    selectedWorkspaceFile,
    goWorkspaceEditResult,
    statePaths,
    workspaceMutationFailure,
    workspaceCommandFailure,
  } = ports;

  async function configureAdmittedComputer(
    command: ComputerConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    if (!configuration()) return configurationFailure("SETTINGS_UNAVAILABLE");
    switch (command.kind) {
      case "computer.rename":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.renameComputer(command.name),
        );
      case "computer.choose-workspace": {
        if (codexAgentOperationActive())
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        setPendingWorkspacePick(null);
        const selected = await selectedWorkspace();
        if (selected === "cancelled")
          return configurationFailure("WORKSPACE_PICKER_CANCELLED");
        if (selected === "invalid")
          return configurationFailure("WORKSPACE_SELECTION_INVALID");
        if (codexAgentOperationActive())
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        const selectionId = randomUUID();
        setPendingWorkspacePick({
          id: selectionId,
          selected,
          expiresAt: Date.now() + 300_000,
        });
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "computer.workspace-pick",
            selectionId,
            displayPath: selected.root,
          },
        });
      }
      case "computer.add-workspace": {
        if (codexAgentOperationActive())
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        const picked = getPendingWorkspacePick();
        if (command.selectionId) setPendingWorkspacePick(null);
        const selected = command.selectionId
          ? picked?.id === command.selectionId && picked.expiresAt > Date.now()
            ? picked.selected
            : "invalid"
          : await selectedWorkspace();
        if (selected === "cancelled") {
          return configurationFailure("WORKSPACE_PICKER_CANCELLED");
        }
        if (selected === "invalid") {
          return configurationFailure("WORKSPACE_SELECTION_INVALID");
        }
        const currentIdentity = await measuredRootIdentity(selected.root);
        if (
          !currentIdentity ||
          currentIdentity.device !== selected.rootIdentity.device ||
          currentIdentity.inode !== selected.rootIdentity.inode
        ) {
          return configurationFailure("WORKSPACE_ROOT_CHANGED");
        }
        const added = await configuration()!.addWorkspace(
          selected,
          command.access ?? "read",
        );
        if (!added.ok || added.snapshot.status !== "ready")
          return ProductConfigurationResultSchema.parse(added);
        // Report the native pick even when it is an already approved folder.
        // Inferring it from a snapshot diff fails on that no-op path.
        const workspace = added.snapshot.settings.computer.workspaces.find(
          (candidate) => candidate.root === selected.root,
        );
        if (!workspace)
          return configurationFailure("WORKSPACE_SELECTION_INVALID");
        return ProductConfigurationResultSchema.parse({
          ...added,
          evidence: {
            kind: "computer.workspace-selection",
            workspaceId: workspace.workspaceId,
          },
        });
      }
      case "computer.remove-workspace":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.removeWorkspace(command.workspaceId),
        );
      case "computer.update-exclusions": {
        const snapshot = configuration()!.snapshot();
        const workspace =
          snapshot.status === "ready"
            ? snapshot.settings.computer.workspaces.find(
                (candidate) => candidate.workspaceId === command.workspaceId,
              )
            : undefined;
        if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateWorkspaceExclusions(
            workspace.workspaceId,
            command.excludedPaths.map((relative) =>
              path.join(workspace.root, ...relative.split("/")),
            ),
          ),
        );
      }
      case "computer.update-access":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateWorkspaceAccess(
            command.workspaceId,
            command.access,
          ),
        );
      case "computer.update-git-history":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateWorkspaceGitHistory(
            command.workspaceId,
            command.approved,
          ),
        );
      case "computer.update-commands":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateComputerCommands(command.commands),
        );
      case "computer.update-file-policy":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateComputerFilePolicy(command.filePolicy),
        );
      case "computer.check-folder": {
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const workspace = snapshot.settings.computer.workspaces.find(
          (item) => item.workspaceId === command.workspaceId,
        );
        if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
        const identity = workspace.rootIdentity;
        if (!identity)
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        // Recheck only the already approved root through the same descriptor.
        // No child names/content are returned and no selected-folder binding changes.
        // Path-bound approval: Go's live root is compared with this check's
        // own live measurement, never with the saved pair.
        const measuredNow = await measuredRootIdentity(workspace.root);
        const checked =
          measuredNow === null
            ? ({ ok: false, code: "WORKSPACE_NOT_FOUND" } as const)
            : await inspectOwnerWorkspace(
                snapshot.settings.computer.generation,
                workspace,
                measuredNow,
                `settings:computer.check-folder:${workspace.workspaceId}`,
              );
        const reachable = checked.ok;
        const recorded = await configuration()!.recordFolderAccessCheck(
          workspace.workspaceId,
          snapshot.settings.computer.generation,
          buildIdentity().buildId,
          identity,
          reachable,
          command.checkId,
        );
        if (!recorded.ok)
          return ProductConfigurationResultSchema.parse(recorded);
        return reachable
          ? ProductConfigurationResultSchema.parse(recorded)
          : workspaceReadFailure(checked.code);
      }
      case "computer.verify-workspace": {
        let snapshot = configuration()!.snapshot();
        let workspace =
          snapshot.status === "ready"
            ? snapshot.settings.computer.workspaces.find(
                (candidate) => candidate.workspaceId === command.workspaceId,
              )
            : undefined;
        if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
        // Verifying is the owner's explicit act that binds the folder. The folder
        // at the path now is measured; one already bound must still be that
        // object, and one saved before identities existed is bound to what is
        // measured here only because the owner asked for this verification.
        // Check evidence as it was before measuring; a withdrawal never
        // erases a newer check made meanwhile.
        const observed =
          snapshot.status === "ready"
            ? workspaceCheckEvidence(snapshot.settings, workspace.workspaceId)
            : null;
        const measured = await measuredRootIdentity(workspace.root);
        const bound = workspace.rootIdentity;
        // A refused check of a bound folder also withdraws its stale "Works"
        // evidence, so the row cannot keep claiming access Go will refuse.
        // This only reduces authority. It never runs while a connector or an
        // Agent holds the grant (then it simply refuses as before), and an
        // unconfirmed write surfaces as SETTINGS_WRITE_FAILED.
        const refuseStale = async (
          code:
            | "WORKSPACE_VERIFICATION_FAILED"
            | "WORKSPACE_ROOT_CHANGED"
            | "WORKSPACE_NOT_FOUND"
            | "WORKSPACE_PATH_REFUSED",
        ) => {
          if (
            !bound ||
            observed === null ||
            codexAgentOperationActive() ||
            desktopAdmission.occupied("connector-task") ||
            secureMcpConnectorRuntime()?.isRunning() === true
          )
            return configurationFailure(code);
          try {
            const result =
              await configuration()!.withdrawDriftedWorkspaceChecks(
                [
                  {
                    workspaceId: workspace!.workspaceId,
                    root: workspace!.root,
                    rootIdentity: bound,
                    observed,
                  },
                ],
                () => !desktopAdmission.closed(),
              );
            // WORKSPACE_ROOT_CHANGED here means the saved evidence moved on
            // (a newer check or edit); keep the original refusal. Any other
            // unsuccessful outcome (write failure, uncertain runtime, Quit)
            // is reported instead of hidden behind it.
            if (!result.ok && result.error !== "WORKSPACE_ROOT_CHANGED")
              return ProductConfigurationResultSchema.parse(result);
          } catch {
            return configurationFailure("SETTINGS_WRITE_FAILED");
          }
          return configurationFailure(code);
        };
        if (measured === null)
          return refuseStale("WORKSPACE_VERIFICATION_FAILED");
        // Path-bound approval (owner decision 2026-11-22): a changed device
        // or inode at the same path is diagnostic only, so verification
        // proceeds against the folder now at the path. The saved pair is not
        // rewritten here.
        if (classifyWorkspaceRootDrift(bound, measured) !== "same" && bound)
          console.warn(
            `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift: classifyWorkspaceRootDrift(bound, measured) })}`,
          );
        if (!bound) {
          if (snapshot.status !== "ready")
            return configurationFailure("SETTINGS_UNAVAILABLE");
          const bindingAdmission = configurationAdmission(command.kind, {
            agentActive: codexAgentOperationActive(),
            connectorRunning:
              desktopAdmission.occupied("connector-task") ||
              secureMcpConnectorRuntime()?.isRunning() === true,
          });
          if (bindingAdmission !== "admitted")
            return configurationFailure(bindingAdmission);
          const binding = await configuration()!.bindWorkspaceRootIdentity(
            workspace.workspaceId,
            snapshot.settings.revision,
            workspace.root,
            measured,
          );
          if (!binding.ok)
            return ProductConfigurationResultSchema.parse(binding);
          snapshot = configuration()!.snapshot();
          workspace =
            snapshot.status === "ready"
              ? snapshot.settings.computer.workspaces.find(
                  (item) => item.workspaceId === command.workspaceId,
                )
              : undefined;
        }
        if (!workspace || snapshot.status !== "ready")
          return configurationFailure("WORKSPACE_NOT_FOUND");
        // Go performs bounded content-free inspection under the exact published
        // approval. Native binding and final current authority are both checked.
        const generation = snapshot.settings.computer.generation;
        const result = await inspectOwnerWorkspace(
          generation,
          workspace,
          measured,
          `settings:computer.verify-workspace:${workspace.workspaceId}`,
        );
        if (!result.ok) {
          // The root can change, vanish or become unsafe between the
          // measurement and Go's descriptor inspection; withdraw the stale
          // evidence for those refusals too. Other failures leave it alone.
          if (
            result.code === "WORKSPACE_ROOT_CHANGED" ||
            result.code === "WORKSPACE_NOT_FOUND" ||
            result.code === "WORKSPACE_PATH_REFUSED"
          )
            return refuseStale(result.code);
          return workspaceReadFailure(result.code);
        }
        // Preserve the measured layout for task selection. Primary metadata is
        // bound only with explicit full-Git approval; linked grants stay exact.
        const gitMetadata = await discoverWorkspaceGitMetadata(
          workspace.root,
          workspace.gitHistoryApproved === true,
        );
        // Git discovery reads by pathname; the evidence is published only if
        // the folder is still the one measured and inspected above, so a
        // green check and its Git metadata come from the same tree.
        const afterDiscovery = await measuredRootIdentity(workspace.root);
        if (
          afterDiscovery === null ||
          afterDiscovery.device !== measured.device ||
          afterDiscovery.inode !== measured.inode
        )
          return refuseStale("WORKSPACE_ROOT_CHANGED");
        // The inspection takes a moment, and a connector or Agent may have started
        // meanwhile; a re-verification rebinds the authority either would carry,
        // so it is admitted again right before it commits.
        const readmitted = configurationAdmission(command.kind, {
          agentActive: codexAgentOperationActive(),
          connectorRunning:
            desktopAdmission.occupied("connector-task") ||
            secureMcpConnectorRuntime()?.isRunning() === true,
        });
        if (readmitted !== "admitted") return configurationFailure(readmitted);
        const recorded = await configuration()!.recordComputerVerification(
          workspace.workspaceId,
          {
            profile: `computer.local.${workspace.access}/1`,
            runtimeGeneration: `${runtime()?.identity ?? "runtime-offline"}:${buildIdentity().buildId}`,
            buildId: buildIdentity().buildId,
            protocol:
              workspace.access === "write"
                ? "mutable-workspace/1"
                : "readonly-workspace/1",
          },
          {
            rootIdentity: measured,
            ...(command.checkId === undefined
              ? {}
              : { checkId: command.checkId }),
            gitMetadata,
            expectedGeneration: generation,
            expectedRoot: workspace.root,
          },
        );
        if (!recorded.ok)
          return ProductConfigurationResultSchema.parse(recorded);
        return ProductConfigurationResultSchema.parse({
          ...recorded,
          evidence: {
            kind: "computer.workspace-inspection",
            workspaceId: workspace.workspaceId,
            relativePath: ".",
          },
        });
      }
      case "computer.list-workspace": {
        const selected = verifiedProductWorkspace(command.workspaceId);
        if (selected.status === "not_found") {
          return configurationFailure("WORKSPACE_NOT_FOUND");
        }
        if (selected.status === "not_verified") {
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const result = await listOwnerWorkspace(
          snapshot.settings.computer.generation,
          selected.workspace,
          selected.workspace.rootIdentity,
          command.relativePath,
        );
        if (!result.ok) return workspaceReadFailure(result.code);
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "computer.workspace-list",
            workspaceId: selected.workspace.workspaceId,
            relativePath: command.relativePath,
            entries: result.entries,
            truncated: result.truncated,
          },
        });
      }
      case "computer.search-workspace": {
        const selected = verifiedProductWorkspace(command.workspaceId);
        if (selected.status === "not_found")
          return configurationFailure("WORKSPACE_NOT_FOUND");
        if (selected.status === "not_verified")
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        if (!desktopGoCore())
          return configurationFailure("WORKSPACE_READ_FAILED");
        try {
          const result = await desktopGoCore()!.searchSettingsWorkspace(
            snapshot.settings.computer.generation,
            selected.workspace.workspaceId,
            command.relativePath,
            command.pattern,
          );
          const current = configuration()!.snapshot();
          const identity = selected.workspace.rootIdentity;
          if (
            result.root.path !== selected.workspace.root ||
            result.root.device !== identity.device ||
            result.root.inode !== identity.inode ||
            current.status !== "ready" ||
            current.settings.computer.generation !==
              snapshot.settings.computer.generation
          )
            return configurationFailure("WORKSPACE_ROOT_CHANGED");
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: current,
            evidence: {
              kind: "computer.workspace-search",
              workspaceId: selected.workspace.workspaceId,
              relativePath: command.relativePath,
              pattern: command.pattern,
              matches: result.matches.map((match) => ({
                ...match,
                line: Number(match.line),
              })),
              resultLimited: result.resultLimited,
              scanLimited: result.scanLimited,
            },
          });
        } catch (error) {
          // A failed selected Go read never dispatches the legacy Python helper.
          return workspaceReadFailure(
            error instanceof BridgeError && error.state === "refused"
              ? error.code
              : "WORKSPACE_READ_FAILED",
          );
        }
      }
      case "computer.run-git-status":
      case "computer.run-git-head": {
        const verificationCommand =
          command.kind === "computer.run-git-status"
            ? "git.status"
            : "git.head";
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        if (snapshot.settings.computer.commands === "none") {
          return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
        }
        const selected = verifiedProductWorkspace(command.workspaceId);
        if (selected.status === "not_found") {
          return configurationFailure("WORKSPACE_NOT_FOUND");
        }
        if (selected.status === "not_verified") {
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        }
        // Owner decision 2026-10-20: the fixed Git verifiers run the Python
        // safe-open snapshot and the Command Line Tools Git, and only the
        // explicit legacy build keeps them. A Go build refuses with the closed
        // product code before any authority or helper is built, never retries,
        // and never reaches Python or git.
        if (compiledGoCore() !== null) {
          return configurationFailure("WORKSPACE_COMMAND_UNAVAILABLE");
        }
        const action = verificationWorkspaceAction(
          snapshot.settings,
          selected.workspace,
          Date.now() + 30_000,
        );
        if (!action) {
          return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
        }
        const result = await action.execute({
          ownerId: "owner-desktop",
          sessionId: "desktop-command-session",
          taskId: "desktop-command-task",
          taskEpoch: snapshot.settings.computer.generation,
          participantId: "desktop-command-main",
          turnId: `desktop-command-${snapshot.settings.computer.generation}`,
          generation: snapshot.settings.computer.generation,
          callId: randomUUID(),
          workspaceId: selected.workspace.workspaceId,
          operation: {
            kind: "verification.run",
            command: verificationCommand,
            relativePath: ".",
          },
        });
        if (!result.ok) return workspaceCommandFailure(result.error.code);
        if (result.value.output.kind !== "workspace.command") {
          return configurationFailure("WORKSPACE_COMMAND_FAILED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "computer.workspace-command",
            workspaceId: selected.workspace.workspaceId,
            command: result.value.output.command,
            exitCode: result.value.output.exitCode,
            stdout: result.value.output.stdout,
            stderr: result.value.output.stderr,
            outputBytes: result.value.output.outputBytes,
            network: result.value.output.network,
            coverage: result.value.output.coverage,
            layout: result.value.output.layout,
          },
        });
      }
      case "computer.prepare-workspace-edit": {
        if (desktopAdmission.occupied("workspace-mutation")) {
          return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
        }
        const core = compiledGoCore() === null ? null : desktopGoCore();
        if (!core) return configurationFailure("WORKSPACE_READ_FAILED");
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const selected = verifiedProductWorkspace(command.workspaceId);
        if (selected.status === "not_found") {
          return configurationFailure("WORKSPACE_NOT_FOUND");
        }
        if (selected.status === "not_verified") {
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        }
        if (selected.workspace.access !== "write") {
          return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
        }
        // A new edit waits until the outcome of the last one was delivered, so
        // an unknown result is observed instead of being buried under a retry.
        if (snapshot.settings.computer.pendingEdit !== null) {
          return configurationFailure("WORKSPACE_MUTATION_RESULT_PENDING");
        }
        const pending = getPendingWorkspaceEdit();
        if (pending) {
          const pendingStillCurrent =
            Date.now() < pending.expiresAt &&
            pending.computerGeneration ===
              snapshot.settings.computer.generation;
          if (pendingStillCurrent) {
            if (pending.workspaceId !== selected.workspace.workspaceId) {
              return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
            }
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot,
              evidence: workspaceEditPreview(pending),
            });
          }
          setPendingWorkspaceEdit(null);
        }
        const relativePath = await selectedWorkspaceFile(selected.workspace, {
          title: "Choose a text file for a guarded edit",
          buttonLabel: "Review Edit",
        });
        if (relativePath === "cancelled") {
          return configurationFailure("WORKSPACE_FILE_PICKER_CANCELLED");
        }
        if (relativePath === "invalid") {
          return configurationFailure("WORKSPACE_FILE_SELECTION_INVALID");
        }
        const operationId = randomUUID();
        const expiresAt = Date.now() + 10 * 60_000;
        const binding = {
          generation: snapshot.settings.computer.generation,
          workspaceId: selected.workspace.workspaceId,
          relativePath,
          root: {
            path: selected.workspace.root,
            ...selected.workspace.rootIdentity,
          },
        };
        const observed = await readGoWorkspaceSnapshot({
          binding,
          current: () => {
            const now = configuration()?.snapshot();
            const folder =
              now?.status === "ready"
                ? now.settings.computer.workspaces.find(
                    (item) => item.workspaceId === binding.workspaceId,
                  )
                : undefined;
            if (
              desktopGoCore() !== core ||
              now?.status !== "ready" ||
              !folder?.rootIdentity
            )
              return null;
            return {
              generation: now.settings.computer.generation,
              workspaceId: folder.workspaceId,
              relativePath,
              root: { path: folder.root, ...folder.rootIdentity },
            };
          },
          read: (value) =>
            core.snapshotSettingsWorkspace(
              value.generation,
              value.workspaceId,
              value.relativePath,
            ),
        });
        if (!observed.ok) return workspaceReadFailure(observed.code);
        const prepared: PendingWorkspaceEdit = {
          operationId,
          workspaceId: binding.workspaceId,
          computerGeneration: binding.generation,
          relativePath,
          bytes: observed.bytes,
          beforeSha256: observed.sha256,
          expiresAt,
        };
        setPendingWorkspaceEdit(prepared);
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot,
          evidence: workspaceEditPreview(prepared),
        });
      }
      case "computer.apply-workspace-edit": {
        if (desktopAdmission.occupied("workspace-mutation")) {
          return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
        }
        const pending = getPendingWorkspaceEdit();
        if (!pending || pending.operationId !== command.operationId) {
          return configurationFailure("WORKSPACE_MUTATION_PREVIEW_NOT_FOUND");
        }
        if (Date.now() >= pending.expiresAt) {
          setPendingWorkspaceEdit(null);
          return configurationFailure("WORKSPACE_MUTATION_PREVIEW_EXPIRED");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          setPendingWorkspaceEdit(null);
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const workspace = snapshot.settings.computer.workspaces.find(
          (candidate) => candidate.workspaceId === pending.workspaceId,
        );
        const verification = snapshot.settings.setup.computer.verified;
        if (
          !workspace ||
          workspace.access !== "write" ||
          snapshot.settings.computer.generation !==
            pending.computerGeneration ||
          verification?.workspaceId !== pending.workspaceId ||
          verification.configRevision !== pending.computerGeneration
        ) {
          setPendingWorkspaceEdit(null);
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        }
        const goCore = compiledGoCore() === null ? null : desktopGoCore();
        try {
          if (!goCore) throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
          goCore.settingsMutationProfile();
        } catch {
          setPendingWorkspaceEdit(null);
          return configurationFailure("WORKSPACE_MUTATION_FAILED");
        }
        if (snapshot.settings.computer.pendingEdit !== null) {
          setPendingWorkspaceEdit(null);
          return configurationFailure("WORKSPACE_MUTATION_RESULT_PENDING");
        }
        const workspaceAdmission =
          desktopAdmission.reserveAdmitted("workspace-mutation");
        setPendingWorkspaceEdit(null);
        // Settle invariant: bind cleanup to the exact service object obtained
        // at this wrapper setup point, before awaiting the mutation. Do not
        // re-fetch another owner in finally or after owner replacement.
        const editLeaseOwner = configuration();
        try {
          // Go owns durable pending admission, one executor call and the offer.
          return await withSettingsEditLease(
            pending.operationId,
            async () => {
              try {
                const result = await goCore.editSettingsWorkspace(
                  pending.operationId,
                  pending.computerGeneration,
                  pending.workspaceId,
                  pending.relativePath,
                  pending.beforeSha256,
                  command.oldText,
                  command.newText,
                );
                return goWorkspaceEditResult(result, false);
              } catch {
                // No retry and no host-side ACK/invalidation decision. The exact
                // retained pending remains observable through the Go service.
                return configurationFailure(
                  "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
                );
              }
            },
            editLeaseOwner!.releaseWorkspaceEditLease.bind(editLeaseOwner),
          );
        } finally {
          workspaceAdmission.release();
        }
      }
      case "computer.observe-workspace-edit": {
        if (desktopAdmission.occupied("workspace-mutation")) {
          return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const pendingEdit = snapshot.settings.computer.pendingEdit;
        if (pendingEdit?.operationId !== command.operationId) {
          return configurationFailure("WORKSPACE_MUTATION_NOT_PENDING");
        }
        if ("backend" in pendingEdit) {
          try {
            const core = desktopGoCore();
            if (compiledGoCore() === null || !core)
              throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
            const result = await core.observeSettingsMutation({
              backend: pendingEdit.backend,
              operationId: pendingEdit.operationId,
              profileId: pendingEdit.profileId,
              workspaceId: pendingEdit.workspaceId,
              relativePath: pendingEdit.relativePath,
              computerGeneration: String(pendingEdit.computerGeneration),
              beforeSHA256: pendingEdit.beforeSha256,
              submittedAt: pendingEdit.submittedAt,
            });
            return goWorkspaceEditResult(result, true);
          } catch {
            return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
          }
        }
        // Observation reads the durable operation record only: it executes
        // nothing and needs no write authority.
        const observed = await observeWorkspaceEdit(
          { mutationStateRoot: statePaths().workspaceMutations },
          pendingEdit,
        );
        switch (observed.status) {
          case "completed":
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot: configuration()!.snapshot(),
              evidence: {
                kind: "computer.workspace-mutation",
                operationId: observed.operationId,
                workspaceId: pendingEdit.workspaceId,
                relativePath: observed.receipt.relativePath,
                operation: observed.receipt.operation,
                bytes: observed.receipt.bytes,
                replacements: observed.receipt.replacements,
                beforeSha256: observed.receipt.beforeSha256,
                afterSha256: observed.receipt.afterSha256,
                resultRetention: "durable",
                redelivered: observed.redelivered,
              },
            });
          case "failed":
            return workspaceMutationFailure(observed.code);
          case "not_admitted":
            return configurationFailure("WORKSPACE_MUTATION_NOT_ADMITTED");
          case "outcome_unknown":
            await configuration()!.recordComputerMutationOutcomeUnknown(
              pendingEdit.workspaceId,
            );
            return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
          case "unavailable":
            return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
        }
        break;
      }
      case "computer.ack-workspace-edit": {
        if (desktopAdmission.occupied("workspace-mutation"))
          return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const pending = snapshot.settings.computer.pendingEdit;
        if (pending?.operationId !== command.operationId)
          return configurationFailure("WORKSPACE_MUTATION_NOT_PENDING");
        if ("backend" in pending) {
          try {
            if (compiledGoCore() === null || !desktopGoCore())
              throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
            await desktopGoCore()!.acknowledgeSettingsMutation(
              command.operationId,
            );
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot: configuration()!.snapshot(),
            });
          } catch {
            return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
          }
        }
        // Existing-only legacy delivery remains separate until migration is qualified.
        return ProductConfigurationResultSchema.parse(
          await configuration()!.clearPendingWorkspaceEdit(command.operationId),
        );
      }
      case "computer.cancel-workspace-edit":
        if (
          !getPendingWorkspaceEdit() ||
          getPendingWorkspaceEdit()!.operationId !== command.operationId
        ) {
          return configurationFailure("WORKSPACE_MUTATION_PREVIEW_NOT_FOUND");
        }
        setPendingWorkspaceEdit(null);
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
    }
    return configurationFailure("SETTINGS_INPUT_INVALID");
  }

  return Object.freeze({ configureAdmittedComputer });
}

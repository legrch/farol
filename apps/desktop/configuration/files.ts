import path from "node:path";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import type { SettingsDeliveryResult } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { CodexAgentWorkspaceProbe } from "../../../src/apps/desktop/codex-agent-workspace-probe";
import {
  reportComputerCheckDiagnostic,
  refuseComputerSettingsList,
} from "../../../src/apps/desktop/computer-check-diagnostic";
import { GoSettingsListWorkspace } from "../../../src/apps/desktop/go-settings-workspace";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import {
  verifiedProductWorkspace as verifiedWorkspaceOf,
  type VerifiedProductWorkspaceResult,
} from "../../../src/apps/desktop/workspace-descriptor";
import {
  ProductConfigurationResultSchema,
  type ApprovedProductWorkspace,
  type ProductConfigurationResult,
  type ProductSettings,
  type WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";

// The owner-workspace commands the Settings configuration factories reach
// through ports: reading, listing and inspecting a folder, the file the owner
// picks, and the mapping of every read, list, command and mutation failure to
// its product result code. Main keeps every owner; each `let` there is a late
// getter here, so a value is read at the moment it is needed, never at the
// moment this is built. Nothing here constructs an authority grant: the
// verification action that does stays in main.

export type WorkspaceCommandPorts = Readonly<{
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  desktopGoCore: () => Pick<
    DesktopGoCore,
    "inspectSettingsWorkspace" | "listSettingsWorkspace"
  > | null;
  compiledGoCore: () => unknown;
  nativeWorkspace: ConstructorParameters<typeof CodexAgentWorkspaceProbe>[1];
  window: () => BrowserWindow | null;
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<Readonly<{ canceled: boolean; filePaths: string[] }>>;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createWorkspaceCommands(ports: WorkspaceCommandPorts) {
  const {
    configuration,
    configurationFailure,
    desktopGoCore,
    compiledGoCore,
    nativeWorkspace,
    window,
    showOpenDialog,
    env,
  } = ports;

  // S35-TA-4: the composition itself lives in `workspace-descriptor.ts`, so the
  // denied list, the bound identity and the verification rule are exercised by
  // tests rather than restated in them. What stays here is reading the current
  // snapshot.
  function verifiedProductWorkspace(
    workspaceId: string,
  ): VerifiedProductWorkspaceResult {
    const snapshot = configuration()?.snapshot();
    if (!snapshot || snapshot.status !== "ready")
      return { status: "not_found" };
    return verifiedWorkspaceOf(snapshot.settings, workspaceId);
  }

  async function selectedWorkspaceFile(
    workspace: ApprovedProductWorkspace,
    labels: Readonly<{ title: string; buttonLabel: string }>,
  ): Promise<string | "cancelled" | "invalid"> {
    let selected: string | undefined;
    const testFile =
      env.FAROL_E2E === "1" ? env.FAROL_E2E_WORKSPACE_FILE : undefined;
    if (testFile) {
      selected = testFile;
    } else {
      const owner = window();
      if (!owner) return "invalid";
      const result = await showOpenDialog(owner, {
        title: labels.title,
        buttonLabel: labels.buttonLabel,
        defaultPath: workspace.root,
        properties: ["openFile"],
        securityScopedBookmarks: false,
      });
      if (result.canceled || result.filePaths.length !== 1) return "cancelled";
      selected = result.filePaths[0];
    }
    if (!selected || !path.isAbsolute(selected)) return "invalid";
    const relative = path.relative(workspace.root, selected);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return "invalid";
    }
    return relative.split(path.sep).join("/");
  }

  function workspaceReadFailure(code: string): ProductConfigurationResult {
    switch (code) {
      case "WORKSPACE_PATH_REFUSED":
      case "WORKSPACE_ROOT_CHANGED":
      case "WORKSPACE_NOT_FOUND":
      case "WORKSPACE_NOT_A_FILE":
      case "WORKSPACE_FILE_TOO_LARGE":
      case "WORKSPACE_NOT_TEXT":
      case "WORKSPACE_SEARCH_TIMEOUT":
        return configurationFailure(code);
      default:
        return configurationFailure("WORKSPACE_READ_FAILED");
    }
  }

  // The workspace the Codex agent check lists through. A Go build asks the Go
  // settings list and a Go failure is the check's failure: it never dispatches
  // the Python helper. Only the explicit legacy build keeps the native one.
  function codexAgentCheckWorkspace(
    settings: ProductSettings,
  ): ConstructorParameters<typeof CodexAgentWorkspaceProbe>[1] {
    if (compiledGoCore() === null) return nativeWorkspace;
    return new GoSettingsListWorkspace((workspace, relativePath) =>
      listOwnerWorkspace(
        settings.computer.generation,
        workspace,
        workspace.approvedRoot,
        relativePath,
      ),
    );
  }

  // `identity` is a live measurement taken by the same verification attempt
  // (path-bound approval: never the saved pair); null compares path only.
  async function inspectOwnerWorkspace(
    generation: number,
    workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
    identity: WorkspaceRootIdentity | null,
    diagnosticAction: string,
  ): Promise<
    { ok: true; writableByOthers?: true } | { ok: false; code: string }
  > {
    const core = desktopGoCore();
    if (!core) return { ok: false, code: "WORKSPACE_READ_FAILED" };
    try {
      const result = await core.inspectSettingsWorkspace(
        generation,
        workspace.workspaceId,
        ".",
      );
      const current = configuration()?.snapshot();
      if (
        result.root.path !== workspace.root ||
        (identity !== null &&
          (result.root.device !== identity.device ||
            result.root.inode !== identity.inode)) ||
        current?.status !== "ready" ||
        current.settings.computer.generation !== generation
      )
        return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
      return result.writableByOthers === true
        ? { ok: true, writableByOthers: true }
        : { ok: true };
    } catch (error) {
      return refuseComputerSettingsList(
        error,
        console.warn,
        diagnosticAction,
        "go-settings-inspect",
      );
    }
  }

  // Path-bound approval: a list is bound by path and generation; the Go root
  // identity is a live measurement and is not compared with the saved pair.
  async function listOwnerWorkspace(
    generation: number,
    workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
    _savedIdentity: unknown,
    relativePath: string,
    diagnosticAction?: string,
  ): Promise<
    | { ok: true; entries: string[]; truncated: boolean }
    | { ok: false; code: string }
  > {
    const core = desktopGoCore();
    if (!core) {
      if (diagnosticAction)
        reportComputerCheckDiagnostic(
          console.warn,
          diagnosticAction,
          "go-unavailable",
          null,
        );
      return { ok: false, code: "WORKSPACE_READ_FAILED" };
    }
    try {
      const result = await core.listSettingsWorkspace(
        generation,
        workspace.workspaceId,
        relativePath,
      );
      const current = configuration()?.snapshot();
      if (
        result.root.path !== workspace.root ||
        current?.status !== "ready" ||
        current.settings.computer.generation !== generation
      ) {
        if (diagnosticAction)
          reportComputerCheckDiagnostic(
            console.warn,
            diagnosticAction,
            "root-recheck",
            { code: "WORKSPACE_ROOT_CHANGED" },
          );
        return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
      }
      return {
        ok: true,
        entries: result.entries,
        truncated: result.truncated,
      };
    } catch (error) {
      // A refused/unknown Go call never selects the legacy executor.
      return refuseComputerSettingsList(error, console.warn, diagnosticAction);
    }
  }

  function workspaceCommandFailure(code: string): ProductConfigurationResult {
    switch (code) {
      case "AUTHORITY_CAPABILITY_DENIED":
      case "AUTHORITY_COMMAND_DENIED":
      case "AUTHORITY_PATH_DENIED":
        return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
      case "WORKSPACE_COMMAND_UNSUPPORTED":
      case "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE":
      case "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED":
        return configurationFailure("WORKSPACE_COMMAND_UNAVAILABLE");
      case "WORKSPACE_COMMAND_CANCELLED":
        return configurationFailure("WORKSPACE_COMMAND_CANCELLED");
      case "WORKSPACE_COMMAND_TIMEOUT":
        return configurationFailure("WORKSPACE_COMMAND_TIMEOUT");
      case "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE":
        return configurationFailure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE");
      case "WORKSPACE_NOT_GIT_REPOSITORY":
        return configurationFailure("WORKSPACE_NOT_GIT_REPOSITORY");
      case "WORKSPACE_GIT_HEAD_UNBORN":
        return configurationFailure("WORKSPACE_GIT_HEAD_UNBORN");
      case "WORKSPACE_ROOT_CHANGED":
        return configurationFailure("WORKSPACE_ROOT_CHANGED");
      case "WORKSPACE_GIT_METADATA_NOT_APPROVED":
        return configurationFailure("WORKSPACE_GIT_METADATA_NOT_APPROVED");
      // N02: the snapshot route's own closed refusals, surfaced one for one.
      case "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED":
      case "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT":
      case "WORKSPACE_CHANGED_DURING_SNAPSHOT":
      case "WORKSPACE_TRACKED_LIST_TOO_LARGE":
      case "WORKSPACE_TRACKED_PATH_UNSUPPORTED":
      case "WORKSPACE_SNAPSHOT_TOO_LARGE":
      case "WORKSPACE_SNAPSHOT_CROSS_VOLUME":
      case "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED":
      case "WORKSPACE_PATH_REFUSED":
      case "WORKSPACE_NOT_FOUND":
        return configurationFailure(code);
      default:
        return configurationFailure("WORKSPACE_COMMAND_FAILED");
    }
  }

  function workspaceMutationFailure(code: string): ProductConfigurationResult {
    switch (code) {
      case "WORKSPACE_PATH_REFUSED":
      case "WORKSPACE_ROOT_CHANGED":
      case "WORKSPACE_NOT_FOUND":
      case "WORKSPACE_NOT_A_FILE":
      case "WORKSPACE_FILE_TOO_LARGE":
      case "WORKSPACE_NOT_TEXT":
      case "WORKSPACE_MUTATION_CONFLICT":
      case "WORKSPACE_EDIT_NO_MATCH":
      case "WORKSPACE_EDIT_NOT_UNIQUE":
      case "WORKSPACE_MUTATION_OUTCOME_UNKNOWN":
        return configurationFailure(code);
      case "COMPUTER_MUTATION_OPERATION_CONFLICT":
        return configurationFailure("WORKSPACE_MUTATION_CONFLICT");
      case "AUTHORITY_CAPABILITY_DENIED":
      case "AUTHORITY_MUTATION_OWNERSHIP_DENIED":
      case "AUTHORITY_PATH_DENIED":
        return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
      default:
        return configurationFailure("WORKSPACE_MUTATION_FAILED");
    }
  }

  function goWorkspaceEditResult(
    delivery: SettingsDeliveryResult,
    redelivered: boolean,
  ): ProductConfigurationResult {
    const owner = configuration();
    if (!owner) return configurationFailure("SETTINGS_UNAVAILABLE");
    if (delivery.state === "pending")
      return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
    const result = delivery.result!;
    // The Go offer has already performed any required uncertainty invalidation.
    // This adapter only projects the retained result for the React surface.
    if (result.phase !== "completed")
      return workspaceMutationFailure(result.failure!.code);
    const receipt = result.receipt!;
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: owner.snapshot(),
      evidence: {
        kind: "computer.workspace-mutation",
        operationId: result.operationId,
        workspaceId: result.workspaceId,
        relativePath: receipt.relativePath,
        operation: receipt.operation,
        bytes: Number(receipt.bytes),
        replacements: receipt.replacements,
        beforeSha256: receipt.beforeSHA256,
        afterSha256: receipt.afterSHA256,
        resultRetention: delivery.retention,
        redelivered,
      },
    });
  }

  return {
    verifiedProductWorkspace,
    selectedWorkspaceFile,
    workspaceReadFailure,
    codexAgentCheckWorkspace,
    inspectOwnerWorkspace,
    listOwnerWorkspace,
    workspaceCommandFailure,
    workspaceMutationFailure,
    goWorkspaceEditResult,
  };
}

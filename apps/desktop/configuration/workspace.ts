import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserWindow,
  MessageBoxOptions,
  OpenDialogOptions,
} from "electron";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type {
  DiscoveryCandidate,
  DiscoveryResult,
  ExecutableKind,
} from "../../../src/apps/desktop/executable-discovery";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import {
  UNTRUSTED_CANDIDATE_DIALOG,
  reverifyDiscoveredCandidate as reverifyDiscoveredCandidateImpl,
  untrustedCandidateDialogDecision,
  type ConfirmUntrustedCandidate,
} from "../../../src/apps/desktop/reverify-discovered-candidate";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type {
  ProductSettings,
  WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";
import type { DesktopAdmission } from "../host/admission";
import { classifyWorkspaceRootDrift } from "./drift";

// The workspace folder the owner chooses, its measured identity, and the launch
// check that withdraws a folder's approval once the folder is gone. Workspaces
// are bound by path (owner decision 2026-11-22): a changed device or inode at
// the same path is diagnostic only and keeps the check; only a vanished or
// unreachable folder withdraws it. Main keeps every owner; each `let` there is
// a late getter here, so a value is read at the moment it is needed, never at
// the moment this is built. The pending pick stays in main, not here. The
// launch scan holds the authority reservation across its whole measurement and
// write, and never retries or reinterprets a failed withdrawal: it reports that
// the caller must not resume.

export type SelectedWorkspace = Readonly<{
  root: string;
  label: string;
  rootIdentity: WorkspaceRootIdentity;
}>;

export type WorkspaceHostPorts = Readonly<{
  configuration: () => Pick<
    ProductConfigurationService,
    "snapshot" | "withdrawDriftedWorkspaceChecks"
  > | null;
  authorityTransitions: Pick<AuthorityTransitionReservation, "withReservation">;
  desktopAdmission: Pick<DesktopAdmission, "occupied" | "closed">;
  codexAgentOperationActive: () => boolean;
  secureMcpConnectorRuntime: () => Pick<
    SecureMcpConnectorRuntime,
    "isRunning"
  > | null;
  workspaceCheckEvidence: (
    settings: ProductSettings,
    workspaceId: string,
  ) => string;
  window: () => BrowserWindow | null;
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<Readonly<{ canceled: boolean; filePaths: string[] }>>;
  showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<Readonly<{ response: number }>>;
  discoverExecutables: (kind: ExecutableKind) => Promise<DiscoveryResult>;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createWorkspaceHost(ports: WorkspaceHostPorts) {
  const {
    configuration,
    authorityTransitions,
    desktopAdmission,
    codexAgentOperationActive,
    secureMcpConnectorRuntime,
    workspaceCheckEvidence,
    window,
    showOpenDialog,
    showMessageBox,
    discoverExecutables,
    env,
  } = ports;

  // The device and inode a folder has now, so its approval can refuse another
  // object that later takes the same path.
  async function measuredRootIdentity(
    root: string,
  ): Promise<WorkspaceRootIdentity | null> {
    try {
      const measured = await lstat(root, { bigint: true });
      return measured.isDirectory()
        ? { device: String(measured.dev), inode: String(measured.ino) }
        : null;
    } catch {
      return null;
    }
  }

  // Read-only measurement of every identity-bound folder, then one
  // authority-reducing write for folders that are no longer there. Path-bound
  // approval (owner decision 2026-11-22): a changed device or inode at the same
  // path is diagnostic only and keeps the check; only a vanished or unreachable
  // folder withdraws it. Returns false when a vanished folder could not be
  // withdrawn: the caller must then not resume.
  async function withdrawDriftedWorkspaceChecksAtLaunch(): Promise<boolean> {
    const launched = configuration();
    if (!launched) return true;
    let drifted = 0;
    let withdrawn = false;
    let code: string | null = null;
    // The window and Settings IPC are already open. Hold the authority
    // reservation across the WHOLE scan (measurement and write), so a manual
    // Connect or Agent admission cannot start with the stale grant meanwhile.
    const reserved = await authorityTransitions.withReservation(
      "authority-change",
      async () => {
        const snapshot = launched.snapshot();
        if (snapshot.status !== "ready") return;
        const found: {
          workspaceId: string;
          root: string;
          rootIdentity: WorkspaceRootIdentity;
          observed: string;
        }[] = [];
        for (const workspace of snapshot.settings.computer.workspaces) {
          if (!workspace.rootIdentity) continue;
          // Evidence before measuring: a newer check is never erased by it.
          const observed = workspaceCheckEvidence(
            snapshot.settings,
            workspace.workspaceId,
          );
          const measured = await measuredRootIdentity(workspace.root);
          const drift = classifyWorkspaceRootDrift(
            workspace.rootIdentity,
            measured,
          );
          // Numeric drift (a reboot renumbered the volume) and a recreated
          // folder at the same path keep their check: the folder at the path
          // is the workspace. A vanished folder, or one now reached through a
          // linked ancestor (native traversal refuses links), withdraws it.
          if (drift !== "same")
            console.warn(
              `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift })}`,
            );
          const reachable =
            measured !== null &&
            (await realpath(workspace.root).catch(() => null)) ===
              workspace.root;
          if (!reachable)
            found.push({
              workspaceId: workspace.workspaceId,
              root: workspace.root,
              rootIdentity: workspace.rootIdentity,
              observed,
            });
        }
        drifted = found.length;
        if (found.length === 0) {
          withdrawn = true;
          return;
        }
        // Quit may have closed admission while the folders were measured, and a
        // connector or an active Agent may still carry the grant; then leave
        // settings alone (Go's per-call root guard keeps refusing the root).
        if (desktopAdmission.closed()) {
          code = "AUTHORITY_CHANGE_IN_PROGRESS";
          return;
        }
        if (
          codexAgentOperationActive() ||
          desktopAdmission.occupied("connector-task") ||
          secureMcpConnectorRuntime()?.isRunning() === true
        ) {
          code = "CONNECTOR_STOP_REQUIRED";
          return;
        }
        try {
          // Read when the write begins: a service gone since the scan is a
          // failed write, never a silent success.
          const writer = configuration();
          if (!writer) throw new Error("SETTINGS_UNAVAILABLE");
          const result = await writer.withdrawDriftedWorkspaceChecks(
            found,
            () => !desktopAdmission.closed(),
          );
          withdrawn = result.ok;
          code = result.ok ? null : result.error;
        } catch {
          code = "SETTINGS_WRITE_FAILED";
        }
      },
    );
    // A competing authority change owns this moment; do not resume on top of
    // an unmeasured grant. The owner's own operation proceeds as before.
    if (!reserved.admitted) code = "AUTHORITY_CHANGE_IN_PROGRESS";
    if (drifted > 0 || !reserved.admitted)
      console.warn(
        "FAROL_WORKSPACE_ROOT_DRIFT:" +
          JSON.stringify({
            workspaces: drifted,
            withdrawn,
            ...(code ? { code } : {}),
          }),
      );
    return reserved.admitted && withdrawn;
  }

  async function selectedWorkspace(): Promise<
    SelectedWorkspace | "cancelled" | "invalid"
  > {
    if (env.FAROL_E2E === "1" && env.FAROL_E2E_CANCEL_WORKSPACE_PICKER === "1")
      return "cancelled";
    let selected: string | undefined;
    const testRoot =
      env.FAROL_E2E === "1" ? env.FAROL_E2E_WORKSPACE_ROOT : undefined;
    if (testRoot) {
      selected = testRoot;
    } else {
      const owner = window();
      if (!owner) return "invalid";
      const result = await showOpenDialog(owner, {
        title: "Choose a workspace",
        buttonLabel: "Add Workspace",
        properties: ["openDirectory"],
        securityScopedBookmarks: false,
      });
      if (result.canceled || result.filePaths.length !== 1) return "cancelled";
      selected = result.filePaths[0];
    }
    if (!selected || !path.isAbsolute(selected)) return "invalid";
    try {
      const listed = await lstat(selected);
      if (!listed.isDirectory() || listed.isSymbolicLink()) return "invalid";
      const root = await realpath(selected);
      if (!path.isAbsolute(root)) return "invalid";
      const rootIdentity = await measuredRootIdentity(root);
      if (!rootIdentity) return "invalid";
      return { root, label: path.basename(root) || root, rootIdentity };
    } catch {
      return "invalid";
    }
  }

  // A renderer-chosen discovery candidate is never trusted at face value: the
  // main process re-runs discovery itself and only accepts a path that is
  // still a current, non-refused candidate before handing it to the existing
  // execution probes (`verifyCodexExecutable` / `verifyTunnelClientExecutable`,
  // which remain the sole authority on whether a path may actually run). This
  // closes the gap between "the owner clicked a card that was true a moment
  // ago" and "this exact path is still what discovery would offer right now".
  //
  // The decision logic itself lives in `reverify-discovered-candidate.ts`,
  // injectable and unit-tested there; this wrapper supplies the real
  // discovery function and the real owner-facing confirmation dialog.
  async function reverifyDiscoveredCandidate(
    kind: "codex" | "tunnel-client",
    requestedPath: string,
  ): Promise<DiscoveryCandidate | "stale" | "declined"> {
    return reverifyDiscoveredCandidateImpl(kind, requestedPath, {
      discover: (discoverKind) => discoverExecutables(discoverKind),
      // Resolved lazily: the helper reads this only after discovery has
      // finished, so it asks about the window that exists at that moment. A
      // window destroyed while discovery ran yields null here, and a missing
      // window can never confirm an untrusted candidate.
      get confirm(): ConfirmUntrustedCandidate | null {
        const owner = window();
        if (!owner || owner.isDestroyed()) return null;
        return async ({ kind: dialogKind, path }) => {
          const { response } = await showMessageBox(owner, {
            type: "warning",
            buttons: [...UNTRUSTED_CANDIDATE_DIALOG.buttons],
            defaultId: UNTRUSTED_CANDIDATE_DIALOG.defaultId,
            cancelId: UNTRUSTED_CANDIDATE_DIALOG.cancelId,
            message:
              dialogKind === "codex"
                ? "Use a Codex that is not confirmed as signed by OpenAI?"
                : "Use a tunnel-client that does not match the reviewed build?",
            detail: `${path}\n\nFarol could not confirm where this file came from. Continue only if you placed it there yourself.`,
          });
          return untrustedCandidateDialogDecision(response);
        };
      },
    });
  }

  return {
    measuredRootIdentity,
    withdrawDriftedWorkspaceChecksAtLaunch,
    selectedWorkspace,
    reverifyDiscoveredCandidate,
  };
}

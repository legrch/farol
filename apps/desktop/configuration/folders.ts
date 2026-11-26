import path from "node:path";
import type { z } from "zod";
import type {
  ProductSettings,
  WorkspaceGitMetadata,
  WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";
import {
  WORKSPACE_DRIFT_NEEDS_ACTION,
  workspaceCheckEvidence,
  type verificationInputSchema,
  type workspaceInputSchema,
} from "./input";

// The pure settings transforms for the owner's approved folders: approving and
// removing a folder, its exclusions, access and Git history authority, the
// access check and the owner verification that record content-free evidence,
// the folder's root identity, and the launch-time withdrawal of a check whose
// folder no longer matches. Each maps the current settings to the next value
// from a validated input and the clock (or an id source), and each predicate
// decides admission or refusal from settings alone; none reads or writes a
// store, the workspace edit lease, the delivery store or Go authority. The
// service keeps its single serialized writer: it runs these inside `mutate`
// or `commitComputerEvidence`, which own revision admission, the Computer
// approval generation, outcome-unknown fencing and persistence.
//
// Workspaces are bound by path (owner decision 2026-11-22): a saved device and
// inode pair is diagnostic evidence, never rewritten once bound, and only an
// unbound folder takes a measurement. The evidence transforms here never move
// `computer.generation`; `commitComputerEvidence` decides whether the
// resulting approval changed.

type Workspace = ProductSettings["computer"]["workspaces"][number];

export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;
export type WorkspaceVerificationInput = z.infer<
  typeof verificationInputSchema
>;
export type WorkspaceAccess = Workspace["access"];
export type WorkspaceRefusal = "WORKSPACE_NOT_FOUND" | "WORKSPACE_ROOT_CHANGED";
export type FolderAccessCheck = Readonly<{
  workspaceId: string;
  expectedGeneration: number;
  buildId: string;
  rootIdentity: WorkspaceRootIdentity;
  success: boolean;
  checkId?: string | undefined;
  writableByOthers?: true | undefined;
}>;
export type WorkspaceVerificationObservation = Readonly<{
  rootIdentity: WorkspaceRootIdentity;
  checkId?: string | undefined;
  gitMetadata?: WorkspaceGitMetadata | null | undefined;
  writableByOthers?: true | undefined;
}>;
export type WorkspaceVerificationFence = Readonly<{
  expectedGeneration?: number | undefined;
  expectedRoot?: string | undefined;
}>;
export type DriftedWorkspace = Readonly<{
  workspaceId: string;
  root: string;
  rootIdentity: WorkspaceRootIdentity;
  observed: string;
}>;

function findWorkspace(
  settings: ProductSettings,
  workspaceId: string,
): Workspace | undefined {
  return settings.computer.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
}

export function workspaceApproved(
  settings: ProductSettings,
  workspaceId: string,
): boolean {
  return findWorkspace(settings, workspaceId) !== undefined;
}

// A folder already approved by the same root is not added twice; `id` is not
// asked for in that case.
export function withWorkspace(
  settings: ProductSettings,
  input: WorkspaceInput,
  access: WorkspaceAccess,
  id: () => string,
): ProductSettings {
  if (
    settings.computer.workspaces.some(
      (workspace) => workspace.root === input.root,
    )
  ) {
    return settings;
  }
  const workspaces = [
    ...settings.computer.workspaces,
    {
      workspaceId: id(),
      root: input.root,
      label: input.label,
      access,
      excludedPaths: [],
      ...(input.rootIdentity ? { rootIdentity: input.rootIdentity } : {}),
    },
  ];
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      workspaces,
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "unknown" as const,
        verified: null,
        needsAction: "Check access to this workspace.",
        outcomeUnknown: false,
      },
    },
  };
}

export function withoutWorkspace(
  settings: ProductSettings,
  workspaceId: string,
): ProductSettings {
  const workspaces = settings.computer.workspaces.filter(
    (workspace) => workspace.workspaceId !== workspaceId,
  );
  const configured = workspaces.length > 0;
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      workspaces,
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured,
        reachable: "unknown" as const,
        verified: null,
        needsAction: configured
          ? "Verify read access to an approved workspace."
          : "Add a read-only workspace.",
        outcomeUnknown: false,
      },
    },
  };
}

// The same exclusions in the same order change nothing. A changed list drops
// the folder's Git history authority and the Computer verification.
export function withWorkspaceExclusions(
  settings: ProductSettings,
  workspaceId: string,
  excludedPaths: string[],
): ProductSettings {
  const current = findWorkspace(settings, workspaceId);
  if (
    current &&
    JSON.stringify(current.excludedPaths) === JSON.stringify(excludedPaths)
  ) {
    return settings;
  }
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      workspaces: settings.computer.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, excludedPaths, gitHistoryApproved: false }
          : workspace,
      ),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "unknown" as const,
        verified: null,
        needsAction: "Verify read access after changing exclusions.",
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// Changing a folder's access always drops its Git history authority.
export function withWorkspaceAccess(
  settings: ProductSettings,
  workspaceId: string,
  access: WorkspaceAccess,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      workspaces: settings.computer.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, access, gitHistoryApproved: false }
          : workspace,
      ),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction: `Verify ${access} access after changing workspace access.`,
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// Git history can be granted only under workspace commands, to a bound folder
// that the Computer step verified at the current generation. Withdrawing it is
// never refused.
export function workspaceGitHistoryGrantable(
  settings: ProductSettings,
  workspaceId: string,
): boolean {
  const workspace = findWorkspace(settings, workspaceId);
  const verified = settings.setup.computer.verified;
  return !(
    settings.computer.commands !== "workspace" ||
    !workspace?.rootIdentity ||
    verified?.workspaceId !== workspaceId ||
    verified.configRevision !== settings.computer.generation
  );
}

export function withWorkspaceGitHistory(
  settings: ProductSettings,
  workspaceId: string,
  approved: boolean,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      workspaces: settings.computer.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, gitHistoryApproved: approved }
          : workspace,
      ),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction:
          "Verify workspace access after changing Git history authority.",
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// A check is admitted for a known, bound folder at the approval generation it
// was made for. The measured pair is diagnostic only (path-bound approval); the
// generation fence still binds the check to the current approval.
export function folderAccessCheckRefusal(
  settings: ProductSettings,
  workspaceId: string,
  expectedGeneration: number,
): WorkspaceRefusal | null {
  const workspace = findWorkspace(settings, workspaceId);
  if (!workspace) return "WORKSPACE_NOT_FOUND";
  if (
    settings.computer.generation !== expectedGeneration ||
    !workspace.rootIdentity
  )
    return "WORKSPACE_ROOT_CHANGED";
  return null;
}

// The folder's access check is rebuilt on every check, never merged: a failed
// check leaves none, and `writableByOthers` is carried only when reported. The
// evidence stays keyed to the saved (diagnostic) pair.
export function withFolderAccessCheck(
  settings: ProductSettings,
  check: FolderAccessCheck,
  now: () => string,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      workspaces: settings.computer.workspaces.map((item) =>
        item.workspaceId !== check.workspaceId
          ? item
          : {
              ...item,
              accessCheck: check.success
                ? {
                    ...(check.checkId === undefined
                      ? {}
                      : { checkId: check.checkId }),
                    buildId: check.buildId,
                    computerGeneration: check.expectedGeneration,
                    verifiedAt: now(),
                    rootIdentity: item.rootIdentity ?? check.rootIdentity,
                    ...(check.writableByOthers === true
                      ? { writableByOthers: true as const }
                      : {}),
                  }
                : null,
            },
      ),
    },
  };
}

// Binding a legacy unbound folder needs the revision and root the caller
// measured against, and a folder that is still unbound.
export function workspaceRootBindRefusal(
  settings: ProductSettings,
  workspaceId: string,
  expectedRevision: number,
  expectedRoot: string,
): WorkspaceRefusal | null {
  const workspace = findWorkspace(settings, workspaceId);
  if (!workspace) return "WORKSPACE_NOT_FOUND";
  if (
    settings.revision !== expectedRevision ||
    workspace.root !== expectedRoot ||
    workspace.rootIdentity
  )
    return "WORKSPACE_ROOT_CHANGED";
  return null;
}

// Persisting the observation is not a successful check, so the folder's last
// check is withdrawn.
export function withWorkspaceRootIdentity(
  settings: ProductSettings,
  workspaceId: string,
  rootIdentity: WorkspaceRootIdentity,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      workspaces: settings.computer.workspaces.map((item) =>
        item.workspaceId === workspaceId
          ? { ...item, rootIdentity: { ...rootIdentity }, accessCheck: null }
          : item,
      ),
    },
  };
}

// Rebinding after an ordinary remount keeps path and inode: only the device
// number may differ. A different inode is another folder.
export function workspaceRootRebindRefusal(
  settings: ProductSettings,
  workspaceId: string,
  expectedRevision: number,
  expectedRoot: string,
  rootIdentity: WorkspaceRootIdentity,
): WorkspaceRefusal | null {
  const workspace = findWorkspace(settings, workspaceId);
  if (!workspace) return "WORKSPACE_NOT_FOUND";
  const bound = workspace.rootIdentity;
  if (
    settings.revision !== expectedRevision ||
    workspace.root !== expectedRoot ||
    !bound ||
    bound.inode !== rootIdentity.inode
  )
    return "WORKSPACE_ROOT_CHANGED";
  return null;
}

export function workspaceRootRebindUnchanged(
  settings: ProductSettings,
  workspaceId: string,
  rootIdentity: WorkspaceRootIdentity,
): boolean {
  const bound = findWorkspace(settings, workspaceId)?.rootIdentity;
  return (
    bound !== undefined &&
    bound.device === rootIdentity.device &&
    bound.inode === rootIdentity.inode
  );
}

export function withWorkspaceRootRebound(
  settings: ProductSettings,
  workspaceId: string,
  rootIdentity: WorkspaceRootIdentity,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      workspaces: settings.computer.workspaces.map((item) =>
        item.workspaceId === workspaceId
          ? { ...item, rootIdentity: { ...rootIdentity }, accessCheck: null }
          : item,
      ),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        verified: null,
        needsAction: "Check this workspace's access again.",
        reachable: "unknown",
      },
    },
  };
}

// A verification is admitted for a known folder, at the approval generation
// and root the caller measured, when it names them.
export function workspaceVerificationRefusal(
  settings: ProductSettings,
  workspaceId: string,
  fence: WorkspaceVerificationFence,
): WorkspaceRefusal | null {
  const workspace = findWorkspace(settings, workspaceId);
  if (!workspace) return "WORKSPACE_NOT_FOUND";
  if (
    (fence.expectedGeneration !== undefined &&
      settings.computer.generation !== fence.expectedGeneration) ||
    (fence.expectedRoot !== undefined && workspace.root !== fence.expectedRoot)
  )
    return "WORKSPACE_ROOT_CHANGED";
  return null;
}

// Owner verification is when a folder is bound: an unbound folder takes the
// measurement and a bound one keeps its saved pair unchanged (it is part of
// the published approval, so rewriting it would be a policy change). It also
// approves exactly the linked Git metadata it observed, or clears a grant when
// the metadata now lives inside the root (null). The clock is read once for the
// folder's check and once for the Computer step's verification, in that order.
export function withWorkspaceVerification(
  settings: ProductSettings,
  workspaceId: string,
  input: WorkspaceVerificationInput,
  observed: WorkspaceVerificationObservation,
  now: () => string,
): ProductSettings {
  const bound = findWorkspace(settings, workspaceId)?.rootIdentity;
  const rootIdentity = bound ?? observed.rootIdentity;
  const bind = (workspace: Workspace): Workspace => {
    if (workspace.workspaceId !== workspaceId) return workspace;
    const { gitMetadata: _previous, ...rest } = workspace;
    // A primary checkout's first measurement records the in-root layout
    // covered by its explicit full-Git grant. Linked/outside layouts and
    // changes to a previous binding still require renewed approval.
    const initialApprovedPrimary =
      workspace.gitHistoryApproved === true &&
      workspace.gitMetadata === undefined &&
      observed.gitMetadata?.gitDirectory ===
        path.join(workspace.root, ".git") &&
      observed.gitMetadata?.commonDirectory ===
        path.join(workspace.root, ".git");
    const metadataChanged =
      observed.gitMetadata !== undefined &&
      (observed.gitMetadata?.gitDirectory !==
        workspace.gitMetadata?.gitDirectory ||
        observed.gitMetadata?.commonDirectory !==
          workspace.gitMetadata?.commonDirectory);
    return {
      ...(observed.gitMetadata === undefined ? workspace : rest),
      rootIdentity,
      ...(metadataChanged && !initialApprovedPrimary
        ? { gitHistoryApproved: false }
        : {}),
      accessCheck: {
        ...(observed.checkId === undefined
          ? {}
          : { checkId: observed.checkId }),
        buildId: input.buildId,
        computerGeneration: settings.computer.generation,
        verifiedAt: now(),
        rootIdentity,
        ...(observed.writableByOthers === true
          ? { writableByOthers: true as const }
          : {}),
      },
      ...(observed.gitMetadata ? { gitMetadata: observed.gitMetadata } : {}),
    };
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      workspaces: settings.computer.workspaces.map(bind),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "reachable",
        verified: {
          ...input,
          configRevision: settings.computer.generation,
          workspaceId,
          verifiedAt: now(),
        },
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// An uncertain file effect in a folder: the Computer step can no longer claim
// verification until the owner inspects the file.
export function withComputerMutationOutcomeUnknown(
  settings: ProductSettings,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction:
          "Inspect the selected file, then verify workspace access again.",
        unavailable: null,
        outcomeUnknown: true,
      },
    },
  };
}

// The withdrawal is conditioned on exactly what the caller observed: the
// folder's root, its stored identity and its check evidence (`observed`, from
// `workspaceCheckEvidence`). An unrelated save cannot discard detected drift,
// and a newer successful check cannot be erased by an older observation.
export function driftedWorkspaceRefusal(
  settings: ProductSettings,
  drifted: readonly DriftedWorkspace[],
): "WORKSPACE_ROOT_CHANGED" | null {
  for (const item of drifted) {
    const workspace = findWorkspace(settings, item.workspaceId);
    if (
      !workspace ||
      workspace.root !== item.root ||
      workspace.rootIdentity?.device !== item.rootIdentity.device ||
      workspace.rootIdentity?.inode !== item.rootIdentity.inode ||
      workspaceCheckEvidence(settings, item.workspaceId) !== item.observed
    )
      return "WORKSPACE_ROOT_CHANGED";
  }
  return null;
}

function driftedVerification(
  settings: ProductSettings,
  ids: ReadonlySet<string>,
): boolean {
  const verifiedId = settings.setup.computer.verified?.workspaceId;
  return verifiedId != null && ids.has(verifiedId);
}

// Already withdrawn (a folder still missing on every launch): nothing is left
// to reduce, so the caller must not write again.
export function driftedWorkspaceWithdrawn(
  settings: ProductSettings,
  drifted: readonly DriftedWorkspace[],
): boolean {
  const ids = new Set(drifted.map((item) => item.workspaceId));
  return (
    !driftedVerification(settings, ids) &&
    settings.connectors.secureMcp.runtime === null &&
    settings.setup.computer.reachable === "unknown" &&
    settings.setup.computer.needsAction === WORKSPACE_DRIFT_NEEDS_ACTION &&
    settings.computer.workspaces.every(
      (item) => !ids.has(item.workspaceId) || item.accessCheck == null,
    )
  );
}

// Only reduces authority: it never rebinds and keeps the approval and ID. The
// drifted folders' checks, the saved connector runtime that carried the grant
// and a Computer verification of a drifted folder are withdrawn.
export function withDriftedWorkspaceChecksWithdrawn(
  settings: ProductSettings,
  drifted: readonly DriftedWorkspace[],
): ProductSettings {
  const ids = new Set(drifted.map((item) => item.workspaceId));
  const verifiedDrifted = driftedVerification(settings, ids);
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      workspaces: settings.computer.workspaces.map((item) =>
        ids.has(item.workspaceId) ? { ...item, accessCheck: null } : item,
      ),
    },
    connectors: {
      ...settings.connectors,
      secureMcp: { ...settings.connectors.secureMcp, runtime: null },
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        ...(verifiedDrifted ? { verified: null } : {}),
        needsAction: WORKSPACE_DRIFT_NEEDS_ACTION,
        reachable: "unknown",
      },
    },
  };
}

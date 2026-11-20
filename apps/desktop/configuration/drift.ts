import type {
  ApprovedProductWorkspace,
  ProductConfigurationSnapshot,
  ProductSettings,
  WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";
import { workspaceCheckEvidence } from "../../../src/apps/desktop/product-configuration";
import type { resumeComputerConnector } from "../../../src/apps/desktop/connector-resume-policy";
import type { ContinuitySequenceResult } from "../../../src/apps/desktop/workspace-continuity-sequence";

/**
 * How a saved workspace root compares with the directory now at its path.
 *
 * - `same`: device and inode both match.
 * - `device-renumbered`: same inode, different device. macOS renumbers the
 *   startup Data volume at boot, so this is the ordinary reboot case, but it is
 *   NOT proof of the same folder: a copied disk image mounted at the same path
 *   keeps the inode, and a same-inode directory can appear once a mount over
 *   the path goes away. Only enrolled continuity evidence may rebind it.
 * - `different-object`: the inode differs; this is another directory.
 * - `unmeasured`: nothing to compare (unbound record or no directory now).
 *
 * The classification is an observation. It never authorizes a rebind.
 */
export type WorkspaceRootDrift =
  "same" | "device-renumbered" | "different-object" | "unmeasured";

export function classifyWorkspaceRootDrift(
  bound: WorkspaceRootIdentity | undefined,
  measured: WorkspaceRootIdentity | null,
): WorkspaceRootDrift {
  if (!bound || !measured) return "unmeasured";
  if (bound.inode !== measured.inode) return "different-object";
  return bound.device === measured.device ? "same" : "device-renumbered";
}

export type WorkspaceDriftObservation = Readonly<{
  workspaceId: string;
  root: string;
  rootIdentity: WorkspaceRootIdentity;
  observed: string;
}>;

type RecoveryCandidate = WorkspaceDriftObservation & {
  enrollmentId: string;
  accessCheck: ApprovedProductWorkspace["accessCheck"];
};

export async function scanWorkspaceRootDrift(
  settings: ProductSettings,
  ports: Readonly<{
    measure(root: string): Promise<WorkspaceRootIdentity | null>;
    recoveryQualified(): Promise<true | "unavailable">;
  }>,
) {
  const withdraw: WorkspaceDriftObservation[] = [];
  const candidates: RecoveryCandidate[] = [];
  for (const workspace of settings.computer.workspaces) {
    if (!workspace.rootIdentity) continue;
    const observation = {
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      rootIdentity: workspace.rootIdentity,
      observed: workspaceCheckEvidence(settings, workspace.workspaceId),
    };
    const drift = classifyWorkspaceRootDrift(
      observation.rootIdentity,
      await ports.measure(workspace.root),
    );
    if (drift === "same") continue;
    if (drift === "device-renumbered" && workspace.continuity) {
      candidates.push({
        ...observation,
        enrollmentId: workspace.continuity.enrollment.operationId,
        accessCheck: workspace.accessCheck,
      });
    } else {
      withdraw.push(observation);
    }
  }
  if (candidates.length && (await ports.recoveryQualified()) !== true)
    return { withdraw: [...withdraw, ...candidates], candidates: [] };
  return { withdraw, candidates };
}

function stillBound(
  workspace: ApprovedProductWorkspace | undefined,
  candidate: RecoveryCandidate,
): boolean {
  return (
    workspace?.root === candidate.root &&
    workspace.rootIdentity?.device === candidate.rootIdentity.device &&
    workspace.rootIdentity.inode === candidate.rootIdentity.inode &&
    workspace.continuity?.enrollment.operationId === candidate.enrollmentId &&
    // A newer check for this folder supersedes the launch observation. The
    // Computer-wide witness can change when checking a different candidate.
    JSON.stringify(workspace.accessCheck ?? null) ===
      JSON.stringify(candidate.accessCheck ?? null)
  );
}

export async function healWorkspaceDriftAfterResume(
  status: Awaited<ReturnType<typeof resumeComputerConnector>>,
  candidates: readonly RecoveryCandidate[],
  ports: Readonly<{
    mayContinue(): boolean;
    current(): ProductConfigurationSnapshot;
    connectorRunning(): boolean;
    heal(
      id: string,
      mode: "enrolled-rebind",
    ): Promise<ContinuitySequenceResult>;
    verify(id: string): Promise<{ ok: boolean }>;
    start(): Promise<{ ok: boolean }>;
    fallback(
      observations: readonly WorkspaceDriftObservation[],
      state: "refused" | "unknown" | "unavailable",
    ): Promise<void>;
  }>,
): Promise<void> {
  if (status !== "started") return;
  for (const [index, candidate] of candidates.entries()) {
    if (!ports.mayContinue()) return;
    const snapshot = ports.current();
    if (snapshot.status !== "ready") return;
    const { settings } = snapshot;
    const current = (id: string) =>
      settings.computer.workspaces.find(
        (workspace) => workspace.workspaceId === id,
      );
    const id = candidate.workspaceId;
    if (!stillBound(current(id), candidate)) continue;
    const pending = candidates
      .slice(index)
      .filter((item) => stillBound(current(item.workspaceId), item))
      .map((item) => ({
        ...item,
        observed: workspaceCheckEvidence(settings, item.workspaceId),
      }));
    const outcome = ports.connectorRunning()
      ? await ports
          .heal(id, "enrolled-rebind")
          .catch(() => ({ state: "unknown" }) as const)
      : ({ state: "unavailable" } as const);
    if (!ports.mayContinue()) return;
    if (outcome.state !== "current-qualified") {
      // A refused or unconfirmed drain cannot supply a running prerequisite
      // for any remaining folder. Withdraw their stale evidence together.
      await ports.fallback(
        pending,
        outcome.state === "committed-not-active"
          ? "unavailable"
          : outcome.state,
      );
      return;
    }
    if (!(await ports.verify(id)).ok || !ports.mayContinue()) return;
    if (!ports.connectorRunning() && !(await ports.start()).ok) return;
  }
}

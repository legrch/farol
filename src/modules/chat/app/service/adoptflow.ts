import type { HandoffAdopt } from "../port/handoff";
import { adoptConflict, adoptRecorded } from "./recordbinding";
import { adoptedReadStillAllowed, type HandoffFlowDeps } from "./handoffdeps";
import {
  isDigest,
  isUuid,
  sameWorkspace,
  validWorkspace,
} from "./handoffvalidation";
import type { runObserve } from "./readflow";

export async function runAdopt(
  deps: HandoffFlowDeps,
  observe: (
    request: Parameters<typeof runObserve>[1],
  ) => ReturnType<typeof runObserve>,
  request: HandoffAdopt,
) {
  const unknown = {
    status: "outcome_unknown" as const,
    dispatchId: request.turnId,
  };
  if (
    request.threadId !== deps.selectedOwnerThreadId ||
    !isUuid(request.turnId) ||
    !deps.digester.digestAdopt
  )
    return { status: "refused" as const, code: "HANDOFF_ADOPT_DENIED" };
  if (deps.now() >= deps.mutationExpiresAt)
    return {
      status: "refused" as const,
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    };
  const workspace = await deps.authority.resolve(request.workspaceId);
  if (!validWorkspace(workspace))
    return {
      status: "refused" as const,
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    };
  const observed = await observe(request);
  if (observed.status === "refused") return observed;
  if (observed.status !== "observed") return unknown;
  const matches = observed.turns.filter((turn) => turn.id === request.turnId);
  if (matches.length > 1) return unknown;
  if (matches.length === 0)
    return observed.hasMoreTurns
      ? unknown
      : { status: "refused" as const, code: "HANDOFF_ADOPT_TURN_MISSING" };
  const current = await deps.authority.resolve(request.workspaceId);
  if (!validWorkspace(current) || !sameWorkspace(current, workspace))
    return { status: "refused" as const, code: "HANDOFF_WORKSPACE_CHANGED" };
  if (deps.now() >= deps.mutationExpiresAt)
    return {
      status: "refused" as const,
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    };
  const digest = deps.digester.digestAdopt(request);
  if (!isDigest(digest))
    return { status: "refused" as const, code: "HANDOFF_DIGEST_INVALID" };
  try {
    let record = await deps.journal.read(request.turnId);
    if (!record) {
      record = await deps.journal.reserve(request.turnId, {
        requestDigest: digest,
        adopted: true,
        workspaceId: request.workspaceId,
        workspace,
        projectId: request.projectId,
        threadIntent: false,
        turnIntent: false,
      });
    }
    if (adoptConflict(record, digest, request, workspace))
      return { status: "refused" as const, code: "HANDOFF_ADOPT_CONFLICT" };
    if (!record.threadIntent) {
      if (!(await deps.journal.claimThread(request.turnId))) return unknown;
    }
    if (!record.threadId)
      await deps.journal.recordThread(request.turnId, request.threadId);
    if (!record.turnIntent) {
      if (!(await deps.journal.claimTurn(request.turnId))) return unknown;
    }
    if (!record.turnId)
      await deps.journal.recordTurn(request.turnId, request.turnId);
    record = await deps.journal.read(request.turnId);
    if (!adoptRecorded(record, request)) return unknown;
    if (!(await adoptedReadStillAllowed(deps, record!))) return unknown;
    return { status: "adopted" as const, dispatchId: request.turnId };
  } catch {
    // The operation is local and read-only to the provider. An uncertain
    // journal record is never interpreted as a different task or turn.
    return unknown;
  }
}

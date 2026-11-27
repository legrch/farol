import type {
  HandoffAuthority,
  HandoffHost,
  HandoffJournal,
  HandoffMutationGate,
  HandoffReadContext,
  HandoffRecord,
  HandoffRequestDigester,
} from "../port/handoff";
import { readAllowed } from "./admission";
import { samePhysicalWorkspace, validWorkspace } from "./handoffvalidation";

export class HandoffNotSubmittedError extends Error {}

// The ports and admission window a handoff flow reads. It carries no mutable
// state of its own: every flow receives the same values the service holds.
export type HandoffFlowDeps = Readonly<{
  authority: HandoffAuthority;
  host: HandoffHost;
  journal: HandoffJournal;
  digester: HandoffRequestDigester;
  mutationExpiresAt: number;
  mutationGate: HandoffMutationGate;
  now: () => number;
  selectedOwnerThreadId?: string | undefined;
}>;

export function supportsDispatchAttempts(deps: HandoffFlowDeps): boolean {
  return (
    !!deps.journal.claimDispatchAttempt && !!deps.journal.recordPreEffectRefusal
  );
}

export function readStillAllowed(
  deps: HandoffFlowDeps,
  context: HandoffReadContext,
): boolean {
  return readAllowed(context, deps.now);
}

export function dispatchStillAllowed(
  deps: HandoffFlowDeps,
  context: HandoffReadContext,
): boolean {
  return deps.now() < deps.mutationExpiresAt && readStillAllowed(deps, context);
}

export function readHost(
  deps: HandoffFlowDeps,
  context: HandoffReadContext,
): HandoffHost {
  return {
    request: async (method, params) => {
      if (!readStillAllowed(deps, context))
        throw new Error("HANDOFF_READ_ADMISSION_ENDED");
      const response = await deps.host.request(
        method,
        params,
        context.deadlineAt,
      );
      if (!readStillAllowed(deps, context))
        throw new Error("HANDOFF_READ_ADMISSION_ENDED");
      return response;
    },
  };
}

export async function adoptedReadStillAllowed(
  deps: HandoffFlowDeps,
  record: HandoffRecord,
): Promise<boolean> {
  if (
    record.adopted !== true ||
    record.threadId !== deps.selectedOwnerThreadId ||
    deps.now() >= deps.mutationExpiresAt
  )
    return false;
  const current = await deps.authority.resolve(record.workspaceId);
  return (
    deps.now() < deps.mutationExpiresAt &&
    validWorkspace(current) &&
    samePhysicalWorkspace(current, record.workspace)
  );
}

export async function resultReadStillAllowed(
  deps: HandoffFlowDeps,
  record: HandoffRecord,
): Promise<boolean> {
  if (record.adopted) return adoptedReadStillAllowed(deps, record);
  const current = await deps.authority.resolve(record.workspaceId);
  return (
    validWorkspace(current) && samePhysicalWorkspace(current, record.workspace)
  );
}

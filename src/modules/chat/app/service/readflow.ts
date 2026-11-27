import type { HandoffReadContext } from "../port/handoff";
import type {
  TaskHistoryRequest,
  TaskHistoryResult,
} from "../port/codex-task-history";
import { mutationAdmitted } from "./admission";
import { exactProject } from "./exactproject";
import {
  readHost,
  readStillAllowed,
  type HandoffFlowDeps,
} from "./handoffdeps";
import {
  identifier,
  isUuid,
  object,
  samePhysicalWorkspace,
  validWorkspace,
} from "./handoffvalidation";
import { historyVerdict } from "./projectresult";
import { readCodexTaskHistory, historyCursor } from "./read-codex-task-history";
import { readCodexThreadRuntime } from "./read-codex-thread-runtime";
import { resolveCodexProjectCatalogue } from "./resolve-codex-project-catalogue";
import {
  observedModel,
  observedNameInvalid,
  threadBound,
} from "./threadbinding";
import { observedTurns } from "./turnpage";
import { threadReadParams } from "./turnrequest";

export async function runHistory(
  deps: HandoffFlowDeps,
  request: TaskHistoryRequest,
  context: Readonly<{ signal?: AbortSignal | undefined }> = {},
): Promise<TaskHistoryResult> {
  const refused = (code: string): TaskHistoryResult =>
    historyVerdict(request, "refused", code);
  if (
    request.threadId !== deps.selectedOwnerThreadId ||
    !isUuid(request.threadId) ||
    !isUuid(request.turnId) ||
    !identifier(request.workspaceId) ||
    !identifier(request.projectId) ||
    (request.cursor !== undefined && !historyCursor(request.cursor)) ||
    (request.tail !== undefined && typeof request.tail !== "boolean")
  )
    return refused("HANDOFF_HISTORY_INPUT_INVALID");
  const isAdmitted = () =>
    mutationAdmitted(context.signal, deps.now, deps.mutationExpiresAt);
  const revoke = () =>
    refused(
      context.signal?.aborted
        ? "HANDOFF_HISTORY_CANCELLED"
        : "HANDOFF_TASK_ADMISSION_DENIED",
    );
  if (!isAdmitted()) return revoke();
  try {
    const workspace = await deps.authority.resolve(request.workspaceId);
    if (!validWorkspace(workspace))
      return refused("HANDOFF_WORKSPACE_UNVERIFIED");
    if (!isAdmitted()) return revoke();
    const project = await resolveCodexProjectCatalogue(
      deps.host,
      workspace.project.root,
      request.projectId,
      deps.mutationExpiresAt,
      isAdmitted,
    );
    if (!isAdmitted()) return revoke();
    if (project.status === "unavailable")
      return historyVerdict(request, "unavailable", project.code);
    if (
      project.status !== "resolved" ||
      project.selectedProjectId !== request.projectId
    )
      return refused("HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING");
    const beforeRead = await deps.authority.resolve(request.workspaceId);
    if (
      !validWorkspace(beforeRead) ||
      !samePhysicalWorkspace(beforeRead, workspace)
    )
      return refused("HANDOFF_WORKSPACE_CHANGED");
    if (!isAdmitted()) return revoke();
    const result = await readCodexTaskHistory(
      deps.host,
      request,
      workspace.root,
      deps.mutationExpiresAt,
      isAdmitted,
    );
    if (!isAdmitted()) return revoke();
    const afterRead = await deps.authority.resolve(request.workspaceId);
    if (
      !validWorkspace(afterRead) ||
      !samePhysicalWorkspace(afterRead, workspace)
    )
      return refused("HANDOFF_WORKSPACE_CHANGED");
    return isAdmitted() ? result : revoke();
  } catch {
    return isAdmitted()
      ? historyVerdict(request, "unavailable", "HANDOFF_HISTORY_UNAVAILABLE")
      : revoke();
  }
}

export async function runObserve(
  deps: HandoffFlowDeps,
  request: Readonly<{
    threadId: string;
    workspaceId: string;
    projectId: string;
  }>,
  context: HandoffReadContext = {},
) {
  const denied = () => ({
    status: "refused" as const,
    code: "HANDOFF_TASK_ADMISSION_DENIED",
  });
  if (!readStillAllowed(deps, context)) return denied();
  const host = readHost(deps, context);
  if (
    !isUuid(request.threadId) ||
    !identifier(request.workspaceId) ||
    !identifier(request.projectId)
  )
    return {
      status: "refused" as const,
      code: "HANDOFF_OBSERVE_INPUT_INVALID",
    };
  const workspace = await deps.authority.resolve(request.workspaceId);
  if (!readStillAllowed(deps, context)) return denied();
  if (!validWorkspace(workspace))
    return {
      status: "refused" as const,
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    };
  try {
    if (!(await exactProject(host, request.projectId, workspace.project.root)))
      return {
        status: "refused" as const,
        code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
      };
    const response = object(
      await host.request("thread/read", threadReadParams(request.threadId)),
    );
    const thread = object(response?.thread);
    if (
      !threadBound(thread, request.threadId, request.projectId, workspace.root)
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_OBSERVE_THREAD_BINDING_CHANGED",
      };
    if (observedNameInvalid(thread.name))
      return {
        status: "outcome_unknown" as const,
        threadId: request.threadId,
      };
    const threadRuntime = readCodexThreadRuntime(thread.status);
    if (!threadRuntime)
      return {
        status: "outcome_unknown" as const,
        threadId: request.threadId,
      };
    const page = object(
      await host.request("thread/turns/list", {
        threadId: request.threadId,
        cursor: null,
        limit: 100,
        itemsView: "notLoaded",
      }),
    );
    const observed = observedTurns(page);
    if (!observed)
      return {
        status: "outcome_unknown" as const,
        threadId: request.threadId,
      };
    const current = await deps.authority.resolve(request.workspaceId);
    if (!readStillAllowed(deps, context)) return denied();
    if (!validWorkspace(current) || !samePhysicalWorkspace(current, workspace))
      return {
        status: "refused" as const,
        code: "HANDOFF_WORKSPACE_CHANGED",
      };
    return {
      status: "observed" as const,
      threadId: request.threadId,
      title: typeof thread.name === "string" ? thread.name : null,
      model: observedModel(thread),
      turns: observed.turns,
      hasMoreTurns: observed.hasMoreTurns,
      threadRuntime,
    };
  } catch {
    if (!readStillAllowed(deps, context)) return denied();
    // Read failure cannot authorize a retry with a new task or turn.
    return { status: "outcome_unknown" as const, threadId: request.threadId };
  }
}

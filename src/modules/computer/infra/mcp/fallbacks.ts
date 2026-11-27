// What a caller is told when a Codex task read or lookup could not answer.
// Each shape is fixed: callers key on `status` and `code`, so the field order
// and names must not drift between the tools that share a code.

export function lookupUnavailable(request: object) {
  return {
    status: "unavailable" as const,
    ...request,
    code: "HANDOFF_PROJECT_PREFERENCE_LOOKUP_UNAVAILABLE",
  };
}

// Remembering may have published; reading cannot have. Only the first is an
// unknown outcome.
export function preferenceUnavailable(
  request: Readonly<{
    operation: string;
    key: string;
    workspaceId: string;
    projectId: string;
  }>,
) {
  return {
    status:
      request.operation === "remember"
        ? ("outcome_unknown" as const)
        : ("unavailable" as const),
    key: request.key,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    code: "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE",
  };
}

export function tasksUnavailable(
  request: Readonly<{ workspaceId: string; projectId: string }>,
) {
  return {
    status: "unavailable" as const,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    code: "HANDOFF_PROJECT_TASKS_UNAVAILABLE",
  };
}

export function resolveRefused(workspaceId: string) {
  return {
    status: "refused" as const,
    workspaceId,
    code: "HANDOFF_PROJECT_RESOLVE_UNAVAILABLE",
  };
}

export function historyUnavailable(
  request: Readonly<{ threadId: string; turnId: string }>,
) {
  return {
    status: "unavailable" as const,
    threadId: request.threadId,
    turnId: request.turnId,
    code: "HANDOFF_HISTORY_UNAVAILABLE",
  };
}

export function observeUnknown(threadId: string) {
  return { status: "outcome_unknown" as const, threadId };
}

// A read refused before or after the work because the task is no longer
// admitted. Observe reports it as refused, the others as unavailable.
export function admissionRefused() {
  return {
    status: "refused" as const,
    code: "HANDOFF_TASK_ADMISSION_DENIED",
  };
}

export function admissionUnavailable() {
  return {
    status: "unavailable" as const,
    code: "HANDOFF_TASK_ADMISSION_DENIED",
  };
}

export function catalogueUnavailable(
  code: "TASK_MODEL_CATALOG_INVALID" | "TASK_MODEL_CATALOG_UNAVAILABLE",
) {
  return { status: "unavailable" as const, code };
}

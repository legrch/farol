import type {
  ProjectPreferenceLookupRequest,
  ProjectPreferenceLookupResult,
  ProjectPreferenceRecord,
  ProjectPreferenceRequest,
  ProjectPreferenceResult,
} from "../port/codex-project-preference";
import type { ProjectResolutionResult } from "../port/codex-project-catalogue";
import type {
  ProjectTaskDiscoveryRequest,
  ProjectTaskDiscoveryResult,
} from "../port/codex-project-tasks";
import type {
  TaskHistoryRequest,
  TaskHistoryResult,
} from "../port/codex-task-history";
import type { HandoffWorkspace } from "../port/handoff";
import { sameProject } from "./handoffvalidation";

export function lookupVerdict(
  request: ProjectPreferenceLookupRequest,
  status: "missing" | "refused" | "unavailable" | "stale_preference",
  code: string,
): ProjectPreferenceLookupResult {
  return { ...request, status, code };
}

export function lookupResolved(
  request: ProjectPreferenceLookupRequest,
  key: string,
): ProjectPreferenceLookupResult {
  return {
    ...request,
    status: "resolved",
    key,
    persistence: "immutable-local-receipt",
    selection: "latest-local-publication",
    snapshot: "non-atomic",
    controlGranted: false,
  };
}

export function preferenceVerdict(
  request: ProjectPreferenceRequest,
  status: "refused" | "unavailable" | "stale_preference" | "outcome_unknown",
  code: string,
): ProjectPreferenceResult {
  return {
    status,
    key: request.key,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    code,
  };
}

export function preferenceStored(
  request: ProjectPreferenceRequest,
): ProjectPreferenceResult {
  return {
    status: request.operation === "remember" ? "remembered" : "resolved",
    key: request.key,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    persistence: "immutable-local-receipt",
    catalogue: "current-non-atomic",
    controlGranted: false,
  };
}

export function sameRecord(
  value: ProjectPreferenceRecord,
  record: ProjectPreferenceRecord,
): boolean {
  return (
    value.projectId === record.projectId &&
    sameProject(value.project, record.project)
  );
}

export function tasksVerdict(
  request: ProjectTaskDiscoveryRequest,
  status: "refused" | "unavailable",
  code: string,
): ProjectTaskDiscoveryResult {
  return {
    status,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    code,
  };
}

export function tasksQuery(
  request: ProjectTaskDiscoveryRequest,
  workspace: HandoffWorkspace,
) {
  return {
    projectId: request.projectId,
    writerRoot: workspace.root,
    scope: request.scope,
    ...(request.scope === "canonical-and-selected-writer"
      ? { canonicalRoot: workspace.project.root }
      : {}),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

export function resolveRefused(
  workspaceId: string,
  code: string,
): ProjectResolutionResult {
  return { status: "refused", workspaceId, code };
}

export function historyVerdict(
  request: TaskHistoryRequest,
  status: "refused" | "unavailable",
  code: string,
): TaskHistoryResult {
  return {
    status,
    threadId: request.threadId,
    turnId: request.turnId,
    code,
  };
}

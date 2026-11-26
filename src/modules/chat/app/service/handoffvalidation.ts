import type {
  HandoffMessage,
  HandoffRequest,
  HandoffWorkspace,
} from "../port/handoff";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
}

export function validRequest(request: HandoffRequest): boolean {
  if (request.modelBinding) {
    const selection = object(request.modelBinding.selection);
    if (
      selection?.harness !== "codex" ||
      typeof selection?.modelAlias !== "string" ||
      !/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u.test(selection.modelAlias) ||
      selection.modelAlias.length > 80 ||
      selection.model !== request.model ||
      selection.effort !== request.reasoningEffort ||
      !/^[a-f0-9]{64}$/u.test(request.modelBinding.configSha256)
    )
      return false;
  }
  return (
    isUuid(request.key) &&
    identifier(request.workspaceId) &&
    identifier(request.projectId) &&
    request.message.length > 0 &&
    new TextEncoder().encode(request.message).byteLength <= 8_192 &&
    !request.message.includes("\0") &&
    /^[A-Za-z0-9_.\/-]{1,120}$/u.test(request.model) &&
    (request.reasoningEffort === undefined ||
      /^[A-Za-z0-9_-]{1,40}$/u.test(request.reasoningEffort))
  );
}

export function validMessage(request: HandoffMessage): boolean {
  return (
    isUuid(request.key) &&
    isUuid(request.dispatchId) &&
    identifier(request.workspaceId) &&
    identifier(request.projectId) &&
    request.message.length > 0 &&
    new TextEncoder().encode(request.message).byteLength <= 8_192 &&
    !request.message.includes("\0") &&
    /^[A-Za-z0-9_.\/-]{1,120}$/u.test(request.model) &&
    (request.reasoningEffort === undefined ||
      /^[A-Za-z0-9_-]{1,40}$/u.test(request.reasoningEffort))
  );
}

export function validWorkspace(value: unknown): value is HandoffWorkspace {
  const workspace = object(value);
  const project = object(workspace?.project);
  const execution = object(workspace?.execution);
  return (
    typeof workspace?.root === "string" &&
    workspace.root.startsWith("/") &&
    typeof workspace.device === "string" &&
    workspace.device.length > 0 &&
    typeof workspace.inode === "string" &&
    workspace.inode.length > 0 &&
    typeof workspace.gitCommonDirectory === "string" &&
    workspace.gitCommonDirectory.startsWith("/") &&
    typeof project?.root === "string" &&
    project.root.startsWith("/") &&
    typeof project.device === "string" &&
    project.device.length > 0 &&
    typeof project.inode === "string" &&
    project.inode.length > 0 &&
    project.gitCommonDirectory === workspace.gitCommonDirectory &&
    ["read-only", "workspace-write"].includes(execution?.sandbox as string) &&
    ["untrusted", "on-request"].includes(execution?.approvalPolicy as string)
  );
}

export function sameProject(
  left: HandoffWorkspace["project"],
  right: HandoffWorkspace["project"],
): boolean {
  return (
    left.root === right.root &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.gitCommonDirectory === right.gitCommonDirectory
  );
}

export function samePhysicalWorkspace(
  left: HandoffWorkspace,
  right: HandoffWorkspace,
): boolean {
  return (
    left.root === right.root &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.gitCommonDirectory === right.gitCommonDirectory &&
    sameProject(left.project, right.project)
  );
}

export function sameWorkspace(
  left: HandoffWorkspace,
  right: HandoffWorkspace,
): boolean {
  return (
    samePhysicalWorkspace(left, right) &&
    left.execution.sandbox === right.execution.sandbox &&
    left.execution.approvalPolicy === right.execution.approvalPolicy
  );
}

import type {
  ProjectEnsureContext,
  ProjectEnsureIntent,
  ProjectEnsureRequest,
  ProjectEnsureResult,
} from "../port/codex-project-ensure";
import type { HandoffWorkspace } from "./persistent-codex-handoff";
import { resolveCodexProjectCatalogue } from "./resolve-codex-project-catalogue";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
const name = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= 200;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const sameProject = (left: unknown, right: HandoffWorkspace["project"]) => {
  const project = object(left);
  return (
    project !== null &&
    Object.keys(project).length === 4 &&
    project.root === right.root &&
    project.device === right.device &&
    project.inode === right.inode &&
    project.gitCommonDirectory === right.gitCommonDirectory
  );
};
const sameWorkspace = (left: HandoffWorkspace, right: HandoffWorkspace) =>
  left.root === right.root &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.gitCommonDirectory === right.gitCommonDirectory &&
  sameProject(left.project, right.project) &&
  left.execution.sandbox === right.execution.sandbox &&
  left.execution.approvalPolicy === right.execution.approvalPolicy;
function intent(
  value: unknown,
  project: HandoffWorkspace["project"],
): ProjectEnsureIntent | null {
  const record = object(value);
  if (
    !record ||
    Object.keys(record).sort().join(",") !==
      "acknowledgedProjectId,key,name,project" ||
    typeof record.key !== "string" ||
    !uuid.test(record.key) ||
    !name(record.name) ||
    !sameProject(record.project, project) ||
    (record.acknowledgedProjectId !== null &&
      !identifier(record.acknowledgedProjectId))
  )
    return null;
  return {
    key: record.key,
    name: record.name,
    project: { ...project },
    acknowledgedProjectId: record.acknowledgedProjectId as string | null,
  };
}
function acknowledged(
  value: unknown,
  expected: ProjectEnsureIntent,
): string | null {
  const project = object(object(value)?.project);
  return project &&
    identifier(project.id) &&
    project.name === expected.name &&
    Array.isArray(project.roots) &&
    project.roots.length === 1 &&
    object(project.roots[0])?.path === expected.project.root
    ? project.id
    : null;
}

/** Unwired pure contract. No native create capability, adapter or MCP grant is enabled.
 * Journal adapters must durably reserve one canonical physical identity across keys.
 * Inspect is observational; an uncertain create never becomes a successful replay. */
export async function ensureCodexProject(
  context: ProjectEnsureContext,
  supplied: ProjectEnsureRequest,
): Promise<ProjectEnsureResult> {
  const request = { ...supplied };
  const refused = (code: string): ProjectEnsureResult => ({
    status: "refused",
    code,
    controlGranted: false,
  });
  const unknown = (
    code: string,
    observedProjectId?: string,
  ): ProjectEnsureResult => ({
    status: "outcome_unknown",
    key: request.key,
    code,
    ...(observedProjectId === undefined ? {} : { observedProjectId }),
    controlGranted: false,
  });
  const admitted = () =>
    context.admitted() && context.now() < context.expiresAt;
  if (
    typeof request.key !== "string" ||
    !uuid.test(request.key) ||
    !identifier(request.workspaceId) ||
    !name(request.name) ||
    !["ensure", "inspect"].includes(request.mode) ||
    (request.preferredProjectId !== undefined &&
      !identifier(request.preferredProjectId))
  )
    return refused("PROJECT_ENSURE_INPUT_INVALID");
  let claimed = false;
  try {
    if (!admitted()) return refused("PROJECT_ENSURE_ADMISSION_DENIED");
    const current = await context.authority.resolve(request.workspaceId);
    if (!current || !admitted())
      return refused("PROJECT_ENSURE_ADMISSION_DENIED");
    const workspace: HandoffWorkspace = {
      ...current,
      project: { ...current.project },
      execution: { ...current.execution },
    };
    const authorized = async () => {
      if (!admitted()) return false;
      const physical = await context.authority.resolve(request.workspaceId);
      return !!physical && admitted() && sameWorkspace(physical, workspace);
    };
    const stored = await context.journal.read(workspace.project);
    if (!(await authorized()) || !admitted())
      return refused("PROJECT_ENSURE_ADMISSION_DENIED");
    const prior = stored === null ? null : intent(stored, workspace.project);
    if (stored !== null && !prior)
      return unknown("PROJECT_ENSURE_INTENT_UNREADABLE");
    const catalogue = await resolveCodexProjectCatalogue(
      context.host.catalogue,
      workspace.project.root,
      request.preferredProjectId,
      context.expiresAt,
      admitted,
    );
    if (!(await authorized()) || !admitted())
      return refused("PROJECT_ENSURE_ADMISSION_DENIED");
    if (catalogue.status === "unavailable")
      return {
        status: "unavailable",
        code: catalogue.code,
        controlGranted: false,
      };
    // Pending intent owns this physical project regardless of the caller's new key.
    // A current unique match is observation, not proof of the unknown creation.
    if (prior?.acknowledgedProjectId === null)
      return unknown(
        "PROJECT_CREATE_ACK_UNKNOWN",
        request.mode === "inspect" && catalogue.status === "resolved"
          ? catalogue.selectedProjectId!
          : undefined,
      );
    if (catalogue.status === "stale_preference")
      return { status: "stale_preference", controlGranted: false };
    if (catalogue.status === "ambiguous")
      return {
        status: "ambiguous",
        matches: catalogue.matches,
        controlGranted: false,
      };
    if (catalogue.status === "resolved") {
      if (prior && prior.acknowledgedProjectId !== catalogue.selectedProjectId)
        return unknown("PROJECT_ENSURE_CONFIRMED_PROJECT_CHANGED");
      return {
        status: "resolved",
        projectId: catalogue.selectedProjectId!,
        proof: "current-catalogue",
        controlGranted: false,
      };
    }
    if (prior) return unknown("PROJECT_ENSURE_CONFIRMED_PROJECT_MISSING");
    if (request.mode === "inspect")
      return { status: "missing", controlGranted: false };
    if (context.projectCreateAdmitted !== true)
      return refused("PROJECT_CREATE_NOT_QUALIFIED");
    const pending: ProjectEnsureIntent = {
      key: request.key,
      name: request.name,
      project: { ...workspace.project },
      acknowledgedProjectId: null,
    };
    const result = await context.gate.run<ProjectEnsureResult>(
      async () => {
        if (!(await authorized()) || !admitted())
          throw Error("PROJECT_ENSURE_ADMISSION_DENIED");
      },
      async () => {
        // Uncertain durable publication is unknown, never permission to repeat.
        claimed = true;
        if (!(await context.journal.claim(pending)))
          throw Error("PROJECT_ENSURE_CLAIM_CONFLICT");
        if (!(await authorized()) || !admitted())
          throw Error("PROJECT_ENSURE_ADMISSION_CHANGED_AFTER_INTENT");
        const response = await context.host.create(
          {
            idempotencyKey: pending.key,
            name: pending.name,
            roots: [{ path: workspace.project.root }],
          },
          context.expiresAt,
        );
        const projectId = acknowledged(response, pending);
        if (!projectId) throw Error("PROJECT_CREATE_ACK_INVALID");
        if (!(await authorized()) || !admitted())
          throw Error("PROJECT_ENSURE_ADMISSION_CHANGED_AFTER_CREATE");
        const after = await resolveCodexProjectCatalogue(
          context.host.catalogue,
          workspace.project.root,
          projectId,
          context.expiresAt,
          admitted,
        );
        if (!(await authorized()) || !admitted())
          throw Error("PROJECT_ENSURE_ADMISSION_CHANGED_AFTER_CREATE");
        if (
          after.status !== "resolved" ||
          after.matches.length !== 1 ||
          after.selectedProjectId !== projectId
        )
          throw Error("PROJECT_CREATE_READBACK_UNVERIFIED");
        await context.journal.confirm(
          workspace.project,
          pending.key,
          projectId,
        );
        if (!(await authorized()) || !admitted())
          throw Error("PROJECT_ENSURE_ADMISSION_CHANGED_AFTER_CONFIRM");
        return {
          status: "created",
          projectId,
          proof: "create-ack-and-current-catalogue",
          controlGranted: false,
        };
      },
      () => false,
    );
    // Releasing a gate is asynchronous too; its earlier snapshot is not final
    // authority for disclosure after revocation, expiry or physical replacement.
    if (!(await authorized()) || !admitted())
      return unknown("PROJECT_ENSURE_ADMISSION_CHANGED_AFTER_GATE");
    return result;
  } catch {
    return unknown(
      claimed ? "PROJECT_ENSURE_EFFECT_UNKNOWN" : "PROJECT_ENSURE_READ_UNKNOWN",
    );
  }
}

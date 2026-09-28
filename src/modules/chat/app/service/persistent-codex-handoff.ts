import type { ProjectResolutionResult } from "../port/codex-project-catalogue";
import { resolveCodexProjectCatalogue } from "./resolve-codex-project-catalogue";
import type {
  TaskHistoryRequest,
  TaskHistoryResult,
} from "../port/codex-task-history";
import { historyCursor, readCodexTaskHistory } from "./read-codex-task-history";

export type HandoffModelBinding = Readonly<{
  selection: Readonly<{
    harness: string;
    modelAlias: string;
    model: string;
    effort?: string | undefined;
  }>;
  configSha256: string;
}>;

export type HandoffRequest = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
  message: string;
  model: string;
  reasoningEffort?: string | undefined;
  modelBinding?: HandoffModelBinding | undefined;
}>;

export type HandoffMessage = Readonly<{
  key: string;
  dispatchId: string;
  workspaceId: string;
  projectId: string;
  message: string;
  model: string;
  reasoningEffort?: string | undefined;
}>;

export type HandoffContinue = Readonly<{
  key: string;
  dispatchId: string;
  message: string;
}>;

export type HandoffAdopt = Readonly<{
  threadId: string;
  turnId: string;
  workspaceId: string;
  projectId: string;
}>;

export type HandoffMessageResult =
  | Readonly<{ status: "steered"; dispatchId: string; turnId: string }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;

export type HandoffWorkspace = Readonly<{
  root: string;
  device: string;
  inode: string;
  gitCommonDirectory: string;
  project: Readonly<{
    root: string;
    device: string;
    inode: string;
    gitCommonDirectory: string;
  }>;
  execution: Readonly<{
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "untrusted" | "on-request";
  }>;
}>;

export type HandoffRecord = Readonly<{
  requestDigest: string;
  adopted?: true | undefined;
  model?: string;
  reasoningEffort?: string | undefined;
  modelBinding?: HandoffModelBinding | undefined;
  continuedFrom?: string | undefined;
  continuationVerified?: boolean | undefined;
  workspaceId: string;
  workspace: HandoffWorkspace;
  projectId: string;
  threadId?: string;
  turnId?: string;
  threadIntent: boolean;
  turnIntent: boolean;
}>;

export interface HandoffJournal {
  reserve(key: string, record: HandoffRecord): Promise<HandoffRecord>;
  claimThread(key: string): Promise<boolean>;
  recordThread(key: string, threadId: string): Promise<void>;
  claimTurn(key: string): Promise<boolean>;
  recordTurn(key: string, turnId: string): Promise<void>;
  claimContinuation?(
    parentKey: string,
    parentTurnId: string,
    key: string,
  ): Promise<boolean>;
  confirmContinuation?(key: string, turnId: string): Promise<void>;
  hasUnconfirmedMessage?(dispatchId: string): Promise<boolean>;
  read(key: string): Promise<HandoffRecord | null>;
  claimMessage(
    dispatchId: string,
    key: string,
    digest: string,
  ): Promise<"claimed" | "existing" | "conflict">;
  readMessage(
    dispatchId: string,
    key: string,
  ): Promise<Readonly<{ digest: string; turnId: string | null }> | null>;
  recordMessage(dispatchId: string, key: string, turnId: string): Promise<void>;
}

export interface HandoffAuthority {
  // The caller supplies only an ID. The owner-approved Computer binding is
  // resolved by the trusted host, including its current physical root.
  resolve(workspaceId: string): Promise<HandoffWorkspace | null>;
}

export interface HandoffHost {
  request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown>;
}

export class HandoffNotSubmittedError extends Error {}

export interface HandoffRequestDigester {
  digest(request: HandoffRequest): string;
  digestMessage(request: HandoffMessage): string;
  digestContinue?(request: HandoffContinue): string;
  digestAdopt?(request: HandoffAdopt): string;
}

export interface HandoffMutationGate {
  run<T>(
    preflight: () => Promise<void>,
    effect: () => Promise<T>,
    safeToReleaseError: (error: unknown) => boolean,
  ): Promise<T>;
}

export type HandoffCreateResult =
  | Readonly<{
      status: "dispatched";
      dispatchId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;

export type HandoffStatusResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{
      status: "known";
      dispatchId: string;
      threadId: string;
      turnId: string;
      turnStatus: string;
    }>;

export type HandoffResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{
      status: "running" | "failed" | "interrupted";
      dispatchId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      status: "completed";
      dispatchId: string;
      threadId: string;
      turnId: string;
      finalItemId: string;
      text: string;
    }>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
}

function validRequest(request: HandoffRequest): boolean {
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      request.key,
    ) &&
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

function validMessage(request: HandoffMessage): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      request.key,
    ) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      request.dispatchId,
    ) &&
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

function validWorkspace(value: unknown): value is HandoffWorkspace {
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

function samePhysicalWorkspace(
  left: HandoffWorkspace,
  right: HandoffWorkspace,
): boolean {
  return (
    left.root === right.root &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.gitCommonDirectory === right.gitCommonDirectory &&
    left.project.root === right.project.root &&
    left.project.device === right.project.device &&
    left.project.inode === right.project.inode &&
    left.project.gitCommonDirectory === right.project.gitCommonDirectory
  );
}

function sameWorkspace(
  left: HandoffWorkspace,
  right: HandoffWorkspace,
): boolean {
  return (
    samePhysicalWorkspace(left, right) &&
    left.execution.sandbox === right.execution.sandbox &&
    left.execution.approvalPolicy === right.execution.approvalPolicy
  );
}

export async function exactProject(
  host: HandoffHost,
  projectId: string,
  root: string,
): Promise<boolean> {
  const matched: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 32; page += 1) {
    const response = object(
      await host.request("project/list", { cursor, limit: 100 }),
    );
    if (!response || !Array.isArray(response.data)) return false;
    for (const item of response.data) {
      const project = object(item);
      if (
        !project ||
        !identifier(project.id) ||
        !Array.isArray(project.roots)
      ) {
        return false;
      }
      if (project.roots.some((entry) => object(entry)?.path === root)) {
        matched.push(project.id);
      }
    }
    if (response.nextCursor === null) {
      return matched.length === 1 && matched[0] === projectId;
    }
    if (
      typeof response.nextCursor !== "string" ||
      response.nextCursor.length === 0 ||
      seen.has(response.nextCursor)
    ) {
      return false;
    }
    cursor = response.nextCursor;
    seen.add(cursor);
  }
  return false;
}

export class PersistentCodexHandoff {
  constructor(
    private readonly authority: HandoffAuthority,
    private readonly host: HandoffHost,
    private readonly journal: HandoffJournal,
    private readonly digester: HandoffRequestDigester,
    private readonly mutationExpiresAt: number,
    private readonly mutationGate: HandoffMutationGate,
    private readonly now: () => number = Date.now,
    private readonly selectedOwnerThreadId?: string,
  ) {}

  async resolveProject(
    request: Readonly<{
      workspaceId: string;
      preferredProjectId?: string | undefined;
    }>,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<ProjectResolutionResult> {
    const refused = (code: string): ProjectResolutionResult => ({
      status: "refused",
      workspaceId: request.workspaceId,
      code,
    });
    if (
      !identifier(request.workspaceId) ||
      (request.preferredProjectId !== undefined &&
        !identifier(request.preferredProjectId))
    )
      return refused("HANDOFF_PROJECT_RESOLVE_INPUT_INVALID");
    if (this.now() >= this.mutationExpiresAt)
      return refused("HANDOFF_PROJECT_ADMISSION_EXPIRED");
    if (context.signal?.aborted)
      return refused("HANDOFF_PROJECT_READ_CANCELLED");
    let workspace;
    try {
      workspace = await this.authority.resolve(request.workspaceId);
    } catch {
      return refused("HANDOFF_AUTHORITY_UNAVAILABLE");
    }
    if (!validWorkspace(workspace))
      return refused("HANDOFF_WORKSPACE_UNVERIFIED");
    if (this.now() >= this.mutationExpiresAt)
      return refused("HANDOFF_PROJECT_ADMISSION_EXPIRED");
    if (context.signal?.aborted)
      return refused("HANDOFF_PROJECT_READ_CANCELLED");
    const result = await resolveCodexProjectCatalogue(
      this.host,
      workspace.project.root,
      request.preferredProjectId,
      this.mutationExpiresAt,
      () => !context.signal?.aborted && this.now() < this.mutationExpiresAt,
    );
    let current;
    try {
      current = await this.authority.resolve(request.workspaceId);
    } catch {
      return refused("HANDOFF_AUTHORITY_UNAVAILABLE");
    }
    if (!validWorkspace(current) || !sameWorkspace(workspace, current))
      return refused("HANDOFF_WORKSPACE_BINDING_CHANGED");
    if (this.now() >= this.mutationExpiresAt)
      return refused("HANDOFF_PROJECT_ADMISSION_EXPIRED");
    if (context.signal?.aborted)
      return refused("HANDOFF_PROJECT_READ_CANCELLED");
    return {
      ...result,
      workspaceId: request.workspaceId,
      writerRoot: workspace.root,
      projectRoot: workspace.project.root,
    };
  }

  async history(
    request: TaskHistoryRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<TaskHistoryResult> {
    const refused = (code: string): TaskHistoryResult => ({
      status: "refused",
      threadId: request.threadId,
      turnId: request.turnId,
      code,
    });
    if (
      request.threadId !== this.selectedOwnerThreadId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.threadId,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.turnId,
      ) ||
      !identifier(request.workspaceId) ||
      !identifier(request.projectId) ||
      (request.cursor !== undefined && !historyCursor(request.cursor)) ||
      (request.tail !== undefined && typeof request.tail !== "boolean")
    )
      return refused("HANDOFF_HISTORY_INPUT_INVALID");
    const isAdmitted = () =>
      !context.signal?.aborted && this.now() < this.mutationExpiresAt;
    const revoke = () =>
      refused(
        context.signal?.aborted
          ? "HANDOFF_HISTORY_CANCELLED"
          : "HANDOFF_TASK_ADMISSION_DENIED",
      );
    if (!isAdmitted()) return revoke();
    try {
      const workspace = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(workspace))
        return refused("HANDOFF_WORKSPACE_UNVERIFIED");
      if (!isAdmitted()) return revoke();
      const project = await resolveCodexProjectCatalogue(
        this.host,
        workspace.project.root,
        request.projectId,
        this.mutationExpiresAt,
        isAdmitted,
      );
      if (!isAdmitted()) return revoke();
      if (project.status === "unavailable")
        return {
          status: "unavailable",
          threadId: request.threadId,
          turnId: request.turnId,
          code: project.code,
        };
      if (
        project.status !== "resolved" ||
        project.selectedProjectId !== request.projectId
      )
        return refused("HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING");
      const beforeRead = await this.authority.resolve(request.workspaceId);
      if (
        !validWorkspace(beforeRead) ||
        !samePhysicalWorkspace(beforeRead, workspace)
      )
        return refused("HANDOFF_WORKSPACE_CHANGED");
      if (!isAdmitted()) return revoke();
      const result = await readCodexTaskHistory(
        this.host,
        request,
        workspace.root,
        this.mutationExpiresAt,
        isAdmitted,
      );
      if (!isAdmitted()) return revoke();
      const afterRead = await this.authority.resolve(request.workspaceId);
      if (
        !validWorkspace(afterRead) ||
        !samePhysicalWorkspace(afterRead, workspace)
      )
        return refused("HANDOFF_WORKSPACE_CHANGED");
      return isAdmitted() ? result : revoke();
    } catch {
      return isAdmitted()
        ? {
            status: "unavailable",
            threadId: request.threadId,
            turnId: request.turnId,
            code: "HANDOFF_HISTORY_UNAVAILABLE",
          }
        : revoke();
    }
  }

  async observe(
    request: Readonly<{
      threadId: string;
      workspaceId: string;
      projectId: string;
    }>,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.threadId,
      ) ||
      !identifier(request.workspaceId) ||
      !identifier(request.projectId)
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_OBSERVE_INPUT_INVALID",
      };
    const workspace = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(workspace))
      return {
        status: "refused" as const,
        code: "HANDOFF_WORKSPACE_UNVERIFIED",
      };
    try {
      if (
        !(await exactProject(
          this.host,
          request.projectId,
          workspace.project.root,
        ))
      )
        return {
          status: "refused" as const,
          code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
        };
      const response = object(
        await this.host.request("thread/read", {
          threadId: request.threadId,
          includeTurns: false,
        }),
      );
      const thread = object(response?.thread);
      if (
        thread?.id !== request.threadId ||
        thread?.projectId !== request.projectId ||
        thread?.cwd !== workspace.root
      )
        return {
          status: "refused" as const,
          code: "HANDOFF_OBSERVE_THREAD_BINDING_CHANGED",
        };
      const page = object(
        await this.host.request("thread/turns/list", {
          threadId: request.threadId,
          cursor: null,
          limit: 100,
          itemsView: "notLoaded",
        }),
      );
      if (
        !Array.isArray(page?.data) ||
        page.data.length > 100 ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))
      )
        return {
          status: "outcome_unknown" as const,
          threadId: request.threadId,
        };
      const turns = page.data.map(object);
      if (
        turns.some(
          (turn) =>
            !identifier(turn?.id) ||
            !["inProgress", "completed", "failed", "interrupted"].includes(
              turn?.status as string,
            ),
        )
      )
        return {
          status: "outcome_unknown" as const,
          threadId: request.threadId,
        };
      const current = await this.authority.resolve(request.workspaceId);
      if (
        !validWorkspace(current) ||
        !samePhysicalWorkspace(current, workspace)
      )
        return {
          status: "refused" as const,
          code: "HANDOFF_WORKSPACE_CHANGED",
        };
      return {
        status: "observed" as const,
        threadId: request.threadId,
        title:
          typeof thread.title === "string" && thread.title.length <= 1_000
            ? thread.title
            : null,
        model:
          typeof thread.model === "string" && thread.model.length <= 120
            ? thread.model
            : null,
        turns: turns.map((turn) => ({
          id: turn!.id as string,
          status: turn!.status as string,
        })),
        hasMoreTurns: page.nextCursor !== null,
      };
    } catch {
      // Read failure cannot authorize a retry with a new task or turn.
      return { status: "outcome_unknown" as const, threadId: request.threadId };
    }
  }

  async adopt(request: HandoffAdopt) {
    const unknown = {
      status: "outcome_unknown" as const,
      dispatchId: request.turnId,
    };
    if (
      request.threadId !== this.selectedOwnerThreadId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.turnId,
      ) ||
      !this.digester.digestAdopt
    )
      return { status: "refused" as const, code: "HANDOFF_ADOPT_DENIED" };
    if (this.now() >= this.mutationExpiresAt)
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    const workspace = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(workspace))
      return {
        status: "refused" as const,
        code: "HANDOFF_WORKSPACE_UNVERIFIED",
      };
    const observed = await this.observe(request);
    if (observed.status === "refused") return observed;
    if (observed.status !== "observed") return unknown;
    const matches = observed.turns.filter((turn) => turn.id === request.turnId);
    if (matches.length > 1) return unknown;
    if (matches.length === 0)
      return observed.hasMoreTurns
        ? unknown
        : { status: "refused" as const, code: "HANDOFF_ADOPT_TURN_MISSING" };
    const current = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(current) || !sameWorkspace(current, workspace))
      return { status: "refused" as const, code: "HANDOFF_WORKSPACE_CHANGED" };
    if (this.now() >= this.mutationExpiresAt)
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    const digest = this.digester.digestAdopt(request);
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return { status: "refused" as const, code: "HANDOFF_DIGEST_INVALID" };
    try {
      let record = await this.journal.read(request.turnId);
      if (!record) {
        record = await this.journal.reserve(request.turnId, {
          requestDigest: digest,
          adopted: true,
          workspaceId: request.workspaceId,
          workspace,
          projectId: request.projectId,
          threadIntent: false,
          turnIntent: false,
        });
      }
      if (
        record.adopted !== true ||
        record.requestDigest !== digest ||
        record.workspaceId !== request.workspaceId ||
        record.projectId !== request.projectId ||
        !sameWorkspace(record.workspace, workspace) ||
        (record.threadId !== undefined &&
          record.threadId !== request.threadId) ||
        (record.turnId !== undefined && record.turnId !== request.turnId)
      )
        return { status: "refused" as const, code: "HANDOFF_ADOPT_CONFLICT" };
      if (!record.threadIntent) {
        if (!(await this.journal.claimThread(request.turnId))) return unknown;
      }
      if (!record.threadId)
        await this.journal.recordThread(request.turnId, request.threadId);
      if (!record.turnIntent) {
        if (!(await this.journal.claimTurn(request.turnId))) return unknown;
      }
      if (!record.turnId)
        await this.journal.recordTurn(request.turnId, request.turnId);
      record = await this.journal.read(request.turnId);
      if (
        record?.adopted !== true ||
        record.threadId !== request.threadId ||
        record.turnId !== request.turnId
      )
        return unknown;
      if (!(await this.adoptedReadStillAllowed(record))) return unknown;
      return { status: "adopted" as const, dispatchId: request.turnId };
    } catch {
      // The operation is local and read-only to the provider. An uncertain
      // journal record is never interpreted as a different task or turn.
      return unknown;
    }
  }

  async message(request: HandoffMessage): Promise<HandoffMessageResult> {
    if (!validMessage(request))
      return { status: "refused", code: "HANDOFF_INPUT_INVALID" };
    if (this.now() >= this.mutationExpiresAt)
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    const digest = this.digester.digestMessage(request);
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return { status: "refused", code: "HANDOFF_DIGEST_INVALID" };
    let record: HandoffRecord | null;
    let prior: Awaited<ReturnType<HandoffJournal["readMessage"]>>;
    try {
      record = await this.journal.read(request.dispatchId);
      if (!record?.threadId || !record.turnId)
        return { status: "refused", code: "HANDOFF_DISPATCH_UNKNOWN" };
      if (record.adopted)
        return { status: "refused", code: "HANDOFF_ADOPTED_READ_ONLY" };
      if (record.continuedFrom && record.continuationVerified !== true)
        return { status: "outcome_unknown", dispatchId: request.dispatchId };
      prior = await this.journal.readMessage(request.dispatchId, request.key);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    }
    if (prior?.digest !== undefined && prior.digest !== digest)
      return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
    if (prior) {
      return prior.turnId === record.turnId
        ? {
            status: "steered",
            dispatchId: request.dispatchId,
            turnId: prior.turnId,
          }
        : { status: "outcome_unknown", dispatchId: request.dispatchId };
    }
    if (
      record.workspaceId !== request.workspaceId ||
      record.projectId !== request.projectId ||
      record.model !== request.model ||
      record.reasoningEffort !== request.reasoningEffort
    )
      return { status: "refused", code: "HANDOFF_DISPATCH_BINDING_CHANGED" };
    const turnId = record.turnId;
    const workspace = await this.authority.resolve(record.workspaceId);
    if (
      !validWorkspace(workspace) ||
      !sameWorkspace(workspace, record.workspace)
    )
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    try {
      if (
        !(await exactProject(
          this.host,
          record.projectId,
          workspace.project.root,
        ))
      )
        return {
          status: "refused",
          code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
        };
      const response = object(
        await this.host.request("thread/read", {
          threadId: record.threadId,
          includeTurns: false,
        }),
      );
      const thread = object(response?.thread);
      if (
        !record.model ||
        thread?.id !== record.threadId ||
        thread?.projectId !== record.projectId ||
        thread?.cwd !== workspace.root ||
        thread?.model !== record.model
      )
        return { status: "outcome_unknown", dispatchId: request.dispatchId };
      const status = await this.status(request.dispatchId);
      if (status.status !== "known")
        return { status: "outcome_unknown", dispatchId: request.dispatchId };
      if (status.turnId !== turnId || status.turnStatus !== "inProgress")
        return { status: "refused", code: "HANDOFF_TURN_NOT_ACTIVE" };
      const stillApproved = await this.authority.resolve(record.workspaceId);
      if (
        !validWorkspace(stillApproved) ||
        !sameWorkspace(stillApproved, workspace)
      )
        return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    } catch {
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    }
    let claim: "claimed" | "existing" | "conflict";
    try {
      claim = await this.journal.claimMessage(
        request.dispatchId,
        request.key,
        digest,
      );
    } catch {
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    }
    if (claim === "conflict")
      return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
    if (claim !== "claimed")
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    // The durable intent precedes the only host side effect. A lost response
    // or failed receipt never permits a replay with the same or a new key.
    try {
      const atSend = await this.authority.resolve(record.workspaceId);
      if (
        this.now() >= this.mutationExpiresAt ||
        !validWorkspace(atSend) ||
        !sameWorkspace(atSend, workspace)
      )
        return { status: "outcome_unknown", dispatchId: request.dispatchId };
      await this.mutationGate.run(
        async () => {
          const stillCurrent = await this.authority.resolve(record.workspaceId);
          if (
            this.now() >= this.mutationExpiresAt ||
            !validWorkspace(stillCurrent) ||
            !sameWorkspace(stillCurrent, workspace)
          )
            throw new Error("HANDOFF_PREFLIGHT_DENIED");
        },
        async () => {
          if (this.now() >= this.mutationExpiresAt)
            throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
          const response = object(
            await this.host.request(
              "turn/steer",
              {
                threadId: record.threadId,
                expectedTurnId: turnId,
                input: [{ type: "text", text: request.message }],
                clientUserMessageId: request.key,
              },
              this.mutationExpiresAt,
            ),
          );
          if (response?.turnId !== turnId)
            throw new Error("HANDOFF_STEER_UNVERIFIED");
        },
        (error) => error instanceof HandoffNotSubmittedError,
      );
      await this.journal.recordMessage(request.dispatchId, request.key, turnId);
      return {
        status: "steered",
        dispatchId: request.dispatchId,
        turnId,
      };
    } catch {
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    }
  }

  async continue(request: HandoffContinue): Promise<HandoffCreateResult> {
    const unknown = {
      status: "outcome_unknown" as const,
      dispatchId: request.key,
    };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.key,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        request.dispatchId,
      ) ||
      request.key.toLowerCase() === request.dispatchId.toLowerCase() ||
      typeof request.message !== "string" ||
      request.message.trim().length === 0 ||
      request.message.includes("\0") ||
      new TextEncoder().encode(request.message).byteLength > 8_192
    )
      return { status: "refused", code: "HANDOFF_CONTINUE_INPUT_INVALID" };
    if (this.now() >= this.mutationExpiresAt)
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (
      !this.digester.digestContinue ||
      !this.journal.claimContinuation ||
      !this.journal.confirmContinuation ||
      !this.journal.hasUnconfirmedMessage
    )
      return { status: "refused", code: "HANDOFF_CONTINUE_UNAVAILABLE" };
    const digest = this.digester.digestContinue(request);
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return { status: "refused", code: "HANDOFF_DIGEST_INVALID" };

    let parent: HandoffRecord | null;
    let child: HandoffRecord | null;
    try {
      parent = await this.journal.read(request.dispatchId);
      child = await this.journal.read(request.key);
    } catch {
      return unknown;
    }
    if (!parent?.threadId || !parent.turnId) return unknown;
    if (parent.adopted)
      return { status: "refused", code: "HANDOFF_ADOPTED_READ_ONLY" };
    if (parent.continuedFrom && parent.continuationVerified !== true)
      return unknown;
    try {
      if (await this.journal.hasUnconfirmedMessage(request.dispatchId))
        return unknown;
    } catch {
      return unknown;
    }
    if (!parent.model || (!parent.reasoningEffort && !parent.modelBinding))
      return {
        status: "refused",
        code: "HANDOFF_CONTINUE_MODEL_BINDING_MISSING",
      };
    const workspace = await this.authority.resolve(parent.workspaceId);
    if (
      !validWorkspace(workspace) ||
      !sameWorkspace(workspace, parent.workspace)
    )
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    try {
      if (
        !(await exactProject(
          this.host,
          parent.projectId,
          workspace.project.root,
        ))
      )
        return {
          status: "refused",
          code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
        };
      const response = object(
        await this.host.request("thread/read", {
          threadId: parent.threadId,
          includeTurns: false,
        }),
      );
      const thread = object(response?.thread);
      if (
        thread?.id !== parent.threadId ||
        thread?.projectId !== parent.projectId ||
        thread?.cwd !== workspace.root ||
        thread?.model !== parent.model
      )
        return unknown;
    } catch {
      return unknown;
    }

    const expected = {
      requestDigest: digest,
      workspaceId: parent.workspaceId,
      workspace,
      projectId: parent.projectId,
      model: parent.model,
      reasoningEffort: parent.reasoningEffort,
      ...(parent.modelBinding ? { modelBinding: parent.modelBinding } : {}),
      continuedFrom: request.dispatchId,
    };
    const sameChild = (record: HandoffRecord) =>
      record.requestDigest === expected.requestDigest &&
      record.workspaceId === expected.workspaceId &&
      record.projectId === expected.projectId &&
      record.model === expected.model &&
      record.reasoningEffort === expected.reasoningEffort &&
      record.continuedFrom === expected.continuedFrom &&
      record.modelBinding?.configSha256 ===
        expected.modelBinding?.configSha256 &&
      record.modelBinding?.selection.harness ===
        expected.modelBinding?.selection.harness &&
      record.modelBinding?.selection.modelAlias ===
        expected.modelBinding?.selection.modelAlias &&
      sameWorkspace(record.workspace, workspace);
    if (child && !sameChild(child))
      return { status: "refused", code: "HANDOFF_CONTINUE_KEY_CONFLICT" };
    if (child?.turnId)
      return child.continuationVerified === true &&
        child.threadId === parent.threadId
        ? {
            status: "dispatched",
            dispatchId: request.key,
            threadId: child.threadId,
            turnId: child.turnId,
          }
        : unknown;
    if (child?.turnIntent) return unknown;

    try {
      const latest = object(
        await this.host.request("thread/turns/list", {
          threadId: parent.threadId,
          cursor: null,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }),
      );
      const turn = object(Array.isArray(latest?.data) ? latest.data[0] : null);
      if (turn?.id !== parent.turnId || turn?.status !== "completed")
        return {
          status: "refused",
          code: "HANDOFF_CONTINUE_PARENT_NOT_LATEST",
        };
    } catch {
      return unknown;
    }

    if (!child) {
      try {
        child = await this.journal.reserve(request.key, {
          ...expected,
          threadIntent: false,
          turnIntent: false,
        });
      } catch {
        return unknown;
      }
      if (!sameChild(child))
        return {
          status: "refused",
          code: "HANDOFF_CONTINUE_RESERVATION_CONFLICT",
        };
    }
    try {
      if (!child.threadIntent && !(await this.journal.claimThread(request.key)))
        return unknown;
      if (!child.threadId)
        await this.journal.recordThread(request.key, parent.threadId);
      if (
        !(await this.journal.claimContinuation(
          request.dispatchId,
          parent.turnId,
          request.key,
        ))
      )
        return { status: "refused", code: "HANDOFF_CONTINUE_PARENT_RESERVED" };
    } catch {
      return unknown;
    }

    let turnId: string;
    try {
      turnId = await this.mutationGate.run(
        async () => {
          const stillApproved = await this.authority.resolve(
            parent.workspaceId,
          );
          if (
            this.now() >= this.mutationExpiresAt ||
            !validWorkspace(stillApproved) ||
            !sameWorkspace(stillApproved, workspace) ||
            (await this.journal.hasUnconfirmedMessage!(request.dispatchId))
          )
            throw new Error("HANDOFF_CONTINUE_PREFLIGHT_DENIED");
          const latest = object(
            await this.host.request("thread/turns/list", {
              threadId: parent.threadId,
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            }),
          );
          const turn = object(
            Array.isArray(latest?.data) ? latest.data[0] : null,
          );
          if (turn?.id !== parent.turnId || turn?.status !== "completed")
            throw new Error("HANDOFF_CONTINUE_PARENT_CHANGED");
        },
        async () => {
          if (this.now() >= this.mutationExpiresAt)
            throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
          if (!(await this.journal.claimTurn(request.key)))
            throw new HandoffNotSubmittedError(
              "HANDOFF_CONTINUE_ALREADY_CLAIMED",
            );
          const atSend = await this.authority.resolve(parent.workspaceId);
          if (
            this.now() >= this.mutationExpiresAt ||
            !validWorkspace(atSend) ||
            !sameWorkspace(atSend, workspace)
          )
            throw new HandoffNotSubmittedError(
              "HANDOFF_CONTINUE_AUTHORITY_CHANGED",
            );
          const started = object(
            await this.host.request(
              "turn/start",
              {
                threadId: parent.threadId,
                input: [{ type: "text", text: request.message }],
                cwd: workspace.root,
                model: parent.model,
                ...(parent.reasoningEffort === undefined
                  ? {}
                  : { effort: parent.reasoningEffort }),
                approvalPolicy: workspace.execution.approvalPolicy,
                sandboxPolicy:
                  workspace.execution.sandbox === "read-only"
                    ? { type: "readOnly", networkAccess: false }
                    : {
                        type: "workspaceWrite",
                        writableRoots: [workspace.root],
                        networkAccess: false,
                      },
              },
              this.mutationExpiresAt,
            ),
          );
          const turn = object(started?.turn);
          if (!identifier(turn?.id))
            throw new Error("HANDOFF_CONTINUE_TURN_UNVERIFIED");
          await this.journal.recordTurn(request.key, turn.id);
          return turn.id;
        },
        (error) => error instanceof HandoffNotSubmittedError,
      );
    } catch {
      return unknown;
    }

    try {
      const response = object(
        await this.host.request("thread/turns/list", {
          threadId: parent.threadId,
          cursor: null,
          limit: 2,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }),
      );
      const data = response?.data;
      if (
        !Array.isArray(data) ||
        data.length < 2 ||
        object(data[0])?.id !== turnId ||
        object(data[1])?.id !== parent.turnId
      )
        return unknown;
      // Only the original attempt may publish this exact turn-bound verdict.
      await this.journal.confirmContinuation(request.key, turnId);
    } catch {
      return unknown;
    }
    return {
      status: "dispatched",
      dispatchId: request.key,
      threadId: parent.threadId,
      turnId,
    };
  }

  async create(request: HandoffRequest): Promise<HandoffCreateResult> {
    if (!validRequest(request))
      return { status: "refused", code: "HANDOFF_INPUT_INVALID" };
    const workspace = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(workspace)) {
      return { status: "refused", code: "HANDOFF_WORKSPACE_UNVERIFIED" };
    }
    const requestDigest = this.digester.digest(request);
    if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
      return { status: "refused", code: "HANDOFF_DIGEST_INVALID" };
    }
    let current: HandoffRecord | null;
    try {
      current = await this.journal.read(request.key);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (current && current.requestDigest !== requestDigest) {
      return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
    }
    if (current && !sameWorkspace(current.workspace, workspace)) {
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    }
    if (current?.threadIntent) {
      if (current.threadId && !current.turnIntent) {
        try {
          const response = object(
            await this.host.request("thread/read", {
              threadId: current.threadId,
              includeTurns: false,
            }),
          );
          const thread = object(response?.thread);
          if (
            thread?.id !== current.threadId ||
            thread?.projectId !== request.projectId ||
            thread?.cwd !== workspace.root ||
            thread?.model !== request.model
          ) {
            return { status: "outcome_unknown", dispatchId: request.key };
          }
          return this.startTurn(request, current.threadId, workspace);
        } catch {
          return { status: "outcome_unknown", dispatchId: request.key };
        }
      }
      return this.knownOrUnknown(request.key, current);
    }

    try {
      if (
        !(await exactProject(
          this.host,
          request.projectId,
          workspace.project.root,
        ))
      ) {
        return {
          status: "refused",
          code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
        };
      }
    } catch {
      return { status: "refused", code: "HANDOFF_PROJECT_UNAVAILABLE" };
    }
    const stillApproved = await this.authority.resolve(request.workspaceId);
    if (
      !validWorkspace(stillApproved) ||
      !sameWorkspace(stillApproved, workspace)
    ) {
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    }
    let reserved: HandoffRecord;
    try {
      reserved = await this.journal.reserve(request.key, {
        requestDigest,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        ...(request.modelBinding ? { modelBinding: request.modelBinding } : {}),
        workspaceId: request.workspaceId,
        workspace,
        projectId: request.projectId,
        threadIntent: false,
        turnIntent: false,
      });
    } catch {
      // Another creator can be between mkdir and its durable reservation.
      // Neither a concurrent call nor a restart may guess that it owns it.
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (
      reserved.requestDigest !== requestDigest ||
      reserved.workspaceId !== request.workspaceId ||
      reserved.projectId !== request.projectId ||
      !sameWorkspace(reserved.workspace, workspace)
    ) {
      return { status: "refused", code: "HANDOFF_RESERVATION_CONFLICT" };
    }
    let claimedThread: boolean;
    try {
      claimedThread =
        !reserved.threadIntent && (await this.journal.claimThread(request.key));
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (!claimedThread) {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    // The durable claim precedes the first host side effect. A lost response,
    // crash or write failure cannot turn a replay into a second thread/start.
    let threadId: string;
    try {
      const started = object(
        await this.host.request("thread/start", {
          projectId: request.projectId,
          cwd: workspace.root,
          ephemeral: false,
          model: request.model,
          sandbox: workspace.execution.sandbox,
          approvalPolicy: workspace.execution.approvalPolicy,
          allowProviderModelFallback: false,
        }),
      );
      const thread = object(started?.thread);
      if (
        !identifier(thread?.id) ||
        thread?.projectId !== request.projectId ||
        started?.cwd !== workspace.root ||
        started?.model !== request.model ||
        started?.approvalPolicy !== workspace.execution.approvalPolicy ||
        object(started?.sandbox)?.type !==
          (workspace.execution.sandbox === "read-only"
            ? "readOnly"
            : "workspaceWrite")
      ) {
        throw new Error("HANDOFF_THREAD_BINDING_UNVERIFIED");
      }
      threadId = thread.id;
      await this.journal.recordThread(request.key, threadId);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    return this.startTurn(request, threadId, workspace);
  }

  private async startTurn(
    request: HandoffRequest,
    threadId: string,
    workspace: HandoffWorkspace,
  ): Promise<HandoffCreateResult> {
    const current = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(current) || !sameWorkspace(current, workspace)) {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    let claimedTurn: boolean;
    try {
      claimedTurn = await this.journal.claimTurn(request.key);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (!claimedTurn) {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    try {
      const started = object(
        await this.host.request("turn/start", {
          threadId,
          input: [{ type: "text", text: request.message }],
          cwd: workspace.root,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { effort: request.reasoningEffort }),
          approvalPolicy: workspace.execution.approvalPolicy,
          sandboxPolicy:
            workspace.execution.sandbox === "read-only"
              ? { type: "readOnly", networkAccess: false }
              : {
                  type: "workspaceWrite",
                  writableRoots: [workspace.root],
                  networkAccess: false,
                },
        }),
      );
      const turn = object(started?.turn);
      if (!identifier(turn?.id)) throw new Error("HANDOFF_TURN_UNVERIFIED");
      await this.journal.recordTurn(request.key, turn.id);
      return {
        status: "dispatched",
        dispatchId: request.key,
        threadId,
        turnId: turn.id,
      };
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
  }

  async status(dispatchId: string): Promise<HandoffStatusResult> {
    if (!/^[0-9a-f-]{36}$/iu.test(dispatchId)) return { status: "unknown" };
    let record: HandoffRecord | null;
    try {
      record = await this.journal.read(dispatchId);
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
    if (!record) return { status: "unknown" };
    if (
      record.adopted &&
      (record.threadId !== this.selectedOwnerThreadId ||
        this.now() >= this.mutationExpiresAt)
    )
      return { status: "outcome_unknown", dispatchId };
    if (record.continuedFrom && record.continuationVerified !== true)
      return { status: "outcome_unknown", dispatchId };
    const workspace = await this.authority.resolve(record.workspaceId);
    if (
      !validWorkspace(workspace) ||
      !samePhysicalWorkspace(workspace, record.workspace)
    ) {
      return { status: "outcome_unknown", dispatchId };
    }
    if (!record.threadId || !record.turnId) {
      return { status: "outcome_unknown", dispatchId };
    }
    try {
      const response = object(
        await this.host.request("thread/read", {
          threadId: record.threadId,
          includeTurns: false,
        }),
      );
      const thread = object(response?.thread);
      if (
        thread?.id !== record.threadId ||
        thread?.projectId !== record.projectId ||
        thread?.cwd !== record.workspace.root ||
        (record.model !== undefined && thread?.model !== record.model)
      ) {
        return { status: "outcome_unknown", dispatchId };
      }
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 32; page += 1) {
        const turns = object(
          await this.host.request("thread/turns/list", {
            threadId: record.threadId,
            cursor,
            limit: 100,
            itemsView: "notLoaded",
          }),
        );
        if (!turns || !Array.isArray(turns.data)) break;
        const match = turns.data
          .map(object)
          .find((item) => item?.id === record.turnId);
        if (match && typeof match.status === "string") {
          if (record.adopted && !(await this.adoptedReadStillAllowed(record)))
            return { status: "outcome_unknown", dispatchId };
          return {
            status: "known",
            dispatchId,
            threadId: record.threadId,
            turnId: record.turnId,
            turnStatus: match.status,
          };
        }
        if (
          turns.nextCursor === null ||
          typeof turns.nextCursor !== "string" ||
          seen.has(turns.nextCursor)
        )
          break;
        cursor = turns.nextCursor;
        seen.add(cursor);
      }
    } catch {
      // A status read is never a reason to create another task or turn.
    }
    return { status: "outcome_unknown", dispatchId };
  }

  async result(dispatchId: string): Promise<HandoffResult> {
    const status = await this.status(dispatchId);
    if (status.status !== "known") return status;
    let record: HandoffRecord | null;
    try {
      record = await this.journal.read(dispatchId);
      if (
        !record ||
        (record.adopted && !(await this.adoptedReadStillAllowed(record)))
      )
        return { status: "outcome_unknown", dispatchId };
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
    const identity = {
      dispatchId,
      threadId: status.threadId,
      turnId: status.turnId,
    };
    if (status.turnStatus === "inProgress") {
      return { status: "running", ...identity };
    }
    if (status.turnStatus === "failed" || status.turnStatus === "interrupted") {
      return { status: status.turnStatus, ...identity };
    }
    if (status.turnStatus !== "completed") {
      return { status: "outcome_unknown", dispatchId };
    }
    // The provider's item filter is checked again here. A terminal turn with
    // no single explicit final answer is not evidence of an exact result.
    let final: Readonly<{ id: string; text: string }> | null = null;
    let cursor: string | null = null;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 32; page += 1) {
        const response = object(
          await this.host.request("thread/items/list", {
            threadId: status.threadId,
            turnId: status.turnId,
            cursor,
            limit: 100,
          }),
        );
        if (
          !response ||
          !Array.isArray(response.data) ||
          response.data.length > 100
        ) {
          break;
        }
        for (const value of response.data) {
          const entry = object(value);
          const item = object(entry?.item);
          if (
            entry?.turnId !== status.turnId ||
            !item ||
            !identifier(item.id)
          ) {
            return { status: "outcome_unknown", dispatchId };
          }
          if (item.type === "agentMessage" && item.phase === "final_answer") {
            if (
              final !== null ||
              typeof item.text !== "string" ||
              item.text.length === 0 ||
              item.text.length > 256 * 1024
            ) {
              return { status: "outcome_unknown", dispatchId };
            }
            final = { id: item.id, text: item.text };
          }
        }
        if (response.nextCursor === null) {
          if (record.adopted && !(await this.adoptedReadStillAllowed(record)))
            return { status: "outcome_unknown", dispatchId };
          return final
            ? {
                status: "completed",
                ...identity,
                finalItemId: final.id,
                text: final.text,
              }
            : { status: "outcome_unknown", dispatchId };
        }
        if (
          typeof response.nextCursor !== "string" ||
          response.nextCursor.length === 0 ||
          seen.has(response.nextCursor)
        ) {
          break;
        }
        cursor = response.nextCursor;
        seen.add(cursor);
      }
    } catch {
      // Result reads never create a replacement task or a model turn.
    }
    return { status: "outcome_unknown", dispatchId };
  }

  private async adoptedReadStillAllowed(
    record: HandoffRecord,
  ): Promise<boolean> {
    if (
      record.adopted !== true ||
      record.threadId !== this.selectedOwnerThreadId ||
      this.now() >= this.mutationExpiresAt
    )
      return false;
    const current = await this.authority.resolve(record.workspaceId);
    return (
      this.now() < this.mutationExpiresAt &&
      validWorkspace(current) &&
      samePhysicalWorkspace(current, record.workspace)
    );
  }

  private async knownOrUnknown(
    key: string,
    record: HandoffRecord | null,
  ): Promise<HandoffCreateResult> {
    return record?.threadId && record.turnId
      ? {
          status: "dispatched",
          dispatchId: key,
          threadId: record.threadId,
          turnId: record.turnId,
        }
      : { status: "outcome_unknown", dispatchId: key };
  }
}

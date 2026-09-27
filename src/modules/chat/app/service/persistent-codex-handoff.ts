export type HandoffRequest = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
  message: string;
  model: string;
  reasoningEffort: string;
}>;

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
  read(key: string): Promise<HandoffRecord | null>;
}

export interface HandoffAuthority {
  // The caller supplies only an ID. The owner-approved Computer binding is
  // resolved by the trusted host, including its current physical root.
  resolve(workspaceId: string): Promise<HandoffWorkspace | null>;
}

export interface HandoffHost {
  request(method: string, params: unknown): Promise<unknown>;
}

export interface HandoffRequestDigester {
  digest(request: HandoffRequest): string;
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
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      request.key,
    ) &&
    identifier(request.workspaceId) &&
    identifier(request.projectId) &&
    request.message.length > 0 &&
    request.message.length <= 8_192 &&
    !request.message.includes("\0") &&
    /^[A-Za-z0-9_.\/-]{1,120}$/u.test(request.model) &&
    /^[A-Za-z0-9_-]{1,40}$/u.test(request.reasoningEffort)
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

async function exactProject(
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
  ) {}

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
          effort: request.reasoningEffort,
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
        thread?.cwd !== record.workspace.root
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

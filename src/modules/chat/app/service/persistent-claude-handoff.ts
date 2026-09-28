import { observeClaudePrint } from "../../domain/claude-print-stream";
import type {
  ClaudeCreate,
  ClaudeIntent,
  ClaudeJournal,
  ClaudeProcessHost,
  ClaudeRequest,
  ClaudeStatus,
} from "../port/claude-handoff";
import type {
  HandoffAuthority,
  HandoffMutationGate,
} from "./persistent-codex-handoff";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export class PersistentClaudeHandoff {
  private readonly handles = new Map<string, string>();
  constructor(
    private readonly authority: HandoffAuthority,
    private readonly host: ClaudeProcessHost,
    private readonly journal: ClaudeJournal,
    private readonly digester: { digest(value: unknown): string },
    private readonly admission: {
      workspaceId: string;
      projectId: string;
      expiresAt: number;
    },
    private readonly gate: HandoffMutationGate,
    private readonly now: () => number,
  ) {}
  private async authorized(record?: ClaudeIntent) {
    if (this.now() >= this.admission.expiresAt) return null;
    const workspace = await this.authority.resolve(this.admission.workspaceId);
    return this.now() < this.admission.expiresAt &&
      workspace &&
      (!record ||
        (record.workspaceId === this.admission.workspaceId &&
          record.projectId === this.admission.projectId &&
          same(workspace, record.workspace)))
      ? workspace
      : null;
  }
  async create(request: ClaudeRequest): Promise<ClaudeCreate> {
    const refused = {
      status: "refused" as const,
      code: "CLAUDE_TASK_ADMISSION_DENIED",
    };
    if (
      !uuid.test(request.key) ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      !request.message.trim() ||
      request.message.includes("\0") ||
      new TextEncoder().encode(request.message).byteLength > 8192 ||
      request.modelBinding.selection.harness !== "claude-code"
    )
      return refused;
    const key = request.key.toLowerCase();
    const unknown = { status: "outcome_unknown" as const, dispatchId: key };
    let publicationPossible = false;
    try {
      const workspace = await this.authorized();
      if (!workspace) return refused;
      let existing: ClaudeIntent | null;
      try {
        existing = await this.journal.read(key);
      } catch {
        return unknown;
      }
      const intent: ClaudeIntent = {
        sessionId: key,
        requestDigest: this.digester.digest({ ...request, key, workspace }),
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        workspace,
        modelBinding: request.modelBinding,
      };
      if (existing)
        return same(existing, intent)
          ? unknown
          : { status: "refused", code: "CLAUDE_DISPATCH_CONFLICT" };
      if (
        !(await this.host.supports(request.modelBinding)) ||
        !(await this.authorized())
      )
        return refused;
      return await this.gate.run(
        async () => {
          if (!(await this.authorized())) throw Error("admission");
        },
        async () => {
          publicationPossible = true;
          if (!(await this.journal.claim(key, intent))) return unknown;
          if (!(await this.authorized(intent))) return unknown;
          const handle = await this.host.start({ ...request, key }, workspace);
          this.handles.set(key, handle);
          if (!(await this.authorized(intent))) return unknown;
          return {
            status: "dispatched" as const,
            dispatchId: key,
            sessionId: key,
            evidence: "local-process-start" as const,
            nativeVisibility: "not-qualified" as const,
          };
        },
        () => !publicationPossible,
      );
    } catch {
      return publicationPossible ? unknown : refused;
    }
  }
  async status(dispatchId: string): Promise<ClaudeStatus> {
    const refused = {
      status: "refused" as const,
      code: "CLAUDE_TASK_ADMISSION_DENIED",
    };
    if (!uuid.test(dispatchId)) return refused;
    const key = dispatchId.toLowerCase();
    const unknown = { status: "outcome_unknown" as const, dispatchId: key };
    try {
      if (!(await this.authorized())) return refused;
      const intent = await this.journal.read(key);
      if (!intent) return { status: "unknown" };
      if (!(await this.authorized(intent))) return refused;
      let terminal = await this.journal.terminal(key);
      if (!terminal) {
        const handle = this.handles.get(key);
        if (!handle) return unknown;
        const snapshot = await this.host.read(handle);
        if (
          snapshot.truncated ||
          snapshot.interrupted ||
          snapshot.exitSignal !== null
        )
          return unknown;
        const observed = observeClaudePrint(
          snapshot.stdout,
          {
            sessionId: key,
            cwd: intent.workspace.root,
            model: intent.modelBinding.selection.model,
          },
          snapshot.state === "exited",
        );
        if (!observed) return unknown;
        if (snapshot.state === "running") {
          if (!(await this.authorized(intent))) return refused;
          return {
            status: "known",
            dispatchId: key,
            sessionId: key,
            lifecycle: "running",
            actualModel: observed.model,
            configuredModel: intent.modelBinding.selection.model,
            proof: "local-process",
            nativeVisibility: "not-qualified",
            text: "",
            exitCode: null,
          };
        }
        if (
          !observed.result ||
          snapshot.groupCleanup !== "confirmed" ||
          (snapshot.exitCode !== 0 && snapshot.exitCode !== 1) ||
          (observed.result.lifecycle !== "failed" && snapshot.exitCode !== 0)
        )
          return unknown;
        if (!(await this.authorized(intent))) return refused;
        const value = {
          ...observed.result,
          sessionId: key,
          actualModel: observed.model,
          exitCode: snapshot.exitCode,
        };
        terminal = await this.gate.run(
          async () => {
            if (!(await this.authorized(intent))) throw Error("admission");
          },
          async () => {
            const recorded = await this.journal.finish(key, value);
            if (!(await this.authorized(intent))) throw Error("late admission");
            return recorded;
          },
          () => true,
        );
      }
      if (
        terminal.sessionId !== key ||
        terminal.actualModel !== intent.modelBinding.selection.model
      )
        return unknown;
      if (!(await this.authorized(intent))) return refused;
      return {
        ...terminal,
        status: "known",
        dispatchId: key,
        configuredModel: intent.modelBinding.selection.model,
        proof: "recorded-terminal",
        nativeVisibility: "not-qualified",
      };
    } catch {
      return unknown;
    }
  }
}

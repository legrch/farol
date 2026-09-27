import type { CodexTaskRoute } from "../../contract/codex-task-route";

export type CodexTaskAdmission = Readonly<{
  workspaceId: string;
  projectId: string;
  model: string;
  reasoningEffort: string;
  expiresAt: number;
}>;

/** A separate, exact task grant; Computer folder access is insufficient. */
export class AdmittedCodexTaskRoute implements CodexTaskRoute {
  constructor(
    private readonly delegate: CodexTaskRoute,
    private readonly admission: CodexTaskAdmission,
    private readonly now: () => number = Date.now,
  ) {}

  async create(request: Parameters<CodexTaskRoute["create"]>[0]) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      request.model !== this.admission.model ||
      request.reasoningEffort !== this.admission.reasoningEffort
    ) {
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    }
    return this.delegate.create(request);
  }

  status(dispatchId: string) {
    return this.delegate.status(dispatchId);
  }

  result(dispatchId: string) {
    return this.delegate.result(dispatchId);
  }
}

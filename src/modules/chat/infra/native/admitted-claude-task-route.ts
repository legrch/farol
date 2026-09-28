import { createHash } from "node:crypto";
import {
  resolveTaskModel,
  TaskExecutionSettingsSchema,
  taskPolicyIdentity,
  type TaskExecutionSettings,
} from "../../../../pkg/owner-config/contract";
import type { ClaudeTaskRoute } from "../../contract/claude-task-route";
import type { PersistentClaudeHandoff } from "../../app/service/persistent-claude-handoff";
export class AdmittedClaudeTaskRoute implements ClaudeTaskRoute {
  private readonly tasks: TaskExecutionSettings;
  constructor(
    private readonly delegate: Pick<
      PersistentClaudeHandoff,
      "create" | "status"
    >,
    private readonly admission: {
      workspaceId: string;
      projectId: string;
      tasks: TaskExecutionSettings;
      configSha256: string;
      expiresAt: number;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.tasks = TaskExecutionSettingsSchema.parse(admission.tasks);
    if (
      createHash("sha256")
        .update(taskPolicyIdentity(this.tasks))
        .digest("hex") !== admission.configSha256
    )
      throw Error("CLAUDE_TASK_POLICY_INVALID");
  }
  async create(request: Parameters<ClaudeTaskRoute["create"]>[0]) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    )
      return {
        status: "refused" as const,
        code: "CLAUDE_TASK_ADMISSION_DENIED",
      };
    const resolved = resolveTaskModel(
      this.tasks,
      {
        harness: request.harness ?? "claude-code",
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      },
      ["claude-code"],
    );
    if (resolved.status !== "ready")
      return {
        status: "refused" as const,
        code:
          "TASK_MODEL_" + resolved.status.toUpperCase().replaceAll("-", "_"),
      };
    const result = await this.delegate.create({
      key: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: request.message,
      modelBinding: {
        selection: resolved.selection,
        configSha256: this.admission.configSha256,
      },
    });
    return this.now() >= this.admission.expiresAt
      ? {
          status: "outcome_unknown" as const,
          dispatchId: request.key.toLowerCase(),
        }
      : result;
  }
  async status(dispatchId: string) {
    if (this.now() >= this.admission.expiresAt)
      return {
        status: "refused" as const,
        code: "CLAUDE_TASK_ADMISSION_DENIED",
      };
    const result = await this.delegate.status(dispatchId);
    return this.now() >= this.admission.expiresAt
      ? { status: "refused" as const, code: "CLAUDE_TASK_ADMISSION_DENIED" }
      : result;
  }
}

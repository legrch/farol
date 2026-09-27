import { createHash } from "node:crypto";

import type { HandoffRequest } from "../../app/service/persistent-codex-handoff";
import type { CodexTaskRoute } from "../../contract/codex-task-route";
import {
  resolveTaskModel,
  taskPolicyIdentity,
  TaskExecutionSettingsSchema,
  type TaskExecutionSettings,
} from "../../../../pkg/owner-config/contract";

export type CodexTaskAdmission = Readonly<{
  workspaceId: string;
  projectId: string;
  harness: "codex";
  tasks: TaskExecutionSettings;
  configSha256: string;
  expiresAt: number;
}>;

type ResolvedTaskRoute = Pick<
  CodexTaskRoute,
  "status" | "result" | "message" | "continue" | "observe"
> & {
  create(request: HandoffRequest): ReturnType<CodexTaskRoute["create"]>;
};

/** An exact physical grant with an owned task-policy snapshot. */
export class AdmittedCodexTaskRoute implements CodexTaskRoute {
  private readonly admission: CodexTaskAdmission;

  constructor(
    private readonly delegate: ResolvedTaskRoute,
    admission: CodexTaskAdmission,
    private readonly now: () => number = Date.now,
    readonly controlCapabilities: Readonly<{
      message: boolean;
      continue?: boolean;
    }> = {
      message: false,
      continue: false,
    },
  ) {
    const tasks = TaskExecutionSettingsSchema.parse(admission.tasks);
    const digest = createHash("sha256")
      .update(taskPolicyIdentity(tasks), "utf8")
      .digest("hex");
    if (admission.harness !== "codex" || digest !== admission.configSha256) {
      throw new Error("HANDOFF_TASK_POLICY_INVALID");
    }
    if (controlCapabilities.continue && !delegate.continue)
      throw new Error("HANDOFF_CONTINUE_UNAVAILABLE");
    this.admission = { ...admission, tasks };
  }

  async observe(
    request: Parameters<NonNullable<CodexTaskRoute["observe"]>>[0],
  ) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    if (!this.delegate.observe)
      return {
        status: "refused" as const,
        code: "HANDOFF_OBSERVE_UNAVAILABLE",
      };
    return this.delegate.observe(request);
  }

  async create(request: Parameters<CodexTaskRoute["create"]>[0]) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    ) {
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    }
    const resolved = resolveTaskModel(
      this.admission.tasks,
      {
        ...(request.harness === undefined ? {} : { harness: request.harness }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      },
      [this.admission.harness],
    );
    if (resolved.status !== "ready") {
      return {
        status: "refused" as const,
        code:
          "TASK_MODEL_" + resolved.status.toUpperCase().replaceAll("-", "_"),
      };
    }
    return this.delegate.create({
      key: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: request.message,
      model: resolved.selection.model,
      ...(resolved.selection.effort === undefined
        ? {}
        : { reasoningEffort: resolved.selection.effort }),
      modelBinding: {
        selection: resolved.selection,
        configSha256: this.admission.configSha256,
      },
    });
  }

  async message(request: Parameters<CodexTaskRoute["message"]>[0]) {
    if (!this.controlCapabilities.message)
      return { status: "refused" as const, code: "TASK_CONTROL_NOT_QUALIFIED" };
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    // The persistent delegate checks the original dispatch binding. A later
    // policy edit cannot reinterpret the model of an already-issued task.
    return this.delegate.message(request);
  }

  async continue(request: {
    key: string;
    dispatchId: string;
    message: string;
  }) {
    if (!this.controlCapabilities.continue || !this.delegate.continue)
      return { status: "refused" as const, code: "TASK_CONTROL_NOT_QUALIFIED" };
    if (this.now() >= this.admission.expiresAt)
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    return this.delegate.continue(request);
  }

  status(dispatchId: string) {
    return this.delegate.status(dispatchId);
  }

  result(dispatchId: string) {
    return this.delegate.result(dispatchId);
  }
}

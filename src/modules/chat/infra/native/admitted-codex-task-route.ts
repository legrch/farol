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
  observeThreadId?: string | undefined;
  discoverProjectTasks?: boolean | undefined;
  harness: "codex";
  tasks: TaskExecutionSettings;
  configSha256: string;
  expiresAt: number;
}>;

type ResolvedTaskRoute = Pick<
  CodexTaskRoute,
  | "status"
  | "result"
  | "message"
  | "continue"
  | "observe"
  | "adopt"
  | "resolveProject"
  | "discoverTasks"
  | "projectPreference"
  | "history"
  | "title"
> & {
  create(request: HandoffRequest): ReturnType<CodexTaskRoute["create"]>;
};

/** An exact physical grant with an owned task-policy snapshot. */
export class AdmittedCodexTaskRoute implements CodexTaskRoute {
  private readonly admission: CodexTaskAdmission;
  readonly observeEnabled: boolean;
  readonly projectTasksEnabled: boolean;
  readonly projectPreferenceEnabled: boolean;

  constructor(
    private readonly delegate: ResolvedTaskRoute,
    admission: CodexTaskAdmission,
    private readonly now: () => number = Date.now,
    readonly controlCapabilities: Readonly<{
      message: boolean;
      continue?: boolean;
      title?: boolean;
    }> = {
      message: false,
      continue: false,
      title: false,
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
    if (controlCapabilities.title && !delegate.title)
      throw new Error("HANDOFF_TITLE_UNAVAILABLE");
    this.admission = { ...admission, tasks };
    this.observeEnabled = admission.observeThreadId !== undefined;
    this.projectPreferenceEnabled = delegate.projectPreference !== undefined;
    this.projectTasksEnabled =
      admission.discoverProjectTasks === true &&
      delegate.discoverTasks !== undefined;
  }

  async projectPreference(
    request: Parameters<NonNullable<CodexTaskRoute["projectPreference"]>>[0],
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    const failed = (
      status: "refused" | "outcome_unknown" | "unavailable",
      code: string,
    ) => ({
      status,
      key: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      code,
    });
    if (!this.projectPreferenceEnabled || !this.delegate.projectPreference)
      return failed("refused", "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE");
    if (
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      this.now() >= this.admission.expiresAt ||
      context.signal?.aborted
    )
      return failed("refused", "HANDOFF_TASK_ADMISSION_DENIED");
    const result = await this.delegate.projectPreference(request, context);
    if (
      this.now() >= this.admission.expiresAt ||
      context.signal?.aborted ||
      result.key !== request.key ||
      result.workspaceId !== request.workspaceId ||
      result.projectId !== request.projectId
    )
      return failed(
        request.operation === "remember" ? "outcome_unknown" : "unavailable",
        "HANDOFF_PROJECT_PREFERENCE_UNVERIFIED",
      );
    return result;
  }

  async discoverTasks(
    request: Parameters<NonNullable<CodexTaskRoute["discoverTasks"]>>[0],
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    const refused = (code: string) => ({
      status: "refused" as const,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      code,
    });
    if (!this.projectTasksEnabled || !this.delegate.discoverTasks)
      return refused("HANDOFF_PROJECT_TASKS_NOT_GRANTED");
    if (
      this.now() >= this.admission.expiresAt ||
      context.signal?.aborted ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    )
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    const result = await this.delegate.discoverTasks(request, context);
    if (this.now() >= this.admission.expiresAt || context.signal?.aborted)
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    if (
      result.workspaceId !== request.workspaceId ||
      result.projectId !== request.projectId
    )
      return refused("HANDOFF_PROJECT_TASKS_CORRELATION");
    return result;
  }

  async resolveProject(
    request: Parameters<NonNullable<CodexTaskRoute["resolveProject"]>>[0],
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    const refused = (code: string) => ({
      status: "refused" as const,
      workspaceId: request.workspaceId,
      code,
    });
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      (request.preferredProjectId !== undefined &&
        request.preferredProjectId !== this.admission.projectId)
    )
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    if (!this.delegate.resolveProject)
      return refused("HANDOFF_PROJECT_RESOLVE_UNAVAILABLE");
    if (context.signal?.aborted)
      return refused("HANDOFF_PROJECT_READ_CANCELLED");
    const result = await this.delegate.resolveProject(
      {
        workspaceId: request.workspaceId,
        preferredProjectId: this.admission.projectId,
      },
      context,
    );
    if (this.now() >= this.admission.expiresAt)
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    if (context.signal?.aborted)
      return refused("HANDOFF_PROJECT_READ_CANCELLED");
    if (
      result.workspaceId !== request.workspaceId ||
      (result.status === "resolved" &&
        result.selectedProjectId !== this.admission.projectId)
    )
      return refused("HANDOFF_PROJECT_RESOLVE_CORRELATION");
    return result;
  }

  async history(
    request: Parameters<NonNullable<CodexTaskRoute["history"]>>[0],
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    const refused = (code: string) => ({
      status: "refused" as const,
      threadId: request.threadId,
      turnId: request.turnId,
      code,
    });
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      request.threadId !== this.admission.observeThreadId
    )
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    if (!this.delegate.history) return refused("HANDOFF_HISTORY_UNAVAILABLE");
    if (context.signal?.aborted) return refused("HANDOFF_HISTORY_CANCELLED");
    const result = await this.delegate.history(request, context);
    if (this.now() >= this.admission.expiresAt)
      return refused("HANDOFF_TASK_ADMISSION_DENIED");
    if (context.signal?.aborted) return refused("HANDOFF_HISTORY_CANCELLED");
    if (
      result.threadId !== request.threadId ||
      result.turnId !== request.turnId
    )
      return refused("HANDOFF_HISTORY_CORRELATION");
    return result;
  }

  async observe(
    request: Parameters<NonNullable<CodexTaskRoute["observe"]>>[0],
  ) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      request.threadId !== this.admission.observeThreadId
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
    const result = await this.delegate.observe(request);
    return this.now() >= this.admission.expiresAt
      ? { status: "refused" as const, code: "HANDOFF_TASK_ADMISSION_DENIED" }
      : result;
  }

  async adopt(request: Parameters<NonNullable<CodexTaskRoute["adopt"]>>[0]) {
    if (
      this.now() >= this.admission.expiresAt ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId ||
      request.threadId !== this.admission.observeThreadId
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    if (!this.delegate.adopt)
      return { status: "refused" as const, code: "HANDOFF_ADOPT_UNAVAILABLE" };
    const result = await this.delegate.adopt(request);
    return this.now() >= this.admission.expiresAt
      ? { status: "refused" as const, code: "HANDOFF_TASK_ADMISSION_DENIED" }
      : result;
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

  async title(
    request: Parameters<NonNullable<CodexTaskRoute["title"]>>[0],
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    if (!this.controlCapabilities.title || !this.delegate.title)
      return { status: "refused" as const, code: "TASK_CONTROL_NOT_QUALIFIED" };
    if (
      this.now() >= this.admission.expiresAt ||
      context.signal?.aborted ||
      request.workspaceId !== this.admission.workspaceId ||
      request.projectId !== this.admission.projectId
    )
      return {
        status: "refused" as const,
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
    const result = await this.delegate.title(request, context);
    // The delegated mutation may already have happened; late admission loss is unknown.
    return this.now() >= this.admission.expiresAt || context.signal?.aborted
      ? { status: "outcome_unknown" as const, dispatchId: request.dispatchId }
      : result;
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

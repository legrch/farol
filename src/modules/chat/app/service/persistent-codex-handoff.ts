import type {
  CodexModelCatalogue,
  CodexModelCheck,
} from "../port/codex-model-catalogue";
import { ReadCodexModelCatalogue } from "./read-codex-model-catalogue";
import { readCodexThreadRuntime } from "./read-codex-thread-runtime";
import type {
  LatestProjectPreference,
  ProjectPreferenceLookupRequest,
  ProjectPreferenceLookupResult,
  ProjectPreferenceRecord,
  ProjectPreferenceRequest,
  ProjectPreferenceResult,
} from "../port/codex-project-preference";
import { readCodexProjectTasks } from "./read-codex-project-tasks";
import type {
  ProjectTaskDiscoveryRequest,
  ProjectTaskDiscoveryResult,
} from "../port/codex-project-tasks";
import type { ProjectResolutionResult } from "../port/codex-project-catalogue";
import { resolveCodexProjectCatalogue } from "./resolve-codex-project-catalogue";
import type {
  TaskHistoryRequest,
  TaskHistoryResult,
} from "../port/codex-task-history";

import type {
  HandoffRequest,
  HandoffMessage,
  HandoffContinue,
  HandoffTitleRequest,
  HandoffTitleResult,
  HandoffAdopt,
  HandoffMessageResult,
  HandoffWorkspace,
  HandoffRecord,
  HandoffJournal,
  HandoffAuthority,
  HandoffReadContext,
  HandoffHost,
  HandoffRequestDigester,
  HandoffMutationGate,
  HandoffCreateResult,
  HandoffStatusResult,
  HandoffResult,
} from "../port/handoff";
import { exactProject } from "./exactproject";
import {
  lookupResolved,
  lookupVerdict,
  preferenceStored,
  preferenceVerdict,
  resolveRefused,
  sameRecord as samePreferenceRecord,
  tasksQuery,
  tasksVerdict,
} from "./projectresult";
import {
  identifier,
  isDigest,
  isUuid,
  object,
  samePhysicalWorkspace,
  sameProject,
  sameWorkspace,
  validContinue,
  validRequest,
  validWorkspace,
} from "./handoffvalidation";

import { boundedContext, mutationAdmitted } from "./admission";
import {
  HandoffNotSubmittedError,
  adoptedReadStillAllowed,
  dispatchStillAllowed,
  readHost,
  readStillAllowed,
  resultReadStillAllowed,
  supportsDispatchAttempts,
  type HandoffFlowDeps,
} from "./handoffdeps";
import { runAdopt } from "./adoptflow";
import { runMessage } from "./messageflow";
import { runHistory, runObserve } from "./readflow";
import { runTitle } from "./titleflow";
import {
  continuationExpected,
  continuationReplay,
  knownOrUnknown,
  reservationConflict,
  reservationRaced,
  sameContinuation,
  replayedRequest,
  unsubmittedAction,
  withResolvedEffort,
} from "./recordbinding";
import {
  startedThreadId,
  threadBound,
  threadModelBound,
} from "./threadbinding";
import {
  continuationFollows,
  foldFinalAnswer,
  itemsNextCursor,
  latestTurnIs,
  statusNextCursor,
  statusPage,
} from "./turnpage";
import {
  latestTurnsParams,
  threadReadParams,
  threadStartParams,
  turnStartParams,
} from "./turnrequest";

export { exactProject };
export type {
  HandoffModelBinding,
  HandoffRequest,
  HandoffMessage,
  HandoffContinue,
  HandoffTitleRequest,
  HandoffTitleResult,
  HandoffAdopt,
  HandoffMessageResult,
  HandoffWorkspace,
  HandoffRecord,
  HandoffJournal,
  HandoffAuthority,
  HandoffReadContext,
  HandoffHost,
  HandoffRequestDigester,
  HandoffMutationGate,
  HandoffCreateResult,
  HandoffStatusResult,
  HandoffResult,
} from "../port/handoff";

export { HandoffNotSubmittedError };

export class PersistentCodexHandoff {
  private readonly deps: HandoffFlowDeps;

  constructor(
    private readonly authority: HandoffAuthority,
    private readonly host: HandoffHost,
    private readonly journal: HandoffJournal,
    private readonly digester: HandoffRequestDigester,
    private readonly mutationExpiresAt: number,
    private readonly mutationGate: HandoffMutationGate,
    private readonly now: () => number = Date.now,
    private readonly selectedOwnerThreadId?: string,
    private readonly modelCatalogue: CodexModelCatalogue = new ReadCodexModelCatalogue(
      host,
      now,
    ),
  ) {
    this.deps = {
      authority,
      host,
      journal,
      digester,
      mutationExpiresAt,
      mutationGate,
      now,
      selectedOwnerThreadId,
    };
  }

  async readModels(
    workspaceId: string,
    fresh = false,
    context: HandoffReadContext = {},
  ) {
    const unavailable = {
      status: "unavailable" as const,
      code: "TASK_MODEL_CATALOG_UNAVAILABLE" as const,
    };
    const bounded = {
      signal: context.signal,
      deadlineAt: Math.min(
        context.deadlineAt ?? this.mutationExpiresAt,
        this.mutationExpiresAt,
      ),
    };
    if (!this.readStillAllowed(bounded)) return unavailable;
    try {
      const workspace = await this.authority.resolve(workspaceId);
      if (!validWorkspace(workspace) || !this.readStillAllowed(bounded))
        return unavailable;
      const result = await this.modelCatalogue.read({
        fresh,
        deadlineAt: bounded.deadlineAt,
        signal: bounded.signal,
      });
      if (!this.readStillAllowed(bounded)) return unavailable;
      const after = await this.authority.resolve(workspaceId);
      if (
        !validWorkspace(after) ||
        !sameWorkspace(workspace, after) ||
        !this.readStillAllowed(bounded)
      )
        return unavailable;
      return result;
    } catch {
      return unavailable;
    }
  }

  private unavailableModel(
    check: Extract<CodexModelCheck, { status: "refused" }>,
  ) {
    return {
      status: "refused" as const,
      code: check.code,
      modelAvailability: check,
    };
  }

  async lookupProjectPreference(
    request: ProjectPreferenceLookupRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<ProjectPreferenceLookupResult> {
    const result = (
      status: "missing" | "refused" | "unavailable" | "stale_preference",
      code: string,
    ): ProjectPreferenceLookupResult => lookupVerdict(request, status, code);
    const admitted = () =>
      mutationAdmitted(context.signal, this.now, this.mutationExpiresAt);
    if (
      !identifier(request.workspaceId) ||
      !identifier(request.projectId) ||
      !admitted()
    )
      return result("refused", "HANDOFF_TASK_ADMISSION_DENIED");
    if (!this.journal.readLatestProjectPreference)
      return result(
        "unavailable",
        "HANDOFF_PROJECT_PREFERENCE_LOOKUP_UNAVAILABLE",
      );
    try {
      const workspace = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(workspace))
        return result("refused", "HANDOFF_WORKSPACE_UNVERIFIED");
      const verify = async () => {
        const current = await this.authority.resolve(request.workspaceId);
        if (
          !admitted() ||
          !validWorkspace(current) ||
          !sameWorkspace(current, workspace)
        )
          throw new HandoffNotSubmittedError(
            "HANDOFF_PROJECT_PREFERENCE_ADMISSION_CHANGED",
          );
      };
      await verify();
      const latest = await this.journal.readLatestProjectPreference(
        workspace.project,
      );
      await verify();
      if (!latest)
        return result("missing", "HANDOFF_PROJECT_PREFERENCE_NOT_RECORDED");
      if (!isUuid(latest.key))
        return result(
          "unavailable",
          "HANDOFF_PROJECT_PREFERENCE_LOOKUP_INVALID",
        );
      const matches = (value: LatestProjectPreference) =>
        value.key === latest.key &&
        value.record.projectId === request.projectId &&
        sameProject(value.record.project, workspace.project);
      if (!matches(latest))
        return result(
          "stale_preference",
          "HANDOFF_PROJECT_PREFERENCE_PROJECT_UNVERIFIED",
        );
      const catalogue = await resolveCodexProjectCatalogue(
        this.host,
        workspace.project.root,
        request.projectId,
        this.mutationExpiresAt,
        admitted,
      );
      await verify();
      if (catalogue.status === "unavailable")
        return result(
          "unavailable",
          "HANDOFF_PROJECT_PREFERENCE_CATALOGUE_UNAVAILABLE",
        );
      if (
        catalogue.status !== "resolved" ||
        catalogue.selectedProjectId !== request.projectId
      )
        return result(
          "stale_preference",
          "HANDOFF_PROJECT_PREFERENCE_PROJECT_UNVERIFIED",
        );
      const readback = await this.journal.readLatestProjectPreference(
        workspace.project,
      );
      await verify();
      if (!readback || !matches(readback))
        return result(
          "unavailable",
          "HANDOFF_PROJECT_PREFERENCE_SELECTION_CHANGED",
        );
      return lookupResolved(request, latest.key);
    } catch (error) {
      return result(
        error instanceof HandoffNotSubmittedError ? "refused" : "unavailable",
        "HANDOFF_PROJECT_PREFERENCE_LOOKUP_UNAVAILABLE",
      );
    }
  }

  async projectPreference(
    request: ProjectPreferenceRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<ProjectPreferenceResult> {
    const result = (
      status:
        "refused" | "unavailable" | "stale_preference" | "outcome_unknown",
      code: string,
    ): ProjectPreferenceResult => preferenceVerdict(request, status, code);
    const admitted = () =>
      mutationAdmitted(context.signal, this.now, this.mutationExpiresAt);
    if (
      !isUuid(request.key) ||
      !identifier(request.workspaceId) ||
      !identifier(request.projectId) ||
      !["remember", "read"].includes(request.operation)
    )
      return result("refused", "HANDOFF_PROJECT_PREFERENCE_INPUT_INVALID");
    if (!admitted()) return result("refused", "HANDOFF_TASK_ADMISSION_DENIED");
    if (
      !this.journal.readProjectPreference ||
      !this.journal.rememberProjectPreference
    )
      return result("refused", "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE");
    let publicationPossible = false;
    try {
      const workspace = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(workspace))
        return result("refused", "HANDOFF_WORKSPACE_UNVERIFIED");
      const verify = async () => {
        const current = await this.authority.resolve(request.workspaceId);
        if (
          !admitted() ||
          !validWorkspace(current) ||
          !sameWorkspace(current, workspace)
        )
          throw new HandoffNotSubmittedError(
            "HANDOFF_PROJECT_PREFERENCE_ADMISSION_CHANGED",
          );
      };
      await verify();
      const prior = await this.journal.readProjectPreference(request.key);
      await verify();
      const record: ProjectPreferenceRecord = {
        projectId: request.projectId,
        project: workspace.project,
      };
      const sameRecord = (value: ProjectPreferenceRecord) =>
        samePreferenceRecord(value, record);
      if (prior && !sameRecord(prior))
        return result(
          request.operation === "read" ? "stale_preference" : "refused",
          "HANDOFF_PROJECT_PREFERENCE_KEY_CONFLICT",
        );
      if (!prior && request.operation === "read")
        return result("refused", "HANDOFF_PROJECT_PREFERENCE_UNKNOWN");
      const catalogue = await resolveCodexProjectCatalogue(
        this.host,
        workspace.project.root,
        request.projectId,
        this.mutationExpiresAt,
        admitted,
      );
      await verify();
      if (catalogue.status === "unavailable")
        return result(
          "unavailable",
          "HANDOFF_PROJECT_PREFERENCE_CATALOGUE_UNAVAILABLE",
        );
      if (
        catalogue.status !== "resolved" ||
        catalogue.selectedProjectId !== request.projectId
      )
        return result(
          "stale_preference",
          "HANDOFF_PROJECT_PREFERENCE_PROJECT_UNVERIFIED",
        );
      if (!prior) {
        await this.mutationGate.run(
          verify,
          async () => {
            if (!admitted())
              throw new HandoffNotSubmittedError(
                "HANDOFF_TASK_ADMISSION_DENIED",
              );
            publicationPossible = true;
            const stored = await this.journal.rememberProjectPreference!(
              request.key,
              record,
            );
            if (!sameRecord(stored))
              throw new Error(
                "HANDOFF_PROJECT_PREFERENCE_PUBLICATION_CONFLICT",
              );
            const readback = await this.journal.readProjectPreference!(
              request.key,
            );
            if (!readback || !sameRecord(readback))
              throw new Error("HANDOFF_PROJECT_PREFERENCE_READBACK_UNVERIFIED");
            await verify();
          },
          (error) =>
            !publicationPossible && error instanceof HandoffNotSubmittedError,
        );
      } else {
        // No new publication. Validate historical receipt use without a mutation.
        await verify();
      }
      return preferenceStored(request);
    } catch (error) {
      if (publicationPossible)
        return result(
          "outcome_unknown",
          "HANDOFF_PROJECT_PREFERENCE_PUBLICATION_UNKNOWN",
        );
      return result(
        error instanceof HandoffNotSubmittedError ? "refused" : "unavailable",
        "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE",
      );
    }
  }

  async discoverTasks(
    request: ProjectTaskDiscoveryRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<ProjectTaskDiscoveryResult> {
    const refused = (code: string): ProjectTaskDiscoveryResult =>
      tasksVerdict(request, "refused", code);
    const admitted = () =>
      mutationAdmitted(context.signal, this.now, this.mutationExpiresAt);
    if (
      !identifier(request.workspaceId) ||
      !identifier(request.projectId) ||
      (request.scope !== undefined &&
        !["selected-writer", "canonical-and-selected-writer"].includes(
          request.scope,
        ))
    )
      return refused("HANDOFF_PROJECT_TASKS_INPUT_INVALID");
    if (!admitted()) return refused("HANDOFF_TASK_ADMISSION_DENIED");
    try {
      const workspace = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(workspace))
        return refused("HANDOFF_WORKSPACE_UNVERIFIED");
      if (!admitted()) return refused("HANDOFF_TASK_ADMISSION_DENIED");
      const catalogue = await resolveCodexProjectCatalogue(
        this.host,
        workspace.project.root,
        request.projectId,
        this.mutationExpiresAt,
        admitted,
      );
      if (!admitted()) return refused("HANDOFF_TASK_ADMISSION_DENIED");
      if (
        catalogue.status !== "resolved" ||
        catalogue.selectedProjectId !== request.projectId
      )
        return tasksVerdict(
          request,
          "unavailable",
          "HANDOFF_PROJECT_TASKS_PROJECT_UNVERIFIED",
        );
      const beforeRead = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(beforeRead) || !sameWorkspace(workspace, beforeRead))
        return refused("HANDOFF_WORKSPACE_CHANGED");
      if (!admitted()) return refused("HANDOFF_TASK_ADMISSION_DENIED");
      const result = await readCodexProjectTasks(
        this.host,
        tasksQuery(request, workspace),
        { deadlineAt: this.mutationExpiresAt, admitted },
      );
      const after = await this.authority.resolve(request.workspaceId);
      if (!validWorkspace(after) || !sameWorkspace(workspace, after))
        return refused("HANDOFF_WORKSPACE_CHANGED");
      if (!admitted()) return refused("HANDOFF_TASK_ADMISSION_DENIED");
      return {
        ...result,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
      };
    } catch {
      return tasksVerdict(
        request,
        "unavailable",
        "HANDOFF_PROJECT_TASKS_UNAVAILABLE",
      );
    }
  }

  async resolveProject(
    request: Readonly<{
      workspaceId: string;
      preferredProjectId?: string | undefined;
    }>,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<ProjectResolutionResult> {
    const refused = (code: string): ProjectResolutionResult =>
      resolveRefused(request.workspaceId, code);
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
      () => mutationAdmitted(context.signal, this.now, this.mutationExpiresAt),
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

  async title(
    request: HandoffTitleRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<HandoffTitleResult> {
    return runTitle(this.deps, request, context);
  }

  async history(
    request: TaskHistoryRequest,
    context: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<TaskHistoryResult> {
    return runHistory(this.deps, request, context);
  }

  async observe(
    request: Readonly<{
      threadId: string;
      workspaceId: string;
      projectId: string;
    }>,
    context: HandoffReadContext = {},
  ) {
    return runObserve(this.deps, request, context);
  }

  async adopt(request: HandoffAdopt) {
    return runAdopt(this.deps, (observed) => this.observe(observed), request);
  }

  async message(request: HandoffMessage): Promise<HandoffMessageResult> {
    return runMessage(this.deps, (id) => this.status(id), request);
  }

  async continue(
    request: HandoffContinue,
    context: HandoffReadContext = {},
  ): Promise<HandoffCreateResult> {
    context = boundedContext(context, this.mutationExpiresAt);
    const host = this.readHost(context);
    const unknown = {
      status: "outcome_unknown" as const,
      dispatchId: request.key,
    };
    if (!validContinue(request))
      return { status: "refused", code: "HANDOFF_CONTINUE_INPUT_INVALID" };
    if (!this.dispatchStillAllowed(context))
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (
      !this.digester.digestContinue ||
      !this.journal.claimContinuation ||
      !this.journal.confirmContinuation ||
      !this.journal.hasUnconfirmedMessage
    )
      return { status: "refused", code: "HANDOFF_CONTINUE_UNAVAILABLE" };
    const digest = this.digester.digestContinue(request);
    if (!isDigest(digest))
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
      if (
        this.journal.hasUnconfirmedTitle &&
        (await this.journal.hasUnconfirmedTitle(request.dispatchId))
      )
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
      if (!(await exactProject(host, parent.projectId, workspace.project.root)))
        return {
          status: "refused",
          code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
        };
      const response = object(
        await host.request("thread/read", threadReadParams(parent.threadId)),
      );
      const thread = object(response?.thread);
      if (
        !threadBound(
          thread,
          parent.threadId,
          parent.projectId,
          workspace.root,
        ) ||
        !threadModelBound(thread, parent.model)
      )
        return unknown;
    } catch {
      return unknown;
    }

    const expected = continuationExpected(
      parent,
      parent.model,
      workspace,
      digest,
      request.dispatchId,
      this.supportsDispatchAttempts(),
    );
    const sameChild = (record: HandoffRecord) =>
      sameContinuation(record, expected, workspace);
    if (child && !sameChild(child))
      return { status: "refused", code: "HANDOFF_CONTINUE_KEY_CONFLICT" };
    if (child?.turnId)
      return continuationReplay(child, parent.threadId, request.key)!;
    if (child?.turnIntent) return unknown;

    // Revalidate the issued binding, not today's configured defaults. Replays
    // above do not depend on the current catalogue or start any new work.
    const modelCheck = await this.modelCatalogue.check(
      parent.model,
      parent.reasoningEffort,
      {
        deadlineAt: context.deadlineAt ?? this.mutationExpiresAt,
        signal: context.signal,
        resolveDefault: false,
      },
    );
    const afterCatalogue = await this.authority.resolve(parent.workspaceId);
    if (
      !this.dispatchStillAllowed(context) ||
      !validWorkspace(afterCatalogue) ||
      !sameWorkspace(afterCatalogue, workspace)
    )
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (modelCheck.status === "refused")
      return this.unavailableModel(modelCheck);

    try {
      const latest = object(
        await host.request(
          "thread/turns/list",
          latestTurnsParams(parent.threadId, 1),
        ),
      );
      if (!latestTurnIs(latest, parent.turnId, "completed"))
        return {
          status: "refused",
          code: "HANDOFF_CONTINUE_PARENT_NOT_LATEST",
        };
    } catch {
      return unknown;
    }

    const beforeReservation = await this.authority.resolve(parent.workspaceId);
    if (
      !this.dispatchStillAllowed(context) ||
      !validWorkspace(beforeReservation) ||
      !sameWorkspace(beforeReservation, workspace)
    )
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (!child) {
      try {
        child = await this.journal.reserve(request.key, {
          ...expected,
          modelCatalogue: {
            modelId: modelCheck.model.id,
            observedAt: modelCheck.observedAt,
            scope: modelCheck.scope,
          },
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
    let dispatchAttempt: number | undefined;
    let effectPossible = false;
    let turnClaimAttempted = false;
    try {
      const initial = !child.threadIntent;
      if (
        child.threadIntent &&
        this.supportsDispatchAttempts() &&
        child.dispatchProtocol !== 1
      )
        return unknown;
      if (!child.threadIntent && !(await this.journal.claimThread(request.key)))
        return unknown;
      if (child.dispatchProtocol === 1) {
        const claimed = await this.journal.claimDispatchAttempt?.(
          request.key,
          initial,
        );
        if (claimed === null || claimed === undefined) return unknown;
        dispatchAttempt = claimed;
      }
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
      return this.finishUnsubmittedAttempt(
        request.key,
        context,
        dispatchAttempt,
        effectPossible,
        !turnClaimAttempted,
      );
    }

    let turnId: string;
    try {
      turnId = await this.mutationGate.run(
        async () => {
          const stillApproved = await this.authority.resolve(
            parent.workspaceId,
          );
          if (
            !this.dispatchStillAllowed(context) ||
            !validWorkspace(stillApproved) ||
            !sameWorkspace(stillApproved, workspace) ||
            (await this.journal.hasUnconfirmedMessage!(request.dispatchId)) ||
            (this.journal.hasUnconfirmedTitle &&
              (await this.journal.hasUnconfirmedTitle(request.dispatchId)))
          )
            throw new Error("HANDOFF_CONTINUE_PREFLIGHT_DENIED");
          if (
            !this.modelCatalogue.isCurrent(
              modelCheck.scope,
              modelCheck.observedAt,
            )
          )
            throw new HandoffNotSubmittedError("TASK_MODEL_CATALOG_CHANGED");
          const latest = object(
            await host.request(
              "thread/turns/list",
              latestTurnsParams(parent.threadId, 1),
            ),
          );
          if (!latestTurnIs(latest, parent.turnId, "completed"))
            throw new Error("HANDOFF_CONTINUE_PARENT_CHANGED");
          if (
            !this.modelCatalogue.isCurrent(
              modelCheck.scope,
              modelCheck.observedAt,
            )
          )
            throw new HandoffNotSubmittedError("TASK_MODEL_CATALOG_CHANGED");
        },
        async () => {
          if (!this.dispatchStillAllowed(context))
            throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
          turnClaimAttempted = true;
          if (!(await this.journal.claimTurn(request.key)))
            throw new HandoffNotSubmittedError(
              "HANDOFF_CONTINUE_ALREADY_CLAIMED",
            );
          const atSend = await this.authority.resolve(parent.workspaceId);
          if (
            !this.dispatchStillAllowed(context) ||
            !validWorkspace(atSend) ||
            !sameWorkspace(atSend, workspace) ||
            !this.modelCatalogue.isCurrent(
              modelCheck.scope,
              modelCheck.observedAt,
            )
          )
            throw new HandoffNotSubmittedError(
              "HANDOFF_CONTINUE_AUTHORITY_CHANGED",
            );
          effectPossible = true;
          const started = object(
            await host.request(
              "turn/start",
              turnStartParams(
                parent.threadId,
                request.message,
                workspace,
                parent.model,
                parent.reasoningEffort,
              ),
              context.deadlineAt,
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
      return this.finishUnsubmittedAttempt(
        request.key,
        context,
        dispatchAttempt,
        effectPossible,
        !turnClaimAttempted,
      );
    }

    try {
      const response = object(
        await host.request(
          "thread/turns/list",
          latestTurnsParams(parent.threadId, 2),
        ),
      );
      if (!continuationFollows(response, turnId, parent.turnId)) return unknown;
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

  async create(
    request: HandoffRequest,
    context: HandoffReadContext = {},
  ): Promise<HandoffCreateResult> {
    context = boundedContext(context, this.mutationExpiresAt);
    if (!this.dispatchStillAllowed(context))
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    const host = this.readHost(context);
    if (!validRequest(request))
      return { status: "refused", code: "HANDOFF_INPUT_INVALID" };
    const workspace = await this.authority.resolve(request.workspaceId);
    if (!validWorkspace(workspace)) {
      return { status: "refused", code: "HANDOFF_WORKSPACE_UNVERIFIED" };
    }
    const requestDigest = this.digester.digest(request);
    if (!isDigest(requestDigest)) {
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
          let dispatchAttempt: number | undefined;
          if (this.supportsDispatchAttempts() && current.dispatchProtocol !== 1)
            return { status: "outcome_unknown", dispatchId: request.key };
          if (current.dispatchProtocol === 1) {
            const claimed = await this.journal.claimDispatchAttempt?.(
              request.key,
              false,
            );
            if (claimed === null || claimed === undefined)
              return { status: "outcome_unknown", dispatchId: request.key };
            dispatchAttempt = claimed;
          }
          const response = object(
            await host.request(
              "thread/read",
              threadReadParams(current.threadId),
            ),
          );
          const thread = object(response?.thread);
          if (
            !threadBound(
              thread,
              current.threadId,
              request.projectId,
              workspace.root,
            ) ||
            !threadModelBound(thread, request.model)
          ) {
            return { status: "outcome_unknown", dispatchId: request.key };
          }
          const check = await this.modelCatalogue.check(
            current.model ?? request.model,
            current.reasoningEffort ?? request.reasoningEffort,
            {
              deadlineAt: context.deadlineAt ?? this.mutationExpiresAt,
              signal: context.signal,
              resolveDefault: false,
            },
          );
          if (check.status === "refused") return this.unavailableModel(check);
          return this.startTurn(
            replayedRequest(request, current),
            current.threadId,
            workspace,
            check,
            context,
            dispatchAttempt,
          );
        } catch {
          return { status: "outcome_unknown", dispatchId: request.key };
        }
      }
      return knownOrUnknown(request.key, current);
    }

    // A UI snapshot is never dispatch authority. Check this serving host before
    // a reservation or provider effect. The request digest above remains the
    // original intent; a runtime default cannot change same-key replay identity.
    const modelCheck = await this.modelCatalogue.check(
      request.model,
      current?.reasoningEffort ?? request.reasoningEffort,
      {
        deadlineAt: context.deadlineAt ?? this.mutationExpiresAt,
        signal: context.signal,
        resolveDefault: current === null,
      },
    );
    const afterCatalogue = await this.authority.resolve(request.workspaceId);
    if (
      !this.dispatchStillAllowed(context) ||
      !validWorkspace(afterCatalogue) ||
      !sameWorkspace(afterCatalogue, workspace)
    )
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (modelCheck.status === "refused")
      return this.unavailableModel(modelCheck);
    request = withResolvedEffort(request, modelCheck.effort);

    try {
      if (
        !(await exactProject(host, request.projectId, workspace.project.root))
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
    if (
      !this.dispatchStillAllowed(context) ||
      !this.modelCatalogue.isCurrent(modelCheck.scope, modelCheck.observedAt)
    )
      return { status: "refused", code: "TASK_MODEL_CATALOG_CHANGED" };
    let reserved: HandoffRecord;
    try {
      reserved = await this.journal.reserve(request.key, {
        requestDigest,
        ...(this.supportsDispatchAttempts()
          ? { dispatchProtocol: 1 as const }
          : {}),
        modelCatalogue: {
          modelId: modelCheck.model.id,
          observedAt: modelCheck.observedAt,
          scope: modelCheck.scope,
        },
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
    if (reservationConflict(reserved, requestDigest, request, workspace)) {
      return { status: "refused", code: "HANDOFF_RESERVATION_CONFLICT" };
    }
    // Concurrent same-key requests can observe different runtime defaults.
    // The journal winner, not the last catalogue response, owns the binding.
    if (reservationRaced(reserved, request))
      return { status: "outcome_unknown", dispatchId: request.key };
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
    let dispatchAttempt: number | undefined;
    if (reserved.dispatchProtocol === 1) {
      try {
        const claimed = await this.journal.claimDispatchAttempt?.(
          request.key,
          true,
        );
        if (claimed === null || claimed === undefined)
          return { status: "outcome_unknown", dispatchId: request.key };
        dispatchAttempt = claimed;
      } catch {
        return { status: "outcome_unknown", dispatchId: request.key };
      }
    }
    // The durable claim precedes the first host side effect. A lost response,
    // crash or write failure cannot turn a replay into a second thread/start.
    let threadId: string;
    try {
      const atSend = await this.authority.resolve(request.workspaceId);
      if (
        !this.dispatchStillAllowed(context) ||
        !validWorkspace(atSend) ||
        !sameWorkspace(atSend, workspace) ||
        !this.modelCatalogue.isCurrent(modelCheck.scope, modelCheck.observedAt)
      )
        throw new HandoffNotSubmittedError(
          "HANDOFF_DISPATCH_AUTHORITY_CHANGED",
        );
      const started = object(
        await host.request(
          "thread/start",
          threadStartParams(request.projectId, workspace, request.model),
        ),
      );
      const startedId = startedThreadId(started, {
        projectId: request.projectId,
        model: request.model,
        workspace,
      });
      if (startedId === null) {
        throw new Error("HANDOFF_THREAD_BINDING_UNVERIFIED");
      }
      threadId = startedId;
      await this.journal.recordThread(request.key, threadId);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    return this.startTurn(
      request,
      threadId,
      workspace,
      modelCheck,
      context,
      dispatchAttempt,
    );
  }

  private async startTurn(
    request: HandoffRequest,
    threadId: string,
    workspace: HandoffWorkspace,
    modelCheck: Extract<CodexModelCheck, { status: "available" }>,
    context: HandoffReadContext,
    dispatchAttempt?: number,
  ): Promise<HandoffCreateResult> {
    const host = this.readHost(context);
    // recordThread has already made the operation durable. Consume the turn
    // before awaiting authority so cancellation cannot make it replayable.
    let claimedTurn: boolean;
    try {
      claimedTurn = await this.journal.claimTurn(request.key);
    } catch {
      return this.finishUnsubmittedAttempt(
        request.key,
        context,
        dispatchAttempt,
        false,
        false,
      );
    }
    if (!claimedTurn) {
      return this.finishUnsubmittedAttempt(
        request.key,
        context,
        dispatchAttempt,
        false,
        false,
      );
    }
    let effectPossible = false;
    try {
      const atSend = await this.authority.resolve(request.workspaceId);
      if (
        !this.dispatchStillAllowed(context) ||
        !validWorkspace(atSend) ||
        !sameWorkspace(atSend, workspace) ||
        !this.modelCatalogue.isCurrent(modelCheck.scope, modelCheck.observedAt)
      )
        throw new HandoffNotSubmittedError(
          "HANDOFF_DISPATCH_AUTHORITY_CHANGED",
        );
      effectPossible = true;
      const started = object(
        await host.request(
          "turn/start",
          turnStartParams(
            threadId,
            request.message,
            workspace,
            request.model,
            request.reasoningEffort,
          ),
        ),
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
      return this.finishUnsubmittedAttempt(
        request.key,
        context,
        dispatchAttempt,
        effectPossible,
        false,
      );
    }
  }

  async status(
    dispatchId: string,
    context: HandoffReadContext = {},
  ): Promise<HandoffStatusResult> {
    if (!this.readStillAllowed(context))
      return { status: "outcome_unknown", dispatchId };
    const host = this.readHost(context);
    if (!/^[0-9a-f-]{36}$/iu.test(dispatchId)) return { status: "unknown" };
    let record: HandoffRecord | null;
    try {
      record = await this.journal.read(dispatchId);
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
    if (!this.readStillAllowed(context))
      return { status: "outcome_unknown", dispatchId };
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
      !this.readStillAllowed(context) ||
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
        await host.request("thread/read", threadReadParams(record.threadId)),
      );
      const thread = object(response?.thread);
      if (
        !threadBound(
          thread,
          record.threadId,
          record.projectId,
          record.workspace.root,
        ) ||
        (record.model !== undefined && !threadModelBound(thread, record.model))
      ) {
        return { status: "outcome_unknown", dispatchId };
      }
      const threadRuntime = readCodexThreadRuntime(thread.status);
      if (!threadRuntime) return { status: "outcome_unknown", dispatchId };
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 32; page += 1) {
        const turns = object(
          await host.request("thread/turns/list", {
            threadId: record.threadId,
            cursor,
            limit: 100,
            itemsView: "notLoaded",
          }),
        );
        const found = statusPage(turns, record.turnId);
        if (found.kind === "invalid")
          return { status: "outcome_unknown", dispatchId };
        if (found.kind === "found") {
          const current = await this.authority.resolve(record.workspaceId);
          if (
            !validWorkspace(current) ||
            !samePhysicalWorkspace(current, record.workspace)
          )
            return { status: "outcome_unknown", dispatchId };
          if (record.adopted && !(await this.adoptedReadStillAllowed(record)))
            return { status: "outcome_unknown", dispatchId };
          if (!this.readStillAllowed(context))
            return { status: "outcome_unknown", dispatchId };
          return {
            status: "known",
            dispatchId,
            threadId: record.threadId,
            turnId: record.turnId,
            turnStatus: found.status,
            threadRuntime,
          };
        }
        const next = statusNextCursor(found.nextCursor, seen);
        if (next === null) break;
        cursor = next;
        seen.add(cursor);
      }
    } catch {
      // A status read is never a reason to create another task or turn.
    }
    return { status: "outcome_unknown", dispatchId };
  }

  async result(
    dispatchId: string,
    context: HandoffReadContext = {},
  ): Promise<HandoffResult> {
    const host = this.readHost(context);
    const status = await this.status(dispatchId, context);
    if (!this.readStillAllowed(context))
      return { status: "outcome_unknown", dispatchId };
    if (status.status !== "known") return status;
    let record: HandoffRecord | null;
    try {
      record = await this.journal.read(dispatchId);
      if (
        !this.readStillAllowed(context) ||
        !record ||
        !(await this.resultReadStillAllowed(record))
      )
        return { status: "outcome_unknown", dispatchId };
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
    if (!this.readStillAllowed(context))
      return { status: "outcome_unknown", dispatchId };
    const identity = {
      dispatchId,
      threadId: status.threadId,
      turnId: status.turnId,
    };
    if (status.turnStatus === "inProgress") {
      return {
        status: "running",
        ...identity,
        threadRuntime: status.threadRuntime,
      };
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
          await host.request("thread/items/list", {
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
        const folded = foldFinalAnswer(response.data, status.turnId, final);
        if (!folded) return { status: "outcome_unknown", dispatchId };
        final = folded.final;
        if (response.nextCursor === null) {
          if (
            !(await this.resultReadStillAllowed(record)) ||
            !this.readStillAllowed(context)
          )
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
        const next = itemsNextCursor(response.nextCursor, seen);
        if (next === null) {
          break;
        }
        cursor = next;
        seen.add(cursor);
      }
    } catch {
      // Result reads never create a replacement task or a model turn.
    }
    return { status: "outcome_unknown", dispatchId };
  }

  private supportsDispatchAttempts(): boolean {
    return supportsDispatchAttempts(this.deps);
  }

  private async finishUnsubmittedAttempt(
    key: string,
    context: HandoffReadContext,
    attempt: number | undefined,
    effectPossible: boolean,
    consumeCancellation = true,
  ): Promise<HandoffCreateResult> {
    const action = unsubmittedAction(
      effectPossible,
      !!context.signal?.aborted,
      consumeCancellation,
      attempt,
    );
    try {
      if (action === "consume-turn") {
        // The attempt was consumed before binding. Even if this write fails,
        // cancellation has no no-effect proof and cannot authorize replay.
        await this.journal.claimTurn(key);
      } else if (action === "record-refusal") {
        // Only the owner of this attempt may attest a known pre-send refusal.
        // Failed publication leaves it consumed, never silently retryable.
        await this.journal.recordPreEffectRefusal?.(
          key,
          attempt!,
          () => !context.signal?.aborted,
        );
      }
    } catch {
      // No provider effect follows an unknown durable write.
    }
    return { status: "outcome_unknown", dispatchId: key };
  }

  private dispatchStillAllowed(context: HandoffReadContext): boolean {
    return dispatchStillAllowed(this.deps, context);
  }

  private readStillAllowed(context: HandoffReadContext): boolean {
    return readStillAllowed(this.deps, context);
  }

  private readHost(context: HandoffReadContext): HandoffHost {
    return readHost(this.deps, context);
  }

  private async adoptedReadStillAllowed(
    record: HandoffRecord,
  ): Promise<boolean> {
    return adoptedReadStillAllowed(this.deps, record);
  }

  private async resultReadStillAllowed(
    record: HandoffRecord,
  ): Promise<boolean> {
    return resultReadStillAllowed(this.deps, record);
  }
}

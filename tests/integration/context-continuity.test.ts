import { describe, expect, it, vi } from "vitest";
import type {
  ContextSummaryReceipt,
  ContextSummarizer,
} from "../../src/modules/chat/app/port/context-summarizer";
import type { HostContextBridge } from "../../src/modules/chat/app/port/host-context-bridge";
import type { ContextSourceControl } from "../../src/modules/chat/app/port/context-source-control";
import type { ContextRepository } from "../../src/modules/chat/app/port/context-repository";
import { CompactContext } from "../../src/modules/chat/app/service/compact-context";
import {
  activateNextEpoch,
  beginCompaction,
  blockContext,
  confirmHostContext,
  createContextSession,
  markCheckpointStored,
  markOldEpochRetired,
  markSummaryDispatchObserved,
  offerCheckpointHandoff,
  recordValidatedCheckpoint,
  requestCheckpoint,
  type ContextBinding,
  type ContextSession,
} from "../../src/modules/chat/domain/context-continuity";
import {
  createCheckpointEnvelope,
  validateCheckpointContent,
  type CheckpointContent,
} from "../../src/modules/chat/domain/checkpoint";
import { InMemoryCheckpoints } from "../../src/modules/chat/infra/repo/in-memory-checkpoints";
import { InMemoryContextSessions } from "../../src/modules/chat/infra/repo/in-memory-context-sessions";

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "task-atlantic",
  hostThreadId: "thread-atlantic",
  sessionId: "session-atlantic",
  providerProfileId: "profile-isolated-farol",
  modelId: "chatgpt-web/high",
  mode: "high",
};

const command = {
  binding,
  operationId: "compact-atlantic-1",
  source: "retained_agent" as const,
  sourceBoundary: "message-42",
};

const content: CheckpointContent = {
  goal: "Continue the exact Farol task.",
  activeConstraints: ["Never repeat an outcome-unknown write."],
  latestCorrections: ["Use Watch Rail, not Graphite."],
  keyDecisions: ["Context continuity belongs to Chat."],
  completedWork: [
    { description: "Watch Rail committed.", evidenceRefs: ["git:ec15b2e"] },
  ],
  unfinishedWork: ["Connect native host compaction."],
  unresolvedQuestions: ["Whether the retained source is reusable."],
  unknownOutcomes: [
    { operationRef: "write-17", description: "Acknowledgement was lost." },
  ],
  artifactRefs: [
    { reference: "vnext/src/modules/chat", availability: "available" },
  ],
  attachmentRefs: [{ reference: "owner-image-1", availability: "unavailable" }],
  nextSafeStep: "Observe write-17 before another mutation.",
};

const completedSummary: ContextSummaryReceipt = {
  status: "completed",
  providerOperationId: "provider-summary-1",
  sourceCursor: "cursor-42",
  content,
};

function value<T>(result: {
  ok: boolean;
  value?: T;
  error?: { code: string };
}): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(result.error?.code ?? "EXPECTED_SUCCESS");
  }
  return result.value;
}

function storedSession(
  phase: "checkpoint_requested" | "validated" | "durably_stored",
) {
  let state = value(beginCompaction(createContextSession(binding), command));
  state = value(requestCheckpoint(state));
  if (phase === "checkpoint_requested") return state;
  state = value(markSummaryDispatchObserved(state));
  const parsed = validateCheckpointContent(content, 16_384);
  if (!parsed.ok) throw new Error(parsed.error.code);
  const checkpoint = createCheckpointEnvelope(state, parsed.value, {
    checkpointId: "checkpoint-1",
    providerOperationId: "provider-summary-1",
    parentCheckpointId: null,
    sourceCursor: "cursor-42",
    createdAt: 1_000,
  });
  state = value(recordValidatedCheckpoint(state, checkpoint));
  if (phase === "validated") return state;
  return value(markCheckpointStored(state));
}

function checkpointFixture() {
  const requested = value(
    requestCheckpoint(
      value(beginCompaction(createContextSession(binding), command)),
    ),
  );
  return createCheckpointEnvelope(requested, content, {
    checkpointId: "checkpoint-1",
    providerOperationId: "provider-summary-1",
    parentCheckpointId: null,
    sourceCursor: "cursor-42",
    createdAt: 1_000,
  });
}

function sessionAt(
  phase:
    | "handoff_offered"
    | "host_context_confirmed"
    | "old_epoch_retired"
    | "active_completed"
    | "blocked",
): ContextSession {
  let state = storedSession("durably_stored");
  state = value(offerCheckpointHandoff(state));
  if (phase === "handoff_offered") return state;
  state = value(confirmHostContext(state, "host-context-2"));
  if (phase === "host_context_confirmed") return state;
  if (phase === "blocked") return value(blockContext(state, "SYNTHETIC_BLOCK"));
  state = value(markOldEpochRetired(state));
  if (phase === "old_epoch_retired") return state;
  return value(activateNextEpoch(state));
}

function harness(
  options: Readonly<{
    initial?: ContextSession;
    now?: () => number;
    summary?: ContextSummaryReceipt;
    sessions?: ContextRepository;
    checkpoints?: InMemoryCheckpoints;
  }> = {},
) {
  const sessions =
    options.sessions ??
    new InMemoryContextSessions(options.initial ? [options.initial] : []);
  const checkpoints = options.checkpoints ?? new InMemoryCheckpoints();
  const request = vi
    .fn<ContextSummarizer["request"]>()
    .mockResolvedValue(options.summary ?? completedSummary);
  const observe = vi
    .fn<ContextSummarizer["observe"]>()
    .mockResolvedValue(options.summary ?? completedSummary);
  const offer = vi.fn<HostContextBridge["offer"]>().mockResolvedValue({
    status: "confirmed",
    hostContextRef: "host-context-2",
  });
  const reconcile = vi.fn<HostContextBridge["reconcile"]>().mockResolvedValue({
    status: "confirmed",
    hostContextRef: "host-context-2",
  });
  const preflight = vi
    .fn<HostContextBridge["preflight"]>()
    .mockResolvedValue({ status: "ready" });
  const retire = vi
    .fn<ContextSourceControl["retire"]>()
    .mockResolvedValue({ status: "retired" });
  const service = new CompactContext(
    { request, observe },
    sessions,
    checkpoints,
    { preflight, offer, reconcile },
    { retire },
    { now: options.now ?? (() => 1_000) },
    { nextCheckpointId: () => "checkpoint-1" },
    16_384,
  );
  return {
    service,
    sessions,
    checkpoints,
    request,
    observe,
    preflight,
    offer,
    reconcile,
    retire,
  };
}

async function seedCheckpoint(test: ReturnType<typeof harness>): Promise<void> {
  await test.checkpoints.put(checkpointFixture());
}

function failSaveAt(test: ReturnType<typeof harness>, target: number): void {
  const save = test.sessions.save.bind(test.sessions);
  let saves = 0;
  vi.spyOn(test.sessions, "save").mockImplementation(async (session, lease) => {
    saves += 1;
    if (saves === target) throw new Error(`synthetic save failure ${target}`);
    await save(session, lease);
  });
}

describe("context continuity transaction", () => {
  it("coalesces concurrent triggers into one summary and one epoch change", async () => {
    const test = harness();
    const [left, right] = await Promise.all([
      test.service.execute(command),
      test.service.execute(command),
    ]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.offer).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
    expect(test.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: command.operationId,
        capability: {
          kind: "checkpoint_return",
          operationId: command.operationId,
        },
        executionTools: [],
      }),
    );
  });

  it("serializes distinct triggers for the same source boundary", async () => {
    const test = harness();
    const automatic = {
      ...command,
      operationId: "automatic-atlantic-1",
    };

    const [manualResult, automaticResult] = await Promise.all([
      test.service.execute(command),
      test.service.execute(automatic),
    ]);

    const rejected = [manualResult, automaticResult].find(
      (result) => !result.ok,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_ADMISSION_CONFLICT" },
    });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.offer).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
  });

  it("rejects an in-flight trigger with a foreign immutable binding", async () => {
    const test = harness();
    const foreign = {
      ...command,
      binding: {
        ...command.binding,
        providerProfileId: "profile-foreign",
      },
    };

    const [accepted, rejected] = await Promise.all([
      test.service.execute(command),
      test.service.execute(foreign),
    ]);

    expect(accepted).toMatchObject({ ok: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_BINDING_CONFLICT" },
    });
    expect(test.request).toHaveBeenCalledTimes(1);
  });

  it("fences two coordinators sharing one durable session", async () => {
    const sessions = new InMemoryContextSessions();
    const first = harness({ sessions });
    const second = harness({ sessions });

    const results = await Promise.all([
      first.service.execute(command),
      second.service.execute({
        ...command,
        operationId: "automatic-atlantic-1",
      }),
    ]);

    const rejected = results.find((result) => !result.ok);
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(
          /CONTEXT_(ADMISSION_CONFLICT|OPERATION_IN_PROGRESS)/u,
        ),
      },
    });
    expect(
      first.request.mock.calls.length + second.request.mock.calls.length,
    ).toBe(1);
  });

  it("reloads the durable session after a delayed admission and reuses the completed result", async () => {
    const sessions = new InMemoryContextSessions();
    const checkpoints = new InMemoryCheckpoints();
    let announceAcquire!: () => void;
    let resumeAcquire!: () => void;
    const acquireStarted = new Promise<void>((resolve) => {
      announceAcquire = resolve;
    });
    const acquireAllowed = new Promise<void>((resolve) => {
      resumeAcquire = resolve;
    });
    const delayedSessions: ContextRepository = {
      load: (selected) => sessions.load(selected),
      save: (session, lease) => sessions.save(session, lease),
      acquireCompactionAdmission: async (...args) => {
        announceAcquire();
        await acquireAllowed;
        return sessions.acquireCompactionAdmission(...args);
      },
      releaseCompactionAdmission: (lease) =>
        sessions.releaseCompactionAdmission(lease),
    };
    const first = harness({ sessions, checkpoints });
    const delayed = harness({ sessions: delayedSessions, checkpoints });

    const delayedExecution = delayed.service.execute(command);
    await acquireStarted;
    const firstResult = await first.service.execute(command);
    resumeAcquire();
    const delayedResult = await delayedExecution;

    expect(firstResult).toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(delayedResult).toEqual(firstResult);
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(delayed.request).not.toHaveBeenCalled();
    expect(delayed.observe).not.toHaveBeenCalled();
  });

  it("fails closed when the durable admission lease cannot be released", async () => {
    const test = harness();
    vi.spyOn(test.sessions, "releaseCompactionAdmission").mockRejectedValueOnce(
      new Error("synthetic lease release failure"),
    );

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(test.request).toHaveBeenCalledTimes(1);
  });

  it("fails closed when durable admission cannot be read", async () => {
    const test = harness();
    vi.spyOn(test.sessions, "acquireCompactionAdmission").mockRejectedValueOnce(
      new Error("synthetic admission read failure"),
    );

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(test.request).not.toHaveBeenCalled();
  });

  it("maps durable admission binding conflicts without starting work", async () => {
    const test = harness();
    vi.spyOn(test.sessions, "acquireCompactionAdmission").mockResolvedValueOnce(
      { status: "conflict", reason: "binding" },
    );

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_BINDING_CONFLICT" },
    });
    expect(test.request).not.toHaveBeenCalled();
  });

  it("releases the admission while preserving an unexpected execution error", async () => {
    const test = harness({
      now: () => {
        throw new Error("synthetic clock failure");
      },
    });
    const release = vi
      .spyOn(test.sessions, "releaseCompactionAdmission")
      .mockRejectedValueOnce(new Error("synthetic lease release failure"));

    await expect(test.service.execute(command)).rejects.toThrow(
      "synthetic clock failure",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated sessions independent while each is admitted once", async () => {
    const sessions = new InMemoryContextSessions();
    const first = harness({ sessions });
    const second = harness({ sessions });
    const harbor = {
      ...command,
      binding: {
        ...binding,
        taskId: "task-harbor",
        hostThreadId: "thread-harbor",
        sessionId: "session-harbor",
      },
      operationId: "compact-harbor-1",
      sourceBoundary: "message-harbor-42",
    };

    const results = await Promise.all([
      first.service.execute(command),
      second.service.execute(harbor),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(second.request).toHaveBeenCalledTimes(1);
  });

  it("observes a recovered request instead of resubmitting it", async () => {
    const test = harness({
      initial: storedSession("checkpoint_requested"),
      summary: {
        status: "outcome_unknown",
        code: "SUMMARY_SUBMISSION_UNRESOLVED",
      },
    });

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "outcome_unknown",
          blockedCode: "SUMMARY_SUBMISSION_UNRESOLVED",
        },
      },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.observe).toHaveBeenCalledTimes(1);
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("returns to the old active epoch when recovery proves no submission", async () => {
    const test = harness({ initial: storedSession("checkpoint_requested") });
    test.observe.mockResolvedValue({
      status: "not_submitted",
      code: "SUMMARY_NOT_SUBMITTED",
    });

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 1, operation: null } },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("reuses a durable checkpoint after restart without another summary", async () => {
    const initial = storedSession("durably_stored");
    const test = harness({ initial });
    const checkpoint = createCheckpointEnvelope(
      value(
        requestCheckpoint(
          value(beginCompaction(createContextSession(binding), command)),
        ),
      ),
      content,
      {
        checkpointId: "checkpoint-1",
        providerOperationId: "provider-summary-1",
        parentCheckpointId: null,
        sourceCursor: "cursor-42",
        createdAt: 1_000,
      },
    );
    await test.checkpoints.put(checkpoint);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).toHaveBeenCalledTimes(1);
  });

  it("reconciles an offered handoff instead of delivering it twice", async () => {
    let initial = storedSession("durably_stored");
    initial = value(offerCheckpointHandoff(initial));
    const test = harness({ initial });
    const requested = value(
      requestCheckpoint(
        value(beginCompaction(createContextSession(binding), command)),
      ),
    );
    await test.checkpoints.put(
      createCheckpointEnvelope(requested, content, {
        checkpointId: "checkpoint-1",
        providerOperationId: "provider-summary-1",
        parentCheckpointId: null,
        sourceCursor: "cursor-42",
        createdAt: 1_000,
      }),
    );

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.reconcile).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
  });

  it("does not destroy the source when durable checkpoint storage fails", async () => {
    const test = harness();
    test.checkpoints.failNextPut("CHECKPOINT_WRITE_DENIED");

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
    await expect(test.sessions.load(binding)).resolves.toMatchObject({
      phase: "validated",
      epoch: 1,
    });

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.observe).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
  });

  it("fails closed when context state cannot be loaded or persisted", async () => {
    const loadFailure = harness();
    vi.spyOn(loadFailure.sessions, "load").mockRejectedValueOnce(
      new Error("read denied"),
    );
    await expect(loadFailure.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(loadFailure.request).not.toHaveBeenCalled();

    const firstSaveFailure = harness();
    vi.spyOn(firstSaveFailure.sessions, "save").mockRejectedValueOnce(
      new Error("write denied"),
    );
    await expect(
      firstSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(firstSaveFailure.request).not.toHaveBeenCalled();

    const secondSaveFailure = harness();
    const save = secondSaveFailure.sessions.save.bind(
      secondSaveFailure.sessions,
    );
    let saves = 0;
    vi.spyOn(secondSaveFailure.sessions, "save").mockImplementation(
      async (session) => {
        saves += 1;
        if (saves === 2) throw new Error("checkpoint admission denied");
        await save(session);
      },
    );
    await expect(
      secondSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(secondSaveFailure.request).not.toHaveBeenCalled();
  });

  it("rejects foreign repository state and malformed persisted stages", async () => {
    const foreign = harness();
    vi.spyOn(foreign.sessions, "load").mockResolvedValueOnce({
      ...createContextSession(binding),
      binding: { ...binding, taskId: "task-harbor" },
    });
    await expect(foreign.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_BINDING_CONFLICT" },
    });

    const noOperation = harness({
      initial: {
        ...createContextSession(binding),
        phase: "checkpoint_requested",
      },
    });
    await expect(noOperation.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });

    const invalidValidated = harness({
      initial: {
        ...createContextSession(binding),
        phase: "validated",
      },
    });
    await expect(
      invalidValidated.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });
  });

  it("returns the same completed checkpoint without any repeated side effect", async () => {
    const test = harness({ initial: sessionAt("active_completed") });
    await seedCheckpoint(test);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: { phase: "active", epoch: 2 },
        checkpoint: { checkpointId: "checkpoint-1" },
      },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("rejects completed-operation replay with a changed payload", async () => {
    const test = harness({ initial: sessionAt("active_completed") });
    await seedCheckpoint(test);

    await expect(
      test.service.execute({
        ...command,
        sourceBoundary: "message-forged",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_ADMISSION_CONFLICT" },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("does not replay a legacy completed id without its full payload", async () => {
    const test = harness({
      initial: {
        ...sessionAt("active_completed"),
        lastCompletedRequest: null,
      },
    });
    await seedCheckpoint(test);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_ADMISSION_CONFLICT" },
    });
    expect(test.request).not.toHaveBeenCalled();
  });

  it("classifies thrown, blocked, and malformed summary outcomes", async () => {
    const thrown = harness();
    thrown.request.mockRejectedValueOnce(new Error("connection lost"));
    await expect(thrown.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "outcome_unknown",
          blockedCode: "SUMMARY_OBSERVATION_FAILED",
        },
      },
    });

    const blocked = harness({
      summary: { status: "blocked", code: "SUMMARY_SIGN_IN_REQUIRED" },
    });
    await expect(blocked.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "blocked",
          blockedCode: "SUMMARY_SIGN_IN_REQUIRED",
        },
      },
    });

    const malformed = harness({
      summary: { ...completedSummary, content: {} },
    });
    await expect(malformed.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "blocked",
          blockedCode: "CHECKPOINT_CONTENT_INVALID",
        },
      },
    });
  });

  it("does not accept not-submitted after dispatch was already observed", async () => {
    const observed = value(
      markSummaryDispatchObserved(storedSession("checkpoint_requested")),
    );
    const test = harness({
      initial: observed,
      summary: { status: "not_submitted", code: "CONTRADICTORY_RECEIPT" },
    });
    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });
  });

  it("keeps an offered checkpoint until the host confirms installation", async () => {
    const preflightBlocked = harness({
      initial: storedSession("durably_stored"),
    });
    await seedCheckpoint(preflightBlocked);
    preflightBlocked.preflight.mockResolvedValueOnce({
      status: "blocked",
      code: "COMPACTION_BUDGET_EXCEEDED",
    });
    await expect(
      preflightBlocked.service.execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "blocked",
          blockedCode: "COMPACTION_BUDGET_EXCEEDED",
        },
      },
    });
    expect(preflightBlocked.offer).not.toHaveBeenCalled();
    expect(preflightBlocked.retire).not.toHaveBeenCalled();

    const waiting = harness({ initial: storedSession("durably_stored") });
    await seedCheckpoint(waiting);
    waiting.offer.mockResolvedValueOnce({ status: "awaiting_confirmation" });
    await expect(waiting.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "handoff_offered", epoch: 1 } },
    });
    expect(waiting.retire).not.toHaveBeenCalled();

    const blocked = harness({ initial: storedSession("durably_stored") });
    await seedCheckpoint(blocked);
    blocked.offer.mockResolvedValueOnce({
      status: "blocked",
      code: "HOST_VARIANT_UNSUPPORTED",
    });
    await expect(blocked.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: { phase: "blocked", blockedCode: "HOST_VARIANT_UNSUPPORTED" },
      },
    });

    const unknown = harness({ initial: storedSession("durably_stored") });
    await seedCheckpoint(unknown);
    unknown.offer.mockRejectedValueOnce(new Error("host disconnected"));
    await expect(unknown.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "outcome_unknown",
          blockedCode: "HOST_HANDOFF_UNKNOWN",
        },
      },
    });
  });

  it("offers only after reconciliation proves the earlier handoff absent", async () => {
    const test = harness({ initial: sessionAt("handoff_offered") });
    await seedCheckpoint(test);
    test.reconcile.mockResolvedValueOnce({ status: "not_offered" });

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.reconcile).toHaveBeenCalledTimes(1);
    expect(test.offer).toHaveBeenCalledTimes(1);
  });

  it("classifies a lost reconciliation without offering again", async () => {
    const test = harness({ initial: sessionAt("handoff_offered") });
    await seedCheckpoint(test);
    test.reconcile.mockRejectedValueOnce(new Error("host unavailable"));

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "outcome_unknown",
          blockedCode: "HOST_HANDOFF_UNKNOWN",
        },
      },
    });
    expect(test.offer).not.toHaveBeenCalled();
  });

  it("keeps the confirmed old epoch when source retirement is not proven", async () => {
    const blocked = harness({ initial: sessionAt("host_context_confirmed") });
    await seedCheckpoint(blocked);
    blocked.retire.mockResolvedValueOnce({
      status: "blocked",
      code: "SOURCE_RETIREMENT_BLOCKED",
    });
    await expect(blocked.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: { phase: "blocked", blockedCode: "SOURCE_RETIREMENT_BLOCKED" },
      },
    });

    const unknown = harness({ initial: sessionAt("host_context_confirmed") });
    await seedCheckpoint(unknown);
    unknown.retire.mockRejectedValueOnce(new Error("browser disappeared"));
    await expect(unknown.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          phase: "outcome_unknown",
          blockedCode: "SOURCE_RETIREMENT_UNKNOWN",
        },
      },
    });
  });

  it("finishes a crash-recovered retired epoch without repeating retirement", async () => {
    const test = harness({ initial: sessionAt("old_epoch_retired") });
    await seedCheckpoint(test);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });
    expect(test.retire).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
  });

  it("fails closed when a required durable checkpoint is missing or unreadable", async () => {
    const missing = harness({ initial: storedSession("durably_stored") });
    await expect(missing.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_MISSING" },
    });
    expect(missing.offer).not.toHaveBeenCalled();

    const unreadable = harness({ initial: storedSession("durably_stored") });
    vi.spyOn(unreadable.checkpoints, "get").mockRejectedValueOnce(
      new Error("corrupt store"),
    );
    await expect(unreadable.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });
  });

  it("returns a persisted blocked state without retrying any boundary", async () => {
    const test = harness({ initial: sessionAt("blocked") });
    await seedCheckpoint(test);
    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "blocked" } },
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("rejects an invalid new operation and malformed quiescing state", async () => {
    const invalid = harness();
    await expect(
      invalid.service.execute({ ...command, operationId: "" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });

    const malformed = harness({
      initial: { ...createContextSession(binding), phase: "quiescing" },
    });
    await expect(malformed.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });
  });

  it("fails closed at each checkpoint transaction persistence boundary", async () => {
    const afterDispatch = harness();
    failSaveAt(afterDispatch, 3);
    await expect(afterDispatch.service.execute(command)).resolves.toMatchObject(
      {
        ok: false,
        error: { code: "CONTEXT_REPOSITORY_FAILED" },
      },
    );

    const afterValidation = harness();
    failSaveAt(afterValidation, 4);
    await expect(
      afterValidation.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    const afterCheckpointWrite = harness();
    failSaveAt(afterCheckpointWrite, 5);
    await expect(
      afterCheckpointWrite.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
  });

  it("resumes after the checkpoint write outlives its session transition", async () => {
    let now = 1_000;
    const test = harness({ now: () => (now += 1_000) });
    failSaveAt(test, 5);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "active", epoch: 2 } },
    });

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
  });

  it("rejects a durable checkpoint that does not match the validated session", async () => {
    const test = harness({ initial: storedSession("validated") });
    await test.checkpoints.put({
      ...checkpointFixture(),
      operationId: "compact-foreign-1",
    });

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });

    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });

  it("fails closed when a recovered validated checkpoint cannot be read", async () => {
    const test = harness({ initial: storedSession("validated") });
    vi.spyOn(test.checkpoints, "get").mockRejectedValueOnce(
      new Error("synthetic checkpoint read failure"),
    );

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });

    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
  });

  it("fails closed when a recovered durable checkpoint transition is not persisted", async () => {
    const test = harness({ initial: storedSession("validated") });
    await seedCheckpoint(test);
    failSaveAt(test, 1);

    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    expect(test.observe).not.toHaveBeenCalled();
    expect(test.offer).not.toHaveBeenCalled();
  });

  it("handles failures while resuming a validated summary", async () => {
    const observationFailure = harness({
      initial: storedSession("validated"),
    });
    observationFailure.observe.mockRejectedValueOnce(
      new Error("provider observation failed"),
    );
    await expect(
      observationFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });

    const writeFailure = harness({ initial: storedSession("validated") });
    writeFailure.checkpoints.failNextPut("CHECKPOINT_WRITE_DENIED");
    await expect(writeFailure.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STORE_FAILED" },
    });

    const blocked = harness({
      initial: storedSession("validated"),
      summary: { status: "blocked", code: "SUMMARY_QUOTA_EXHAUSTED" },
    });
    await expect(blocked.service.execute(command)).resolves.toMatchObject({
      ok: true,
      value: { session: { phase: "blocked" } },
    });
  });

  it("fails closed when classified summary state cannot be persisted", async () => {
    const beforeSubmit = harness({
      initial: storedSession("checkpoint_requested"),
      summary: { status: "not_submitted", code: "SUMMARY_NOT_SUBMITTED" },
    });
    failSaveAt(beforeSubmit, 1);
    await expect(beforeSubmit.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    const blocked = harness({
      summary: { status: "blocked", code: "SUMMARY_SIGN_IN_REQUIRED" },
    });
    failSaveAt(blocked, 4);
    await expect(blocked.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    const emptyCode = harness({
      summary: { status: "blocked", code: "" },
    });
    await expect(emptyCode.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });
  });

  it("fails closed around host-offer persistence and acknowledgement", async () => {
    const offerSaveFailure = harness({
      initial: storedSession("durably_stored"),
    });
    await seedCheckpoint(offerSaveFailure);
    failSaveAt(offerSaveFailure, 1);
    await expect(
      offerSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(offerSaveFailure.offer).not.toHaveBeenCalled();

    const invalidConfirmation = harness({
      initial: storedSession("durably_stored"),
    });
    await seedCheckpoint(invalidConfirmation);
    invalidConfirmation.offer.mockResolvedValueOnce({
      status: "confirmed",
      hostContextRef: "",
    });
    await expect(
      invalidConfirmation.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });

    const confirmationSaveFailure = harness({
      initial: storedSession("durably_stored"),
    });
    await seedCheckpoint(confirmationSaveFailure);
    failSaveAt(confirmationSaveFailure, 2);
    await expect(
      confirmationSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
  });

  it("fails closed while restoring a host offer proven absent", async () => {
    const test = harness({ initial: sessionAt("handoff_offered") });
    await seedCheckpoint(test);
    test.reconcile.mockResolvedValueOnce({ status: "not_offered" });
    failSaveAt(test, 1);
    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
    expect(test.offer).not.toHaveBeenCalled();
  });

  it("fails closed at both old-epoch retirement persistence boundaries", async () => {
    const retiredSaveFailure = harness({
      initial: sessionAt("host_context_confirmed"),
    });
    await seedCheckpoint(retiredSaveFailure);
    failSaveAt(retiredSaveFailure, 1);
    await expect(
      retiredSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    const activeSaveFailure = harness({
      initial: sessionAt("host_context_confirmed"),
    });
    await seedCheckpoint(activeSaveFailure);
    failSaveAt(activeSaveFailure, 2);
    await expect(
      activeSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });

    const recoveredSaveFailure = harness({
      initial: sessionAt("old_epoch_retired"),
    });
    await seedCheckpoint(recoveredSaveFailure);
    failSaveAt(recoveredSaveFailure, 1);
    await expect(
      recoveredSaveFailure.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_REPOSITORY_FAILED" },
    });
  });

  it("rejects malformed confirmed and retired states without cleanup", async () => {
    const confirmedWithoutOperation = harness({
      initial: {
        ...createContextSession(binding),
        phase: "host_context_confirmed",
      },
    });
    await expect(
      confirmedWithoutOperation.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });

    const confirmedWithoutCheckpoint = harness({
      initial: sessionAt("host_context_confirmed"),
    });
    await expect(
      confirmedWithoutCheckpoint.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_MISSING" },
    });

    const malformedRetired = harness({
      initial: {
        ...sessionAt("old_epoch_retired"),
        operation: {
          ...sessionAt("old_epoch_retired").operation!,
          hostContextRef: null,
        },
      },
    });
    await seedCheckpoint(malformedRetired);
    await expect(
      malformedRetired.service.execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TRANSITION_FAILED" },
    });
  });

  it("rejects a repeated completed operation with no checkpoint reference", async () => {
    const test = harness({
      initial: {
        ...sessionAt("active_completed"),
        lastCheckpointId: null,
      },
    });
    await expect(test.service.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_MISSING" },
    });
  });
});

describe("summary provenance transaction", () => {
  const receipt = {
    ...completedSummary,
    status: "completed" as const,
    providerOperationId: "provider-summary-1",
    sourceCursor: "cursor-42",
    content,
    summarizer: {
      engine: "current_chatgpt" as const,
      provider: "chatgpt-web" as const,
      observedModel: null,
      observedEffort: null,
      providerOperationId: "provider-summary-1",
      sourceBoundary: command.sourceBoundary,
      sourceCursor: "cursor-42",
    },
  };
  it("persists a current-ChatGPT v2 checkpoint through the existing transaction", async () => {
    const test = harness({ summary: receipt });
    const result = value(await test.service.execute(command));
    expect(result.checkpoint).toMatchObject({
      schemaVersion: 2,
      binding,
      summarizer: receipt.summarizer,
    });
    expect(result.checkpoint?.content.unknownOutcomes).toEqual(
      content.unknownOutcomes,
    );
    expect(test.offer).toHaveBeenCalledTimes(1);
    expect(test.retire).toHaveBeenCalledTimes(1);
  });
  it("does not hand off or retire a detached provenance receipt", async () => {
    const test = harness({
      summary: {
        ...receipt,
        summarizer: { ...receipt.summarizer, sourceBoundary: "other" },
      },
    });
    const result = value(await test.service.execute(command));
    expect(result.session).toMatchObject({
      phase: "blocked",
      blockedCode: "CHECKPOINT_SUMMARIZER_BINDING_MISMATCH",
    });
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });
  it("cannot silently select Luna via a returned receipt", async () => {
    const test = harness({
      summary: {
        ...receipt,
        summarizer: {
          ...receipt.summarizer,
          engine: "codex_luna",
          provider: "codex",
          observedModel: "fixture-luna",
          observedEffort: "fixture-effort",
        },
      },
    });
    const result = value(await test.service.execute(command));
    expect(result.session).toMatchObject({
      phase: "blocked",
      blockedCode: "SUMMARY_ENGINE_NOT_SELECTED",
    });
    expect(test.offer).not.toHaveBeenCalled();
    expect(test.retire).not.toHaveBeenCalled();
  });
});

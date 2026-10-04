import { describe, expect, it } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import { TaskBridge, TaskBridgeError } from "../../apps/desktop/bridge/task.ts";
import {
  validate,
  type TaskMutation,
  type TaskObservation,
} from "../../apps/desktop/bridge/wire.ts";
import {
  startGoTaskSurfaceFixture,
  TaskSurfaceCloseError,
  type TaskSurfaceCloseProof,
  type TaskSurfaceFixture,
} from "./fixtures/go-task-surface-process.ts";

// Actual desktop Client + TaskBridge -> inherited fd3/fd4 -> Go Server and
// TaskSurface, real Chat parent/Task owner/Codex adapter. Go's journal, host and
// provider socket are CPU doubles. This proves neither native persistence nor
// live Codex/Claude, Electron, activation, production or delivery acceptance.
const context = { profileId: "profile", backendGeneration: "backend" };
const privateSentinel = "CONTROLLED_PRIVATE_TRANSCRIPT_SENTINEL";
function progress(
  out: TaskObservation,
  taskId: string,
  dispatchId: string,
  turnId: string,
): void {
  expect(validate("TaskObservation", out)).toBe(true);
  expect(out).toMatchObject({
    taskId,
    dispatchId,
    reference: { threadId: "thread-exact", turnId },
    lifecycle: "running",
    pending: false,
    retained: false,
    result: "",
    resultEvidence: "",
    gap: false,
    more: false,
    sourceGap: false,
    delivery: "not_observed",
  });
  expect(out.events.map((event) => event.kind)).toEqual([
    "provider_started",
    "tool_started",
    "checkpoint_ready",
    "model_claim",
    "provider_terminal",
  ]);
  expect(out.next.sequence).toBe("5");
  for (const [index, event] of out.events.entries()) {
    expect(event).toMatchObject({
      runId: taskId,
      dispatchId,
      streamId: out.next.streamId,
      generation: out.next.generation,
      sequence: String(index + 1),
      reference: { threadId: "thread-exact", turnId },
    });
  }
  expect(out.events[2]).toMatchObject({
    source: "advisory_model",
    planSteps: 2,
    completedSteps: 1,
  });
  expect(out.events[3]?.source).toBe("advisory_model");
  // A provider terminal notice is evidence about a report, not permission to
  // invent the retained result or advance the owning Task's lifecycle.
  expect(out.events[4]?.reportedLifecycle).toBe("completed");
  expect(JSON.stringify(out)).not.toContain(privateSentinel);
}
function cleanClose(proof: TaskSurfaceCloseProof, turnStart: number): void {
  expect(proof).toMatchObject({
    classification: "controlled-go-task-surface-cpu",
    exitCode: 0,
    signal: null,
    serverClosed: true,
    profileClosed: true,
    runnerPassed: true,
    stats: { launches: 1, threadStart: 1, turnStart },
  });
  expect(proof.originalPid).toBeGreaterThan(0);
}
async function errorFrom(action: Promise<unknown>): Promise<BridgeError> {
  const error: unknown = await action.then(
    () => undefined,
    (rejected: unknown) => rejected,
  );
  expect(error).toBeInstanceOf(BridgeError);
  if (!(error instanceof BridgeError))
    throw new Error("actual_bridge_error_required");
  return error;
}

async function closePreservingFailure(
  peer: TaskSurfaceFixture,
  primary: { error: unknown } | undefined,
): Promise<TaskSurfaceCloseProof> {
  let proof: TaskSurfaceCloseProof;
  try {
    proof = await peer.close();
  } catch (cleanupError) {
    if (primary) {
      // Keep the ORIGINAL assertion/bridge error, its stack and values. The
      // cause exposes it to the reporter; errors also retains close diagnostics.
      const cleanup =
        cleanupError instanceof TaskSurfaceCloseError
          ? cleanupError.message
          : "cleanup_details_redacted";
      throw new AggregateError(
        [primary.error, cleanupError],
        `fixture_primary_and_original_close_failed ${cleanup}`,
        { cause: primary.error },
      );
    }
    throw cleanupError;
  }
  if (primary) throw primary.error;
  return proof;
}

describe("controlled desktop Client to Go TaskSurface CPU journey", () => {
  it("keeps progress truthful, retains the result and follows up on the original thread and connection", async () => {
    const peer = await startGoTaskSurfaceFixture("followup");
    let primary: { error: unknown } | undefined;
    try {
      expect(peer.client.verifiedContext).toEqual(context);
      const resolved = await peer.task.resolve();
      expect(resolved.binding.provider).toBe("codex");
      expect(resolved.binding.profileId).toBe(context.profileId);
      expect(resolved.capabilities).toMatchObject({
        create: true,
        continue: true,
      });
      const created = await peer.task.create(
        { message: "Controlled source question" },
        "create-1",
      );
      expect(created).toMatchObject({
        operationId: "create-1",
        receipt: {
          state: "known",
          reference: { threadId: "thread-exact", turnId: "turn-1" },
          lifecycle: "running",
          result: "",
        },
      });
      const initial = await peer.stats();
      expect(initial).toEqual({
        launches: 1,
        threadStart: 1,
        turnStart: 1,
        threadRead: 0,
      });
      const first = await peer.task.observationRead({
        dispatchId: "create-1",
        includeResult: true,
      });
      progress(first, created.taskId, "create-1", "turn-1");
      const replay = await peer.task.observationRead({
        dispatchId: "create-1",
        cursor: first.next,
      });
      expect(replay.events).toEqual([]);
      expect(replay.next).toEqual(first.next);
      expect(replay.lifecycle).toBe("running");
      expect(replay.retained).toBe(false);
      expect(await peer.stats()).toEqual(initial);

      await peer.complete("turn-1");
      expect(await peer.task.observe()).toMatchObject({
        taskId: created.taskId,
        lifecycle: "completed",
        reference: created.receipt.reference,
      });
      const retained = await peer.task.result({ dispatchId: "create-1" });
      expect(retained).toMatchObject({
        taskId: created.taskId,
        dispatchId: "create-1",
        lifecycle: "completed",
        pending: false,
        retained: true,
        text: "retained turn-1",
        resultEvidence: "task_journal",
        delivery: "not_observed",
      });
      const final = await peer.task.observationRead({
        dispatchId: "create-1",
        includeResult: true,
      });
      expect(final).toMatchObject({
        lifecycle: "completed",
        retained: true,
        result: "retained turn-1",
        resultEvidence: "task_journal",
        delivery: "not_observed",
      });
      expect(final.events).toEqual(first.events);
      const metadata = await peer.task.observationRead({
        dispatchId: "create-1",
        includeResult: false,
      });
      expect(metadata.result).toBe("");
      expect(metadata.events).toEqual(first.events);

      const handle = await peer.follow();
      expect(handle.handleId).not.toBe(peer.handle.handleId);
      // Fresh selected facade; exactly the SAME actual desktop Client. Root
      // controls the selection and retains the original Task owner/Codex client.
      const next = new TaskBridge(peer.client, handle);
      const continued = await next.continue(
        { dispatchId: "create-1", message: "Same thread follow-up" },
        "follow-2",
      );
      expect(continued).toMatchObject({
        operationId: "follow-2",
        taskId: created.taskId,
        receipt: {
          state: "known",
          reference: {
            threadId: created.receipt.reference.threadId,
            turnId: "turn-2",
          },
          lifecycle: "running",
        },
      });
      const beforeHistory = await peer.stats();
      expect(await next.result({ dispatchId: "create-1" })).toEqual(retained);
      expect(
        await next.observationRead({
          dispatchId: "create-1",
          includeResult: true,
        }),
      ).toEqual(final);
      expect(await peer.stats()).toEqual(beforeHistory);
      const second = await next.observationRead({ dispatchId: "follow-2" });
      progress(second, created.taskId, "follow-2", "turn-2");
      expect(second.next.streamId).not.toBe(first.next.streamId);
      await peer.complete("turn-2");
      expect(await next.observe()).toMatchObject({
        taskId: created.taskId,
        lifecycle: "completed",
        reference: continued.receipt.reference,
      });
      const secondResult = await next.result({ dispatchId: "follow-2" });
      expect(secondResult).toMatchObject({
        taskId: created.taskId,
        retained: true,
        lifecycle: "completed",
        text: "retained turn-2",
        resultEvidence: "task_journal",
        delivery: "not_observed",
      });
      expect(
        JSON.stringify([
          first,
          final,
          metadata,
          second,
          retained,
          secondResult,
        ]),
      ).not.toContain(privateSentinel);
      expect(await peer.stats()).toMatchObject({
        launches: 1,
        threadStart: 1,
        turnStart: 2,
      });
      expect(peer.client.verifiedContext).toEqual(context);
    } catch (error) {
      primary = { error };
    }
    const proof = await closePreservingFailure(peer, primary);
    cleanClose(proof, 2);
    expect(proof.scenario).toBe("followup");
  }, 120000);

  it("retains a real provider lost-reply operation through the same Client and never starts another physical turn", async () => {
    const peer = await startGoTaskSurfaceFixture("provider-lost-reply");
    let primary: { error: unknown } | undefined;
    try {
      await peer.task.resolve();
      const request = { message: "One controlled effect" };
      // Go's scripted provider consumes turn/start then drops that RPC reply.
      // Desktop fd3/fd4 stays connected and returns the owning unknown outcome.
      const lost = await errorFrom(peer.task.create(request, "lost-create"));
      expect(lost).toBeInstanceOf(TaskBridgeError);
      expect(lost.state).toBe("unknown");
      // The initial uncertain mutation has no supplied outcome code. Preserve
      // TaskBridge's actual fallback; never fabricate response_timeout/recovery.
      expect(lost.code).toBe("task_request_failed");
      if (
        !(lost instanceof TaskBridgeError) ||
        !validate("TaskMutation", lost.data)
      )
        throw new Error("retained_unknown_mutation_required");
      const mutation = lost.data as TaskMutation;
      expect(mutation.operationId).toBe("lost-create");
      expect(mutation.taskId.length).toBeGreaterThan(0);
      expect(mutation.receipt).toMatchObject({
        state: "outcome_unknown",
        reference: {},
        result: "",
      });
      expect(peer.client.verifiedContext).toEqual(context);
      const started = await peer.stats();
      expect(started).toEqual({
        launches: 1,
        threadStart: 1,
        turnStart: 1,
        threadRead: 0,
      });
      const retained = await peer.task.operationStatus({
        operationId: "lost-create",
      });
      expect(retained).toMatchObject({
        operationId: "lost-create",
        taskId: mutation.taskId,
        action: "create",
        lineage: { threadId: "thread-exact" },
        receipt: { state: "outcome_unknown", result: "" },
      });
      // Only the earlier thread/start ACK is known. The consumed turn/start
      // cannot invent an observed turn ID or a completed provider result.
      expect(retained.lineage.turnId).toBeUndefined();
      expect(retained.receipt.reference.turnId).toBeUndefined();
      expect(await peer.stats()).toEqual(started);
      const repeated = await errorFrom(
        peer.task.create(request, "lost-create"),
      );
      expect(repeated).not.toBeInstanceOf(TaskBridgeError);
      expect(repeated).toMatchObject({
        state: "unknown",
        code: "task_operation_already_attempted",
      });
      expect(await peer.stats()).toEqual(started);
      const replacement = await errorFrom(
        peer.task.create(request, "replacement-create"),
      );
      expect(replacement).toBeInstanceOf(TaskBridgeError);
      // Root checks current Task admission before Create. The unknown effect
      // fenced that route; unavailable describes this NEW attempt, while the
      // original retained operation remains outcome_unknown below.
      expect(replacement).toMatchObject({
        state: "unavailable",
        code: "TASK_UNAVAILABLE",
      });
      expect(await peer.stats()).toEqual(started);
      expect(
        await peer.task.operationStatus({ operationId: "lost-create" }),
      ).toEqual(retained);
      expect(peer.client.verifiedContext).toEqual(context);
    } catch (error) {
      primary = { error };
    }
    const proof = await closePreservingFailure(peer, primary);
    cleanClose(proof, 1);
    expect(proof.scenario).toBe("provider-lost-reply");
    expect(proof.stats.threadRead).toBe(0);
  }, 120000);
});

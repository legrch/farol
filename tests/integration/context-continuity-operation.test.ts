import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CodexContextContinuity,
  type CodexContextSummaryDriver,
} from "../../src/apps/desktop/codex-context-continuity";
import type {
  CheckpointContent,
  CheckpointEnvelope,
} from "../../src/modules/chat/domain/checkpoint";
import type { ContextBinding } from "../../src/modules/chat/domain/context-continuity";
import {
  replayHostCheckpoint,
  type HostCompactionHandoff,
} from "../../src/modules/chat/infra/client/host-compaction-codec";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

// These cases pin the OPERATION surviving a world that moves underneath it:
// a checkpoint write that fails mid-compaction, a retry after that failure,
// and two compactions entered for the same task at the same instant. Every
// assertion about durable state reads it back through a brand-new
// PrivateContextStore instance pointed at the same root directory, never the
// in-memory session object a still-running call happens to hold, because a
// process that actually restarted would have nothing else to read from.

const OWNER_ID = "owner-preview";
const PROVIDER_PROFILE_ID = "profile-isolated-next";
const THREAD_ID = "thread-context-operation-1";
const MODEL_ID = "farol-next/mind";

const binding: ContextBinding = {
  ownerId: OWNER_ID,
  taskId: THREAD_ID,
  hostThreadId: THREAD_ID,
  sessionId: THREAD_ID,
  providerProfileId: PROVIDER_PROFILE_ID,
  modelId: MODEL_ID,
  mode: "mind",
};

const checkpointContent: CheckpointContent = {
  goal: "Finish the exact Farol Next task without losing the epoch.",
  activeConstraints: ["Do not repeat an unknown write."],
  latestCorrections: ["Keep Watch Rail."],
  keyDecisions: ["Store the checkpoint before handoff."],
  completedWork: [
    {
      description: "One read completed.",
      evidenceRefs: ["receipt-read-operation-1"],
    },
  ],
  unfinishedWork: ["Continue after context replacement."],
  unresolvedQuestions: ["Whether write-17 completed."],
  unknownOutcomes: [
    { operationRef: "write-17", description: "Acknowledgement was lost." },
  ],
  artifactRefs: [{ reference: "vnext/README.md", availability: "available" }],
  attachmentRefs: [
    { reference: "attachment-owner-operation-1", availability: "unavailable" },
  ],
  nextSafeStep: "Observe write-17 before another mutation.",
};

function history() {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Never publish this task." }],
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Use the corrected workspace, operation edition.",
        },
      ],
    },
  ];
}

function unaryBody() {
  return { model: MODEL_ID, input: history() };
}

function metadata(turnId: string) {
  return JSON.stringify({ thread_id: THREAD_ID, turn_id: turnId });
}

type CompactInput = Parameters<CodexContextContinuity["compact"]>[0];
type PrepareTurnInput = Parameters<
  NonNullable<CodexContextContinuity["prepareTurn"]>
>[0];

function compactInput(turnId: string): CompactInput {
  return {
    endpoint: "responses_compact",
    body: unaryBody(),
    metadataHeader: metadata(turnId),
  };
}

function nextTurnInput(
  priorOutput: readonly unknown[],
  turnId: string,
): PrepareTurnInput {
  return {
    body: {
      model: MODEL_ID,
      stream: true,
      input: [
        ...priorOutput,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue after recovery." }],
        },
      ],
      tools: [],
      client_metadata: {
        session_id: THREAD_ID,
        thread_id: THREAD_ID,
        turn_id: turnId,
        root_turn_id: turnId,
      },
    },
  };
}

// Every handoff in these cases is the unary variant (a fresh thread with no
// prior streamed item), so this narrows once instead of re-deriving the
// check at every call site.
function unaryOutput(handoff: HostCompactionHandoff): readonly unknown[] {
  if (handoff.variant !== "unary_replacement_history") {
    throw new Error("EXPECTED_UNARY_HANDOFF");
  }
  return handoff.response.output;
}

type MockDriver = CodexContextSummaryDriver & {
  selectSource: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  retire: ReturnType<typeof vi.fn>;
};

function driver(): MockDriver {
  return {
    selectSource: vi.fn().mockResolvedValue("retained_agent"),
    request: vi.fn().mockResolvedValue({
      status: "completed",
      providerOperationId: "summary-provider-operation-1",
      sourceCursor: "summary-cursor-operation-1",
      content: checkpointContent,
    }),
    observe: vi.fn().mockResolvedValue({
      status: "completed",
      providerOperationId: "summary-provider-operation-1",
      sourceCursor: "summary-cursor-operation-1",
      content: checkpointContent,
    }),
    retire: vi.fn().mockResolvedValue({ status: "retired" }),
  };
}

function continuity(
  store: PrivateContextStore,
  summary: MockDriver,
): CodexContextContinuity {
  return new CodexContextContinuity({
    ownerId: OWNER_ID,
    providerProfileId: PROVIDER_PROFILE_ID,
    store,
    summary,
  });
}

// A store whose checkpoint write can be made to fail a fixed number of
// times, so the caller can simulate the durable checkpoint write failing
// (or the process dying before it lands) without touching the session
// persistence path at all. Every other method is the real implementation.
class FlakyCheckpointStore extends PrivateContextStore {
  failNextPuts = 0;

  override async put(checkpoint: CheckpointEnvelope): Promise<void> {
    if (this.failNextPuts > 0) {
      this.failNextPuts -= 1;
      throw new Error("SIMULATED_CHECKPOINT_WRITE_FAILURE");
    }
    return super.put(checkpoint);
  }
}

describe("context continuity operation resilience", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function stateRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-context-operation-"),
    );
    roots.push(root);
    return root;
  }

  it("leaves neither a durable checkpoint nor an advanced epoch when the checkpoint write fails part-way, and recovers the identical checkpoint from a fresh store on retry", async () => {
    const root = await stateRoot();
    const summary = driver();
    const flakyStore = new FlakyCheckpointStore({ root });
    flakyStore.failNextPuts = 1;
    const first = continuity(flakyStore, summary);
    const input = compactInput("turn-operation-compact-1");

    const interrupted = await first.compact(input);
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "FAROL_NEXT_COMPACTION_STATE_FAILED" },
    });
    expect(summary.request).toHaveBeenCalledTimes(1);

    // Inspect the torn point through a brand-new store instance: a real
    // restarted process would have nothing else to read.
    const tornSession = await new PrivateContextStore({ root }).load(binding);
    expect(tornSession).toMatchObject({ phase: "validated", epoch: 1 });
    const pendingCheckpointId = tornSession?.operation?.checkpointId ?? null;
    if (!pendingCheckpointId) {
      throw new Error("EXPECTED_PENDING_CHECKPOINT_ID");
    }
    await expect(
      new PrivateContextStore({ root }).get(binding, pendingCheckpointId),
    ).resolves.toBeNull();
    // Neither half of the transition happened: the session was never
    // advanced past "validated" and no checkpoint bytes exist. A torn
    // transition would show exactly one of these two facts, not neither.

    // Rebuild the store and the continuity object as a fresh process would,
    // then retry the identical request.
    const restartedStore = new PrivateContextStore({ root });
    const restarted = continuity(restartedStore, summary);
    const recovered = await restarted.compact(input);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.code);
    expect(recovered.value.variant).toBe("unary_replacement_history");
    const replayed = replayHostCheckpoint(
      unaryOutput(recovered.value),
      262_144,
    );
    if (!replayed.ok) throw new Error(replayed.error.code);
    expect(replayed.value.checkpoint.checkpointId).toBe(pendingCheckpointId);
    expect(replayed.value.checkpoint.content).toEqual(checkpointContent);

    const recoveredSession = await new PrivateContextStore({ root }).load(
      binding,
    );
    expect(recoveredSession).toMatchObject({
      phase: "handoff_offered",
      epoch: 1,
      operation: expect.objectContaining({ checkpointId: pendingCheckpointId }),
    });
    await expect(
      new PrivateContextStore({ root }).get(binding, pendingCheckpointId),
    ).resolves.toMatchObject({ checkpointId: pendingCheckpointId });

    // Recovery observed the already-dispatched summary; it did not resend it.
    expect(summary.request).toHaveBeenCalledTimes(1);
    expect(summary.observe.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("does not resubmit the summary or advance the epoch twice when the recovered compaction is retried again before the next turn confirms it", async () => {
    const root = await stateRoot();
    const summary = driver();
    const flakyStore = new FlakyCheckpointStore({ root });
    flakyStore.failNextPuts = 1;
    const input = compactInput("turn-operation-compact-2");

    const interrupted = await continuity(flakyStore, summary).compact(input);
    expect(interrupted.ok).toBe(false);

    const recovered = await continuity(
      new PrivateContextStore({ root }),
      summary,
    ).compact(input);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.code);
    const requestCallsAfterRecovery = summary.request.mock.calls.length;
    const observeCallsAfterRecovery = summary.observe.mock.calls.length;

    // A host retrying the exact same request again, from yet another fresh
    // process, before the next turn ever confirms the handoff.
    const repeated = await continuity(
      new PrivateContextStore({ root }),
      summary,
    ).compact(input);
    expect(repeated).toEqual(recovered);
    expect(summary.request.mock.calls.length).toBe(requestCallsAfterRecovery);
    expect(summary.observe.mock.calls.length).toBe(observeCallsAfterRecovery);

    const repeatedSession = await new PrivateContextStore({ root }).load(
      binding,
    );
    expect(repeatedSession).toMatchObject({
      phase: "handoff_offered",
      epoch: 1,
    });

    // Now the real next turn arrives carrying the checkpoint marker: this is
    // the one call allowed to retire the source and advance the epoch.
    const prepared = await continuity(
      new PrivateContextStore({ root }),
      summary,
    ).prepareTurn(
      nextTurnInput(unaryOutput(recovered.value), "turn-operation-next-1"),
    );
    expect(prepared.ok).toBe(true);

    const replayed = replayHostCheckpoint(
      unaryOutput(recovered.value),
      262_144,
    );
    if (!replayed.ok) throw new Error(replayed.error.code);
    const finalSession = await new PrivateContextStore({ root }).load(binding);
    expect(finalSession).toMatchObject({
      phase: "active",
      epoch: 2,
      lastCheckpointId: replayed.value.checkpoint.checkpointId,
      lastCompletedOperationId: replayed.value.checkpoint.operationId,
    });
    expect(summary.retire).toHaveBeenCalledTimes(1);

    // A duplicate "next turn" host call carrying the same marker again must
    // not retire or advance a second time.
    const preparedAgain = await continuity(
      new PrivateContextStore({ root }),
      summary,
    ).prepareTurn(
      nextTurnInput(unaryOutput(recovered.value), "turn-operation-next-2"),
    );
    expect(preparedAgain.ok).toBe(true);
    const finalSessionAgain = await new PrivateContextStore({ root }).load(
      binding,
    );
    expect(finalSessionAgain).toMatchObject({ phase: "active", epoch: 2 });
    expect(summary.retire).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("refuses one of two compactions entered for the same task at the same instant, and leaves only the winner's checkpoint durable", async () => {
    const root = await stateRoot();
    const summaryA = driver();
    const summaryB = driver();
    const continuityA = continuity(new PrivateContextStore({ root }), summaryA);
    const continuityB = continuity(new PrivateContextStore({ root }), summaryB);
    const input = compactInput("turn-operation-race-1");

    const [resultA, resultB] = await Promise.all([
      continuityA.compact(input),
      continuityB.compact(input),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((outcome) => outcome.ok);
    const refused = outcomes.filter((outcome) => !outcome.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      ok: false,
      error: { code: "FAROL_NEXT_COMPACTION_STATE_FAILED" },
    });

    // The loser was refused before it ever reached the summarizer: exactly
    // one submission total, across both independent driver mocks.
    const totalRequestCalls =
      summaryA.request.mock.calls.length + summaryB.request.mock.calls.length;
    expect(totalRequestCalls).toBe(1);

    const finalSession = await new PrivateContextStore({ root }).load(binding);
    expect(finalSession).toMatchObject({ phase: "handoff_offered", epoch: 1 });

    const winner = succeeded[0];
    if (!winner || !winner.ok) throw new Error("EXPECTED_ONE_WINNER");
    const replayed = replayHostCheckpoint(unaryOutput(winner.value), 262_144);
    if (!replayed.ok) throw new Error(replayed.error.code);
    await expect(
      new PrivateContextStore({ root }).get(
        binding,
        replayed.value.checkpoint.checkpointId,
      ),
    ).resolves.toMatchObject({
      checkpointId: replayed.value.checkpoint.checkpointId,
    });
  }, 30_000);
});

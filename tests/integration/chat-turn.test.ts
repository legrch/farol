import { describe, expect, it, vi } from "vitest";
import type { ActivityRecord } from "../../src/modules/chat/app/port/activity-recorder";
import type { ClientEvent } from "../../src/modules/chat/app/port/event-publisher";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderSession,
} from "../../src/modules/chat/app/port/provider";
import { RunTurn } from "../../src/modules/chat/app/service/run-turn";
import { InMemoryTurns } from "../../src/modules/chat/infra/repo/in-memory-turns";

class Barrier {
  private releasePromise: (() => void) | null = null;
  readonly promise = new Promise<void>((resolve) => {
    this.releasePromise = resolve;
  });

  release(): void {
    this.releasePromise?.();
  }
}

describe("the complete local Chat application slice", () => {
  it("delivers a real delta before terminal and resumes only the requesting Turn", async () => {
    const beforeTool = new Barrier();
    const beforeCompletion = new Barrier();
    const deltaObserved = new Barrier();
    const computerCompleted = new Barrier();
    const submitted = vi
      .fn<ProviderSession["submitComputerResult"]>()
      .mockResolvedValue({
        ok: true,
        value: undefined,
      });
    const session: ProviderSession = {
      async *events(): AsyncIterable<ProviderEvent> {
        yield { kind: "submit_activated" };
        yield { kind: "accepted" };
        yield {
          kind: "delta",
          sequence: 1,
          text: "Incremental fixture delta.",
        };
        await beforeTool.promise;
        yield {
          kind: "computer_call",
          callId: "call-a",
          operation: "inspect_fixture",
          target: "synthetic://workspace/status",
        };
        yield { kind: "delta", sequence: 2, text: " Tool result returned." };
        await beforeCompletion.promise;
        yield { kind: "completed" };
      },
      submitComputerResult: submitted,
    };
    const provider: ChatProvider = {
      prepare: vi.fn().mockResolvedValue(session),
    };
    const clientEvents: ClientEvent[] = [];
    const activity: ActivityRecord[] = [];
    const turns = new InMemoryTurns();
    const run = new RunTurn(
      provider,
      {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            ownerId: "owner-preview",
            sessionId: "session-a",
            taskId: "task-a",
            turnId: "turn-a",
            generation: 1,
            callId: "call-a",
            output: {
              kind: "synthetic-status",
              label: "Fixture workspace",
              state: "ready",
            },
          },
        }),
      },
      turns,
      {
        publish: async (event) => {
          clientEvents.push(event);
          if (event.kind === "text.delta" && event.sequence === 1)
            deltaObserved.release();
          if (event.kind === "computer.completed") computerCompleted.release();
        },
      },
      { record: async (record) => void activity.push(record) },
      { now: () => 1_000 },
    );

    const completion = run.execute({
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      turnId: "turn-a",
      generation: 1,
      prompt: "PROMPT_CANARY secret-token-canary /private/path",
    });
    await deltaObserved.promise;
    expect(clientEvents).toContainEqual(
      expect.objectContaining({ kind: "text.delta", sequence: 1 }),
    );
    expect(clientEvents.some((event) => event.kind === "turn.terminal")).toBe(
      false,
    );

    beforeTool.release();
    await computerCompleted.promise;
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 1,
        callId: "call-a",
      }),
    );
    expect(clientEvents.some((event) => event.kind === "turn.terminal")).toBe(
      false,
    );

    beforeCompletion.release();
    await expect(completion).resolves.toMatchObject({
      phase: "completed",
      terminal: true,
    });
    expect(clientEvents.at(-1)).toMatchObject({
      kind: "turn.terminal",
      phase: "completed",
    });
    const activityJson = JSON.stringify(activity);
    expect(activityJson).not.toContain("PROMPT_CANARY");
    expect(activityJson).not.toContain("secret-token-canary");
    expect(activityJson).not.toContain("/private/path");
    expect(activityJson).not.toContain("Incremental fixture delta");
  });

  it("makes a lost tool-result acknowledgement terminal and non-retryable", async () => {
    const session: ProviderSession = {
      async *events(): AsyncIterable<ProviderEvent> {
        yield { kind: "submit_activated" };
        yield { kind: "accepted" };
        yield { kind: "delta", sequence: 1, text: "Visible before tool." };
        yield {
          kind: "computer_call",
          callId: "call-a",
          operation: "inspect_fixture",
          target: "synthetic://workspace/status",
        };
      },
      submitComputerResult: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "PROVIDER_RESULT_REJECTED", retry: "never" },
      }),
    };
    const run = new RunTurn(
      { prepare: vi.fn().mockResolvedValue(session) },
      {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            ownerId: "owner-preview",
            sessionId: "session-a",
            taskId: "task-a",
            turnId: "turn-a",
            generation: 1,
            callId: "call-a",
            output: {
              kind: "synthetic-status",
              label: "Fixture",
              state: "ready",
            },
          },
        }),
      },
      new InMemoryTurns(),
      { publish: async () => undefined },
      { record: async () => undefined },
      { now: () => 1_000 },
    );
    await expect(
      run.execute({
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 1,
        prompt: "Synthetic",
      }),
    ).resolves.toMatchObject({ phase: "outcome_unknown", terminal: true });
  });
});

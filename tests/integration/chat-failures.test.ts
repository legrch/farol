import { describe, expect, it, vi } from "vitest";
import {
  failure,
  success,
  type Result,
} from "../../src/pkg/kernel/domain/result";
import type { ChatComputerOutput } from "../../src/modules/chat/app/port/computer-capability";
import type { ClientEvent } from "../../src/modules/chat/app/port/event-publisher";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderSession,
} from "../../src/modules/chat/app/port/provider";
import type { TurnRepository } from "../../src/modules/chat/app/port/turn-repository";
import { RunTurn } from "../../src/modules/chat/app/service/run-turn";
import { InMemoryTurns } from "../../src/modules/chat/infra/repo/in-memory-turns";

const command = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 1,
  prompt: "Synthetic failure fixture",
} as const;

function sessionFrom(
  events: () => AsyncIterable<ProviderEvent>,
): ProviderSession {
  return {
    events,
    submitComputerResult: vi.fn().mockResolvedValue(success(undefined)),
  };
}

const exactComputerResult: Result<ChatComputerOutput, string> = success({
  ownerId: command.ownerId,
  sessionId: command.sessionId,
  taskId: command.taskId,
  turnId: command.turnId,
  generation: command.generation,
  callId: "call-a",
  output: {
    kind: "synthetic-status" as const,
    label: "Fixture",
    state: "ready" as const,
  },
});

function harness(
  provider: ChatProvider,
  computerResult: Result<ChatComputerOutput, string> = exactComputerResult,
  turns: TurnRepository = new InMemoryTurns(),
) {
  const events: ClientEvent[] = [];
  const open = vi.spyOn(provider, "open");
  return {
    open,
    events,
    run: new RunTurn(
      provider,
      { execute: vi.fn().mockResolvedValue(computerResult) },
      turns,
      { publish: async (event) => void events.push(event) },
      { record: async () => undefined },
      { now: () => 1_000 },
    ),
  };
}

describe("Chat failure semantics", () => {
  it("classifies provider-open failure before dispatch without retry", async () => {
    const provider: ChatProvider = {
      open: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };
    const test = harness(provider);
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "provider_not_dispatched",
    });
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.events.at(-1)).toMatchObject({
      kind: "turn.terminal",
      phase: "failed",
    });
  });

  it("tombstones a stream that ends or throws after dispatch", async () => {
    const ended = harness({
      open: async () =>
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          yield { kind: "accepted" };
        }),
    });
    await expect(ended.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminalReason: "provider_stream_ended_without_terminal",
    });

    const thrown = harness({
      open: async () =>
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          throw new Error("connection lost");
        }),
    });
    await expect(thrown.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminalReason: "provider_outcome_unknown",
    });
  });

  it("fails a stream that ends before dispatch without forging a terminal prepared state", async () => {
    const test = harness({
      open: async () => sessionFrom(async function* () {}),
    });

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "provider_not_dispatched",
    });
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.events.at(-1)).toMatchObject({
      kind: "turn.terminal",
      phase: "failed",
      code: "provider_not_dispatched",
    });
  });

  it("turns invalid provider order and explicit provider failure into terminal failure", async () => {
    const invalid = harness({
      open: async () =>
        sessionFrom(async function* () {
          yield { kind: "accepted" };
        }),
    });
    await expect(invalid.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminalReason: "TURN_INVALID_TRANSITION",
    });

    const explicit = harness({
      open: async () =>
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          yield { kind: "accepted" };
          yield { kind: "failed", code: "PROVIDER_FIXTURE_FAILED" };
        }),
    });
    await expect(explicit.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminalReason: "PROVIDER_FIXTURE_FAILED",
    });
  });

  it("stops the exact turn when Computer refuses before result submission", async () => {
    const submitted = vi.fn<ProviderSession["submitComputerResult"]>();
    const test = harness(
      {
        open: async () => ({
          async *events() {
            yield { kind: "submit_activated" } as const;
            yield { kind: "accepted" } as const;
            yield { kind: "delta", sequence: 1, text: "Visible." } as const;
            yield {
              kind: "computer_call",
              callId: "call-a",
              operation: "inspect_fixture",
              target: "synthetic://workspace/status",
            } as const;
          },
          submitComputerResult: submitted,
        }),
      },
      failure("COMPUTER_FIXTURE_DENIED"),
    );
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminalReason: "COMPUTER_FIXTURE_DENIED",
    });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("does not dispatch when the initial Turn cannot be persisted", async () => {
    const provider: ChatProvider = {
      open: vi.fn().mockRejectedValue(new Error("must not dispatch")),
    };
    const turns: TurnRepository = {
      save: vi.fn().mockRejectedValue(new Error("persistence unavailable")),
      get: vi.fn().mockResolvedValue(null),
    };
    const test = harness(provider, exactComputerResult, turns);
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "local_persistence_failed_before_dispatch",
    });
    expect(test.open).not.toHaveBeenCalled();
  });

  it("returns outcome-unknown without replay when persistence fails after dispatch", async () => {
    const session = sessionFrom(async function* () {
      yield { kind: "submit_activated" };
      yield { kind: "accepted" };
    });
    const provider: ChatProvider = { open: vi.fn().mockResolvedValue(session) };
    let saves = 0;
    const turns: TurnRepository = {
      save: vi.fn().mockImplementation(async () => {
        saves += 1;
        if (saves > 1) throw new Error("persistence unavailable");
      }),
      get: vi.fn().mockResolvedValue(null),
    };
    const test = harness(provider, exactComputerResult, turns);
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminal: true,
      terminalReason: "provider_outcome_unknown",
    });
    expect(test.open).toHaveBeenCalledTimes(1);
  });
});

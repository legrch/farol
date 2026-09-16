import { describe, expect, it, vi } from "vitest";
import { success } from "../../src/pkg/kernel/domain/result";
import type { ChatComputerResult } from "../../src/modules/chat/app/port/computer-capability";
import type { ActivityRecord } from "../../src/modules/chat/app/port/activity-recorder";
import type { ClientEvent } from "../../src/modules/chat/app/port/event-publisher";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderSession,
} from "../../src/modules/chat/app/port/provider";
import type { TurnRepository } from "../../src/modules/chat/app/port/turn-repository";
import { RunTurn } from "../../src/modules/chat/app/service/run-turn";
import type { Turn } from "../../src/modules/chat/domain/turn";
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

const exactComputerResult: ChatComputerResult = success({
  ownerId: command.ownerId,
  sessionId: command.sessionId,
  taskId: command.taskId,
  taskEpoch: 0,
  participantId: "task-a:main",
  turnId: command.turnId,
  generation: command.generation,
  callId: "call-a",
  workspaceId: "preview-fixture",
  relativePath: "status.txt",
  operation: { kind: "workspace.read", relativePath: "status.txt" },
  output: {
    kind: "workspace.text" as const,
    text: "Fixture workspace is ready.\n",
    bytes: 28,
  },
});

function harness(
  provider: ChatProvider,
  computerResult: ChatComputerResult = exactComputerResult,
  turns: TurnRepository = new InMemoryTurns(),
) {
  const events: ClientEvent[] = [];
  const prepare = vi.spyOn(provider, "prepare");
  const execute = vi.fn().mockResolvedValue(computerResult);
  return {
    prepare,
    execute,
    events,
    run: new RunTurn(
      provider,
      { execute },
      turns,
      { publish: async (event) => void events.push(event) },
      { record: async () => undefined },
      { now: () => 1_000 },
    ),
  };
}

describe("Chat failure semantics", () => {
  it("keeps known provider completion when terminal client delivery fails", async () => {
    const saved: Turn[] = [];
    const turns: TurnRepository = {
      admit: async (turn) => ({ status: "admitted", turn }),
      save: async (turn) => void saved.push(turn),
      get: async () => null,
    };
    const provider: ChatProvider = {
      prepare: async () =>
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          yield { kind: "accepted" };
          yield { kind: "delta", sequence: 1, text: "Known response" };
          yield { kind: "completed" };
        }),
    };
    const run = new RunTurn(
      provider,
      { execute: vi.fn().mockResolvedValue(exactComputerResult) },
      turns,
      {
        publish: async (event) => {
          if (event.kind === "turn.terminal") {
            throw new Error("client disconnected");
          }
        },
      },
      {
        record: async (record) => {
          if (record.kind === "terminal") {
            throw new Error("activity unavailable");
          }
        },
      },
      { now: () => 1_000 },
    );

    await expect(run.execute(command)).resolves.toMatchObject({
      phase: "completed",
      terminal: true,
      terminalReason: "completed",
    });
    expect(saved.at(-1)).toMatchObject({
      phase: "completed",
      terminalReason: "completed",
    });
  });

  it("classifies provider-prepare failure before dispatch without retry", async () => {
    const provider: ChatProvider = {
      prepare: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };
    const test = harness(provider);
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "provider_not_dispatched",
    });
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.events.at(-1)).toMatchObject({
      kind: "turn.terminal",
      phase: "failed",
    });
  });

  it("tombstones a stream that ends or throws after dispatch", async () => {
    const ended = harness({
      prepare: async () =>
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
      prepare: async () =>
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
      prepare: async () => sessionFrom(async function* () {}),
    });

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "provider_not_dispatched",
    });
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.events.at(-1)).toMatchObject({
      kind: "turn.terminal",
      phase: "failed",
      code: "provider_not_dispatched",
    });
  });

  it("turns invalid provider order and explicit provider failure into terminal failure", async () => {
    const invalid = harness({
      prepare: async () =>
        sessionFrom(async function* () {
          yield { kind: "accepted" };
        }),
    });
    await expect(invalid.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminalReason: "TURN_INVALID_TRANSITION",
    });

    const explicit = harness({
      prepare: async () =>
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

  it("stops a Computer call rejected before provider dispatch", async () => {
    const submitted = vi
      .fn<ProviderSession["submitComputerResult"]>()
      .mockResolvedValue(success(undefined));
    const test = harness({
      prepare: async () => ({
        async *events() {
          yield {
            kind: "computer_call",
            callId: "call-a",
            workspaceId: "preview-fixture",
            operation: {
              kind: "workspace.read",
              relativePath: "status.txt",
            },
          } as const;
        },
        submitComputerResult: submitted,
      }),
    });

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "TURN_INVALID_TRANSITION",
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(
      test.events.filter(
        (event) =>
          event.kind === "computer.requested" ||
          event.kind === "computer.completed",
      ),
    ).toEqual([]);
  });

  it("stops a Computer call rejected after activation but before acceptance", async () => {
    const submitted = vi
      .fn<ProviderSession["submitComputerResult"]>()
      .mockResolvedValue(success(undefined));
    const test = harness({
      prepare: async () => ({
        async *events() {
          yield { kind: "submit_activated" } as const;
          yield {
            kind: "computer_call",
            callId: "call-a",
            workspaceId: "preview-fixture",
            operation: {
              kind: "workspace.read",
              relativePath: "status.txt",
            },
          } as const;
        },
        submitComputerResult: submitted,
      }),
    });

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminal: true,
      terminalReason: "TURN_INVALID_TRANSITION",
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(
      test.events.filter(
        (event) =>
          event.kind === "computer.requested" ||
          event.kind === "computer.completed",
      ),
    ).toEqual([]);
  });

  it("stops an empty Computer call identity at the application boundary", async () => {
    const submitted = vi
      .fn<ProviderSession["submitComputerResult"]>()
      .mockResolvedValue(success(undefined));
    const test = harness({
      prepare: async () => ({
        async *events() {
          yield { kind: "submit_activated" } as const;
          yield { kind: "accepted" } as const;
          yield {
            kind: "computer_call",
            callId: "",
            workspaceId: "preview-fixture",
            operation: {
              kind: "workspace.read",
              relativePath: "status.txt",
            },
          } as const;
        },
        submitComputerResult: submitted,
      }),
    });

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminal: true,
      terminalReason: "TURN_INVALID_TRANSITION",
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(
      test.events.filter(
        (event) =>
          event.kind === "computer.requested" ||
          event.kind === "computer.completed",
      ),
    ).toEqual([]);
  });

  it.each([
    ["repeated", 1],
    ["decreasing", 0],
  ])(
    "does not publish a %s delta after its transition is rejected",
    async (_case, invalidSequence) => {
      const test = harness({
        prepare: async () =>
          sessionFrom(async function* () {
            yield { kind: "submit_activated" };
            yield { kind: "accepted" };
            yield { kind: "delta", sequence: 1, text: "Accepted" };
            yield {
              kind: "delta",
              sequence: invalidSequence,
              text: "Rejected",
            };
          }),
      });

      await expect(test.run.execute(command)).resolves.toMatchObject({
        phase: "outcome_unknown",
        terminal: true,
        terminalReason: "TURN_SEQUENCE",
      });
      expect(
        test.events.filter((event) => event.kind === "text.delta"),
      ).toEqual([
        expect.objectContaining({
          kind: "text.delta",
          sequence: 1,
          text: "Accepted",
        }),
      ]);
      const terminalIndex = test.events.findIndex(
        (event) => event.kind === "turn.terminal",
      );
      expect(terminalIndex).toBeGreaterThan(-1);
      expect(
        test.events
          .slice(terminalIndex + 1)
          .filter((event) => event.kind === "text.delta"),
      ).toEqual([]);
    },
  );

  it("deduplicates one Computer round-trip for the same executing Turn", async () => {
    const submitted = vi
      .fn<ProviderSession["submitComputerResult"]>()
      .mockResolvedValue(success(undefined));
    const provider: ChatProvider = {
      prepare: vi.fn().mockImplementation(async () => ({
        async *events() {
          yield { kind: "submit_activated" } as const;
          yield { kind: "accepted" } as const;
          yield {
            kind: "computer_call",
            callId: "call-a",
            workspaceId: "preview-fixture",
            operation: {
              kind: "workspace.read",
              relativePath: "status.txt",
            },
          } as const;
          yield { kind: "delta", sequence: 1, text: "Only once" } as const;
          yield { kind: "completed" } as const;
        },
        submitComputerResult: submitted,
      })),
    };
    const test = harness(provider);

    const [first, duplicate] = await Promise.all([
      test.run.execute(command),
      test.run.execute(command),
    ]);

    expect(first).toEqual(duplicate);
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("fails the exact turn with the refusal source when Computer deterministically refuses", async () => {
    const submitted = vi.fn<ProviderSession["submitComputerResult"]>();
    const test = harness(
      {
        prepare: async () => ({
          async *events() {
            yield { kind: "submit_activated" } as const;
            yield { kind: "accepted" } as const;
            yield { kind: "delta", sequence: 1, text: "Visible." } as const;
            yield {
              kind: "computer_call",
              callId: "call-a",
              workspaceId: "preview-fixture",
              operation: {
                kind: "workspace.read",
                relativePath: "status.txt",
              },
            } as const;
          },
          submitComputerResult: submitted,
        }),
      },
      {
        ok: false,
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: "owner-restriction",
          classification: "refused",
          retry: "never",
        },
      },
    );
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminalReason: "owner-restriction:AUTHORITY_PATH_DENIED",
    });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("keeps an uncertain Computer transport result outcome-unknown without retry", async () => {
    const submitted = vi.fn<ProviderSession["submitComputerResult"]>();
    const test = harness(
      {
        prepare: async () => ({
          async *events() {
            yield { kind: "submit_activated" } as const;
            yield { kind: "accepted" } as const;
            yield {
              kind: "computer_call",
              callId: "call-a",
              workspaceId: "preview-fixture",
              operation: {
                kind: "workspace.read",
                relativePath: "status.txt",
              },
            } as const;
          },
          submitComputerResult: submitted,
        }),
      },
      {
        ok: false,
        error: {
          code: "COMPUTER_CONTRACT_UNAVAILABLE",
          source: "contract-transport",
          classification: "outcome_unknown",
          retry: "never",
        },
      },
    );

    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "outcome_unknown",
      terminalReason: "contract-transport:COMPUTER_CONTRACT_UNAVAILABLE",
    });
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("atomically admits one provider dispatch for a duplicate Turn identity", async () => {
    const provider: ChatProvider = {
      prepare: vi.fn().mockImplementation(async () =>
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          yield { kind: "accepted" };
          yield { kind: "delta", sequence: 1, text: "Only once" };
          yield { kind: "completed" };
        }),
      ),
    };
    const test = harness(provider);

    const [first, duplicate] = await Promise.all([
      test.run.execute(command),
      test.run.execute(command),
    ]);

    expect(first).toEqual(duplicate);
    expect(test.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the initial Turn cannot be persisted", async () => {
    const provider: ChatProvider = {
      prepare: vi.fn().mockRejectedValue(new Error("must not dispatch")),
    };
    const turns: TurnRepository = {
      admit: vi.fn().mockRejectedValue(new Error("persistence unavailable")),
      save: vi.fn().mockRejectedValue(new Error("persistence unavailable")),
      get: vi.fn().mockResolvedValue(null),
    };
    const test = harness(provider, exactComputerResult, turns);
    await expect(test.run.execute(command)).resolves.toMatchObject({
      phase: "failed",
      terminal: true,
      terminalReason: "local_persistence_failed_before_dispatch",
    });
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it("returns outcome-unknown without replay when persistence fails after dispatch", async () => {
    const session = sessionFrom(async function* () {
      yield { kind: "submit_activated" };
      yield { kind: "accepted" };
    });
    const provider: ChatProvider = {
      prepare: vi.fn().mockResolvedValue(session),
    };
    let saves = 0;
    const turns: TurnRepository = {
      admit: vi.fn().mockImplementation(async (turn: Turn) => ({
        status: "admitted" as const,
        turn,
      })),
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
    expect(test.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps a known completion when only terminal persistence fails", async () => {
    const activity: ActivityRecord[] = [];
    let persisted: Turn | null = null;
    const turns: TurnRepository = {
      admit: vi
        .fn()
        .mockImplementation(async (turn: Turn) =>
          persisted
            ? { status: "existing" as const, turn: persisted }
            : { status: "admitted" as const, turn },
        ),
      save: vi.fn().mockImplementation(async (turn: Turn) => {
        if (turn.phase === "completed") {
          throw new Error("terminal persistence unavailable");
        }
        persisted = turn;
      }),
      get: vi.fn().mockImplementation(async () => persisted),
    };
    const provider: ChatProvider = {
      prepare: vi.fn().mockResolvedValue(
        sessionFrom(async function* () {
          yield { kind: "submit_activated" };
          yield { kind: "accepted" };
          yield { kind: "delta", sequence: 1, text: "Known result" };
          yield { kind: "completed" };
        }),
      ),
    };
    const run = new RunTurn(
      provider,
      { execute: vi.fn().mockResolvedValue(exactComputerResult) },
      turns,
      { publish: async () => undefined },
      { record: async (record) => void activity.push(record) },
      { now: () => 1_000 },
    );

    await expect(run.execute(command)).resolves.toMatchObject({
      phase: "completed",
      terminal: true,
      terminalReason: "completed",
    });
    await expect(run.execute(command)).resolves.toMatchObject({
      phase: "completed",
      terminal: true,
      terminalReason: "completed",
    });
    expect(provider.prepare).toHaveBeenCalledTimes(1);
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: "terminal_persistence_failed",
        phase: "completed",
      }),
    );
    expect(activity).toContainEqual(
      expect.objectContaining({ kind: "terminal", phase: "completed" }),
    );
  });
});

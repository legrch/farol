import { describe, expect, it, vi } from "vitest";
import { ComputerService } from "../../src/modules/computer/app/service/computer-service";
import type { ComputerExecutor } from "../../src/modules/computer/app/port/computer-executor";
import { ComputerContractHandler } from "../../src/modules/computer/infra/contract-handler";
import { ComputerPeer } from "../../src/modules/chat/infra/peer/computer-peer";

describe("Chat -> Computer contract/peer", () => {
  it("maps a bounded call and returns the exact correlation unchanged", async () => {
    const execute = vi.fn<ComputerExecutor["execute"]>().mockResolvedValue({
      ok: true,
      value: {
        kind: "synthetic-status",
        label: "Fixture workspace",
        state: "ready",
      },
    });
    const handler = new ComputerContractHandler(
      new ComputerService(
        {
          ownerId: "owner-preview",
          sessionId: "session-a",
          taskId: "task-a",
          generation: 3,
          capability: "fixture.inspect",
          expiresAt: 2_000,
        },
        { execute },
        { now: () => 1_000 },
      ),
    );
    const peer = new ComputerPeer(handler);

    await expect(
      peer.execute({
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 3,
        callId: "call-a",
        operation: "inspect_fixture",
        target: "synthetic://workspace/status",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 3,
        callId: "call-a",
        output: {
          kind: "synthetic-status",
          label: "Fixture workspace",
          state: "ready",
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not call the executor for foreign authority", async () => {
    const execute = vi.fn<ComputerExecutor["execute"]>();
    const handler = new ComputerContractHandler(
      new ComputerService(
        {
          ownerId: "owner-preview",
          sessionId: "session-a",
          taskId: "task-a",
          generation: 3,
          capability: "fixture.inspect",
          expiresAt: 2_000,
        },
        { execute },
        { now: () => 1_000 },
      ),
    );

    const result = await new ComputerPeer(handler).execute({
      ownerId: "foreign",
      sessionId: "session-a",
      taskId: "task-a",
      turnId: "turn-a",
      generation: 3,
      callId: "call-a",
      operation: "inspect_fixture",
      target: "synthetic://workspace/status",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_OWNER_MISMATCH" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

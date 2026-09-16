import { describe, expect, it } from "vitest";

import type { ReadonlyComputerContract } from "../../src/modules/computer/contract/readonly-computer-contract";
import { ReadonlyComputerPeer } from "../../src/modules/chat/infra/peer/readonly-computer-peer";

const request = {
  ownerId: "owner-a",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 4,
  callId: "call-a",
  workspaceId: "workspace-a",
  operation: {
    kind: "workspace.read" as const,
    relativePath: "notes/status.txt",
  },
};

describe("read-only Computer chat peer", () => {
  it("adds trusted task and participant identity across the contract boundary", async () => {
    let received: unknown;
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        received = value;
        return {
          ok: true,
          value: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: 3,
            participantId: "critic-a",
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            output: {
              kind: "workspace.text",
              text: "ready\n",
              bytes: 6,
            },
          },
        };
      },
    };
    const peer = new ReadonlyComputerPeer(contract, {
      taskEpoch: 3,
      participantId: "critic-a",
    });

    await expect(peer.execute(request)).resolves.toMatchObject({
      ok: true,
      value: {
        participantId: "critic-a",
        output: { kind: "workspace.text", text: "ready\n" },
      },
    });
    expect(received).toEqual({
      ...request,
      taskEpoch: 3,
      participantId: "critic-a",
    });
  });

  it("rejects a response correlated to a different participant", async () => {
    const contract: ReadonlyComputerContract = {
      async execute() {
        return {
          ok: true,
          value: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: 3,
            participantId: "agent-other",
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            output: {
              kind: "workspace.text",
              text: "wrong\n",
              bytes: 6,
            },
          },
        };
      },
    };
    const peer = new ReadonlyComputerPeer(contract, {
      taskEpoch: 3,
      participantId: "critic-a",
    });

    await expect(peer.execute(request)).resolves.toEqual({
      ok: false,
      error: { code: "COMPUTER_CONTRACT_CORRELATION", retry: "never" },
    });
  });
});

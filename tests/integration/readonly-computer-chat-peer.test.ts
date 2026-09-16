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
      error: {
        code: "COMPUTER_CONTRACT_CORRELATION",
        source: "contract",
        classification: "refused",
        retry: "never",
      },
    });
  });

  it("preserves a correlated refusal source and rejects a foreign refusal", async () => {
    const correlated = {
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
    };
    const refusal = (participantId: string) =>
      ({
        ok: false,
        correlation: { ...correlated, participantId },
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: "owner-restriction",
          retry: "never",
        },
      }) as unknown as Awaited<ReturnType<ReadonlyComputerContract["execute"]>>;
    const valid = new ReadonlyComputerPeer(
      { execute: async () => refusal("critic-a") },
      { taskEpoch: 3, participantId: "critic-a" },
    );
    const foreign = new ReadonlyComputerPeer(
      { execute: async () => refusal("agent-other") },
      { taskEpoch: 3, participantId: "critic-a" },
    );

    await expect(valid.execute(request)).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        classification: "refused",
        retry: "never",
      },
    });
    await expect(foreign.execute(request)).resolves.toEqual({
      ok: false,
      error: {
        code: "COMPUTER_CONTRACT_CORRELATION",
        source: "contract",
        classification: "refused",
        retry: "never",
      },
    });
  });

  it("classifies a thrown Computer transport as outcome-unknown", async () => {
    const peer = new ReadonlyComputerPeer(
      {
        async execute() {
          throw new Error("transport lost");
        },
      },
      { taskEpoch: 3, participantId: "critic-a" },
    );

    await expect(peer.execute(request)).resolves.toEqual({
      ok: false,
      error: {
        code: "COMPUTER_CONTRACT_UNAVAILABLE",
        source: "contract-transport",
        classification: "outcome_unknown",
        retry: "never",
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import { DeferredGate } from "../../src/pkg/async/deferred-gate";
import { ScriptedProvider } from "../../src/modules/chat/infra/client/scripted-provider";

const request = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 1,
  prompt: "Synthetic",
} as const;

function output(ownerId: string = request.ownerId) {
  return {
    ownerId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    turnId: request.turnId,
    generation: request.generation,
    callId: "turn-a-computer-1",
    output: {
      kind: "synthetic-status" as const,
      label: "Fixture",
      state: "ready" as const,
    },
  };
}

describe("scripted preview provider", () => {
  it("publishes its explicit failure scenario", async () => {
    const completion = new DeferredGate("completion");
    const session = await new ScriptedProvider(
      "failure",
      { completion },
      false,
    ).prepare(request);
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.at(-1)).toEqual({
      kind: "failed",
      code: "FIXTURE_PROVIDER_FAILURE",
    });
  });

  it("fails when a Computer result is omitted", async () => {
    const session = await new ScriptedProvider(
      "normal",
      { completion: new DeferredGate("completion") },
      true,
    ).prepare(request);
    const iterator = session.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "computer_call" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: "failed", code: "FIXTURE_TOOL_RESULT_MISSING" },
    });
  });

  it("accepts one exact Computer result and rejects foreign or duplicate results", async () => {
    const completion = new DeferredGate("completion");
    completion.release();
    const session = await new ScriptedProvider(
      "normal",
      { completion },
      true,
    ).prepare(request);
    await expect(
      session.submitComputerResult(output("foreign-owner")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_RESULT_REJECTED" },
    });
    await expect(session.submitComputerResult(output())).resolves.toMatchObject(
      { ok: true },
    );
    await expect(session.submitComputerResult(output())).resolves.toMatchObject(
      {
        ok: false,
        error: { code: "PROVIDER_RESULT_REJECTED" },
      },
    );
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.at(-1)).toEqual({ kind: "completed" });
  });
});

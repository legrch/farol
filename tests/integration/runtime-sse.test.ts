import { afterEach, describe, expect, it } from "vitest";
import {
  startPreviewRuntime,
  type PreviewRuntime,
} from "../../src/boot/runtime-server";
import type { ClientEvent } from "../../src/modules/chat/app/port/event-publisher";

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private carry = "";
  readonly seen: { id: number; event: ClientEvent }[] = [];

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE_BODY_MISSING");
    this.reader = response.body.getReader();
  }

  async until(
    predicate: (event: ClientEvent) => boolean,
  ): Promise<ClientEvent[]> {
    const events: ClientEvent[] = [];
    while (true) {
      const part = await this.reader.read();
      if (part.done) throw new Error("SSE_ENDED_BEFORE_MATCH");
      this.carry += this.decoder.decode(part.value, { stream: true });
      const frames = this.carry.split("\n\n");
      this.carry = frames.pop() ?? "";
      for (const frame of frames) {
        const id = Number(
          frame
            .split("\n")
            .find((line) => line.startsWith("id: "))
            ?.slice(4),
        );
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data) as ClientEvent;
        if (!Number.isSafeInteger(id) || id < 1)
          throw new Error("SSE_EVENT_ID_INVALID");
        this.seen.push({ id, event });
        events.push(event);
        if (predicate(event)) return events;
      }
    }
  }
}

function taskHeaders(runtime: PreviewRuntime, taskId: string) {
  const task = runtime.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`TASK_MISSING:${taskId}`);
  return { authorization: `Bearer ${task.readToken}` };
}

function controlBody(
  runtime: PreviewRuntime,
  taskId: string,
  callId: string | null,
) {
  const task = runtime.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`TASK_MISSING:${taskId}`);
  return JSON.stringify({
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    taskId: task.taskId,
    turnId: task.turnId,
    generation: task.generation,
    callId,
  });
}

function deliveryBody(runtime: PreviewRuntime, taskId: string) {
  const task = runtime.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`TASK_MISSING:${taskId}`);
  return JSON.stringify({
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    taskId: task.taskId,
    turnId: task.turnId,
    generation: task.generation,
  });
}

describe("actual loopback SSE runtime", () => {
  let runtime: PreviewRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("starts the ordinary runtime without synthetic demo tasks", async () => {
    runtime = await startPreviewRuntime("normal");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };

    expect(runtime.tasks).toEqual([]);
    const manifest = await fetch(`${base}/manifest`, { headers });
    await expect(manifest.json()).resolves.toMatchObject({
      identity: "farol-runtime",
      mode: "empty",
      tasks: [],
    });
    const snapshot = await fetch(`${base}/snapshot`, { headers });
    await expect(snapshot.json()).resolves.toMatchObject({ tasks: [] });
  });

  it("streams before completion and correlates the fixture Computer round-trip", async () => {
    runtime = await startPreviewRuntime("normal", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };

    const unauthorized = await fetch(`${base}/manifest`);
    expect(unauthorized.status).toBe(401);
    const manifest = await fetch(`${base}/manifest`, { headers });
    await expect(manifest.json()).resolves.toMatchObject({
      identity: "farol-runtime",
      tasks: [{ taskId: "task-atlantic" }, { taskId: "task-harbor" }],
    });

    const response = await fetch(`${base}/events/task-atlantic`, {
      headers: taskHeaders(runtime, "task-atlantic"),
    });
    expect(response.status).toBe(200);
    const stream = new SseReader(response);
    const beforeTool = await stream.until(
      (event) =>
        event.kind === "computer.requested" &&
        event.callId === "turn-atlantic-1-computer-1",
    );
    expect(beforeTool).toContainEqual(
      expect.objectContaining({ kind: "text.delta", sequence: 1 }),
    );
    expect(beforeTool.some((event) => event.kind === "turn.terminal")).toBe(
      false,
    );
    const deliveredDelta = stream.seen.find(
      ({ event }) => event.kind === "text.delta" && event.sequence === 1,
    );
    expect(deliveredDelta).toBeDefined();
    const runningRuntime = runtime;
    const acknowledge = () =>
      fetch(`${base}/ack/task-atlantic/${deliveredDelta?.id}`, {
        method: "POST",
        headers: {
          ...taskHeaders(runningRuntime, "task-atlantic"),
          "content-type": "application/json",
        },
        body: deliveryBody(runningRuntime, "task-atlantic"),
      });
    expect((await acknowledge()).status).toBe(204);
    expect((await acknowledge()).status).toBe(204);
    expect(
      (
        await fetch(`${base}/ack/task-atlantic/${deliveredDelta?.id}`, {
          method: "POST",
          headers: {
            ...taskHeaders(runningRuntime, "task-harbor"),
            "content-type": "application/json",
          },
          body: deliveryBody(runningRuntime, "task-atlantic"),
        })
      ).status,
    ).toBe(401);

    const waiting = await fetch(`${base}/snapshot`, { headers });
    const waitingSnapshot = (await waiting.json()) as {
      tasks: { taskId: string; turn: { phase: string; deltaCount: number } }[];
    };
    expect(
      waitingSnapshot.tasks.find((task) => task.taskId === "task-atlantic"),
    ).toMatchObject({
      turn: { phase: "tool_wait", deltaCount: 1 },
    });

    expect(
      (
        await fetch(`${base}/control/task-atlantic/release-tool`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: controlBody(
            runtime,
            "task-atlantic",
            "turn-atlantic-1-computer-1",
          ),
        })
      ).status,
    ).toBe(204);
    const afterTool = await stream.until(
      (event) => event.kind === "text.delta" && event.sequence === 2,
    );
    expect(afterTool).toContainEqual(
      expect.objectContaining({
        kind: "computer.completed",
        taskId: "task-atlantic",
        sessionId: "session-atlantic",
        turnId: "turn-atlantic-1",
        generation: 1,
        callId: "turn-atlantic-1-computer-1",
      }),
    );
    expect(afterTool.some((event) => event.kind === "turn.terminal")).toBe(
      false,
    );

    expect(
      (
        await fetch(`${base}/control/task-atlantic/finish-demo`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: controlBody(runtime, "task-atlantic", null),
        })
      ).status,
    ).toBe(204);
    const terminal = await stream.until(
      (event) => event.kind === "turn.terminal",
    );
    expect(terminal.at(-1)).toMatchObject({
      taskId: "task-atlantic",
      kind: "turn.terminal",
      phase: "completed",
    });

    const snapshot = await fetch(`${base}/snapshot`, { headers });
    const safeJson = JSON.stringify(await snapshot.json());
    expect(
      (safeJson.match(/client_delivery_acknowledged/gu) ?? []).length,
    ).toBe(1);
    expect(safeJson).not.toContain(runtime.token);
    expect(safeJson).not.toContain("Synthetic local preview fixture");
    expect(safeJson).not.toContain("Checking the isolated fixture workspace");
    expect(safeJson).not.toContain("synthetic://workspace/status");
  });

  it("keeps the second task independent and makes controls one-shot", async () => {
    runtime = await startPreviewRuntime("normal", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };
    const response = await fetch(`${base}/events/task-harbor`, {
      headers: taskHeaders(runtime, "task-harbor"),
    });
    const stream = new SseReader(response);
    const running = await stream.until(
      (event) => event.kind === "text.delta" && event.sequence === 2,
    );
    expect(running.some((event) => event.kind === "turn.terminal")).toBe(false);

    const first = await fetch(`${base}/control/task-harbor/finish-demo`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: controlBody(runtime, "task-harbor", null),
    });
    const duplicate = await fetch(`${base}/control/task-harbor/finish-demo`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: controlBody(runtime, "task-harbor", null),
    });
    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(409);
    await expect(
      stream.until((event) => event.kind === "turn.terminal"),
    ).resolves.toContainEqual(
      expect.objectContaining({ taskId: "task-harbor", phase: "completed" }),
    );

    const snapshot = await fetch(`${base}/snapshot`, { headers });
    await expect(snapshot.json()).resolves.toMatchObject({
      tasks: [
        { taskId: "task-atlantic", turn: { phase: "tool_wait" } },
        { taskId: "task-harbor", turn: { phase: "completed" } },
      ],
    });
  });

  it("fails one task stream without stopping the other task or runtime", async () => {
    runtime = await startPreviewRuntime("stream-failure", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = await fetch(`${base}/snapshot`, { headers });
      const body = (await snapshot.json()) as {
        tasks: { taskId: string; turn: { phase: string } | null }[];
      };
      if (
        body.tasks.find((task) => task.taskId === "task-atlantic")?.turn
          ?.phase === "tool_wait"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const failedStream = await fetch(`${base}/events/task-atlantic`, {
      headers: taskHeaders(runtime, "task-atlantic"),
    });
    expect(failedStream.status).toBe(409);
    await expect(failedStream.json()).resolves.toEqual({
      error: "PREVIEW_STREAM_FAULT",
    });

    const survivingResponse = await fetch(`${base}/events/task-harbor`, {
      headers: taskHeaders(runtime, "task-harbor"),
    });
    expect(survivingResponse.status).toBe(200);
    const surviving = new SseReader(survivingResponse);
    await surviving.until(
      (event) => event.kind === "text.delta" && event.sequence === 2,
    );
    const released = await fetch(`${base}/control/task-harbor/finish-demo`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: controlBody(runtime, "task-harbor", null),
    });
    expect(released.status).toBe(204);
    await expect(
      surviving.until((event) => event.kind === "turn.terminal"),
    ).resolves.toContainEqual(
      expect.objectContaining({ taskId: "task-harbor", phase: "completed" }),
    );

    const snapshot = await fetch(`${base}/snapshot`, { headers });
    await expect(snapshot.json()).resolves.toMatchObject({
      identity: "farol-runtime",
      tasks: [
        { taskId: "task-atlantic", turn: { phase: "tool_wait" } },
        { taskId: "task-harbor", turn: { phase: "completed" } },
      ],
    });
  });

  it("does not let one task read or control another task", async () => {
    runtime = await startPreviewRuntime("normal", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const taskAHeaders = taskHeaders(runtime, "task-atlantic");

    const foreignRead = await fetch(`${base}/events/task-harbor`, {
      headers: taskAHeaders,
    });
    expect(foreignRead.status).toBe(401);

    const foreignControl = await fetch(
      `${base}/control/task-harbor/finish-demo`,
      { method: "POST", headers: taskAHeaders },
    );
    expect(foreignControl.status).toBe(401);

    const taskPage = await fetch(`${base}/task/task-atlantic`, {
      headers: taskAHeaders,
    });
    expect(await taskPage.text()).not.toContain(runtime.token);
  });

  it("rejects a stale or incomplete Computer approval correlation", async () => {
    runtime = await startPreviewRuntime("normal", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    };
    const response = await fetch(`${base}/control/task-atlantic/release-tool`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: "task-atlantic" }),
    });
    expect(response.status).toBe(409);
  });

  it("cancels pending work during shutdown without converting it to approval", async () => {
    runtime = await startPreviewRuntime("normal", "demo");
    const base = `http://127.0.0.1:${runtime.port}`;
    const response = await fetch(`${base}/events/task-atlantic`, {
      headers: taskHeaders(runtime, "task-atlantic"),
    });
    const stream = new SseReader(response);
    await stream.until((event) => event.kind === "computer.requested");

    const receipt = await runtime.close();
    runtime = null;

    expect(receipt.tasks).toEqual([
      {
        taskId: "task-atlantic",
        phase: "failed",
        terminal: true,
      },
      { taskId: "task-harbor", phase: "outcome_unknown", terminal: true },
    ]);
    expect(receipt.activityKinds).not.toContain("computer_completed");
  });
});

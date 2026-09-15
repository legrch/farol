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
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data) as ClientEvent;
        events.push(event);
        if (predicate(event)) return events;
      }
    }
  }
}

describe("actual loopback SSE runtime", () => {
  let runtime: PreviewRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("streams before completion and correlates the fixture Computer round-trip", async () => {
    runtime = await startPreviewRuntime("normal");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };

    const unauthorized = await fetch(`${base}/manifest`);
    expect(unauthorized.status).toBe(401);
    const manifest = await fetch(`${base}/manifest`, { headers });
    await expect(manifest.json()).resolves.toMatchObject({
      identity: "farol-next-preview-runtime",
      tasks: [{ taskId: "task-atlantic" }, { taskId: "task-harbor" }],
    });

    const response = await fetch(`${base}/events/task-atlantic`, { headers });
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
          headers,
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
        await fetch(`${base}/control/task-atlantic/release-completion`, {
          method: "POST",
          headers,
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
    expect(safeJson).not.toContain(runtime.token);
    expect(safeJson).not.toContain("Synthetic local preview fixture");
    expect(safeJson).not.toContain("Checking the isolated fixture workspace");
    expect(safeJson).not.toContain("synthetic://workspace/status");
  });

  it("keeps the second task independent and makes controls one-shot", async () => {
    runtime = await startPreviewRuntime("normal");
    const base = `http://127.0.0.1:${runtime.port}`;
    const headers = { authorization: `Bearer ${runtime.token}` };
    const response = await fetch(`${base}/events/task-harbor`, { headers });
    const stream = new SseReader(response);
    const running = await stream.until(
      (event) => event.kind === "text.delta" && event.sequence === 2,
    );
    expect(running.some((event) => event.kind === "turn.terminal")).toBe(false);

    const first = await fetch(
      `${base}/control/task-harbor/release-completion`,
      {
        method: "POST",
        headers,
      },
    );
    const duplicate = await fetch(
      `${base}/control/task-harbor/release-completion`,
      {
        method: "POST",
        headers,
      },
    );
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
});

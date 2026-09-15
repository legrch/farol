import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredGate } from "../../src/pkg/async/deferred-gate";
import { EventStream } from "../../src/pkg/sse/event-stream";

class ResponseProbe extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly writes: string[] = [];
  status = 0;
  backpressure = false;
  drainOnBackpressure = true;

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  write(value: string): boolean {
    this.writes.push(value);
    if (!this.backpressure) return true;
    this.backpressure = false;
    if (this.drainOnBackpressure) queueMicrotask(() => this.emit("drain"));
    return false;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe("shared runtime mechanisms", () => {
  afterEach(() => vi.useRealTimers());

  it("releases a deferred gate exactly once", async () => {
    const gate = new DeferredGate("fixture");
    expect(gate.isReleased()).toBe(false);
    const waiting = gate.wait();
    expect(gate.release()).toBe(true);
    await waiting;
    expect(gate.isReleased()).toBe(true);
    expect(gate.release()).toBe(false);
  });

  it("rejects invalid stream capacities and retains a bounded clone", async () => {
    expect(() => new EventStream(0)).toThrow("EVENT_STREAM_CAPACITY_INVALID");
    expect(() => new EventStream(1.5)).toThrow("EVENT_STREAM_CAPACITY_INVALID");
    const stream = new EventStream<{ taskId: string; sequence: number }>(2);
    await stream.publish({ taskId: "task-a", sequence: 1 });
    await stream.publish({ taskId: "task-a", sequence: 2 });
    await stream.publish({ taskId: "task-a", sequence: 3 });
    expect(stream.retained("task-a")).toEqual([
      { id: 2, event: { taskId: "task-a", sequence: 2 } },
      { id: 3, event: { taskId: "task-a", sequence: 3 } },
    ]);
    expect(stream.retained("task-b")).toEqual([]);
  });

  it("replays retained frames, honors backpressure, and removes closed subscribers", async () => {
    const stream = new EventStream<{ taskId: string; sequence: number }>();
    await stream.publish({ taskId: "task-a", sequence: 1 });
    const response = new ResponseProbe();
    const unsubscribe = stream.subscribe("task-a", response.asServerResponse());
    expect(response.status).toBe(200);
    expect(response.writes.join("")).toContain('"sequence":1');

    response.backpressure = true;
    await stream.publish({ taskId: "task-a", sequence: 2 });
    expect(response.writes.join("")).toContain('"sequence":2');

    const writesBeforeClose = response.writes.length;
    unsubscribe();
    await stream.publish({ taskId: "task-a", sequence: 3 });
    expect(response.writes).toHaveLength(writesBeforeClose);

    const active = new ResponseProbe();
    stream.subscribe("task-b", active.asServerResponse());
    stream.close();
    expect(active.writableEnded).toBe(true);
  });

  it("does not write to destroyed subscribers", async () => {
    const stream = new EventStream<{ taskId: string; sequence: number }>();
    const response = new ResponseProbe();
    stream.subscribe("task-a", response.asServerResponse());
    response.destroyed = true;
    const writesBeforePublish = response.writes.length;
    await stream.publish({ taskId: "task-a", sequence: 1 });
    expect(response.writes).toHaveLength(writesBeforePublish);
  });

  it("evicts a subscriber that never drains within the bounded wait", async () => {
    vi.useFakeTimers();
    const stream = new EventStream<{ taskId: string; sequence: number }>(
      128,
      5,
    );
    const response = new ResponseProbe();
    response.backpressure = true;
    response.drainOnBackpressure = false;
    stream.subscribe("task-a", response.asServerResponse());

    const result = Promise.race([
      stream.publish({ taskId: "task-a", sequence: 1 }).then(() => "published"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 6)),
    ]);
    await vi.advanceTimersByTimeAsync(6);

    await expect(result).resolves.toBe("published");
    expect(response.destroyed).toBe(true);
  });
});

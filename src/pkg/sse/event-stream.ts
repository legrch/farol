import type { ServerResponse } from "node:http";

type TaskEvent = Readonly<{ taskId: string }>;
type RetainedEvent<Event extends TaskEvent> = Readonly<{
  id: number;
  event: Event;
}>;
const noop = () => undefined;

export class EventStream<Event extends TaskEvent> {
  private readonly history = new Map<string, RetainedEvent<Event>[]>();
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private nextId = 1;

  constructor(
    private readonly capacity = 128,
    private readonly drainTimeoutMs = 250,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("EVENT_STREAM_CAPACITY_INVALID");
    }
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
      throw new Error("EVENT_STREAM_DRAIN_TIMEOUT_INVALID");
    }
  }

  async publish(event: Event): Promise<void> {
    const retained = { id: this.nextId++, event: structuredClone(event) };
    const history = this.history.get(event.taskId) ?? [];
    history.push(retained);
    if (history.length > this.capacity) history.shift();
    this.history.set(event.taskId, history);

    const subscribers = this.subscribers.get(event.taskId);
    const writes = await Promise.all(
      [...(subscribers ?? [])].map(async (response) => ({
        response,
        keep: await this.write(response, retained),
      })),
    );
    for (const result of writes) {
      if (result.keep) continue;
      subscribers?.delete(result.response);
      if (!result.response.destroyed) result.response.destroy();
    }
    if (subscribers?.size === 0) this.subscribers.delete(event.taskId);
  }

  subscribe(taskId: string, response: ServerResponse): () => void {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    if (!response.write(": farol-next\n\n")) {
      response.destroy();
      return noop;
    }
    for (const retained of this.history.get(taskId) ?? []) {
      if (!response.write(this.encode(retained))) {
        response.destroy();
        return noop;
      }
    }
    const subscribers =
      this.subscribers.get(taskId) ?? new Set<ServerResponse>();
    subscribers.add(response);
    this.subscribers.set(taskId, subscribers);
    const close = () => {
      subscribers.delete(response);
      if (subscribers.size === 0) this.subscribers.delete(taskId);
    };
    response.on("close", close);
    return close;
  }

  retained(taskId: string): readonly RetainedEvent<Event>[] {
    return structuredClone(this.history.get(taskId) ?? []);
  }

  close(): void {
    for (const responses of this.subscribers.values()) {
      for (const response of responses) response.end();
    }
    this.subscribers.clear();
  }

  private encode(retained: RetainedEvent<Event>): string {
    return `id: ${retained.id}\ndata: ${JSON.stringify(retained.event)}\n\n`;
  }

  private async write(
    response: ServerResponse,
    retained: RetainedEvent<Event>,
  ): Promise<boolean> {
    if (response.destroyed || response.writableEnded) return false;
    if (response.write(this.encode(retained))) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (keep: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response.removeListener("drain", drained);
        response.removeListener("close", closed);
        resolve(keep);
      };
      const drained = () => finish(true);
      const closed = () => finish(false);
      const timer = setTimeout(() => finish(false), this.drainTimeoutMs);
      timer.unref();
      response.once("drain", drained);
      response.once("close", closed);
    });
  }
}

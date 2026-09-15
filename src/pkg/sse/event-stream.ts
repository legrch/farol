import { once } from "node:events";
import type { ServerResponse } from "node:http";

type TaskEvent = Readonly<{ taskId: string }>;
type RetainedEvent<Event extends TaskEvent> = Readonly<{
  id: number;
  event: Event;
}>;

export class EventStream<Event extends TaskEvent> {
  private readonly history = new Map<string, RetainedEvent<Event>[]>();
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private nextId = 1;

  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("EVENT_STREAM_CAPACITY_INVALID");
    }
  }

  async publish(event: Event): Promise<void> {
    const retained = { id: this.nextId++, event: structuredClone(event) };
    const history = this.history.get(event.taskId) ?? [];
    history.push(retained);
    if (history.length > this.capacity) history.shift();
    this.history.set(event.taskId, history);

    const writes = [...(this.subscribers.get(event.taskId) ?? [])].map(
      (response) => this.write(response, retained),
    );
    await Promise.all(writes);
  }

  subscribe(taskId: string, response: ServerResponse): () => void {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": farol-next\n\n");
    for (const retained of this.history.get(taskId) ?? []) {
      response.write(this.encode(retained));
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
  ): Promise<void> {
    if (response.destroyed || response.writableEnded) return;
    if (response.write(this.encode(retained))) return;
    await Promise.race([once(response, "drain"), once(response, "close")]);
  }
}

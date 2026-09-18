import type { ClientEventDto } from "../modules/chat/contract/client-event";

// What Activity keeps of one client event: the links that explain it (task,
// turn, generation, Computer call, operation, terminal code), never the
// owner or session identity and never text.
export type SafeActivity = Readonly<{
  taskId: string;
  turnId: string;
  generation: number;
  kind: string;
  phase: string;
  sequence: number | null;
  callId: string | null;
  operation: string | null;
  code: string | null;
  at: number;
  // Stream records of one turn fold into one: how many they stand for.
  coalesced: number;
}>;

export const ACTIVITY_RETAINED_RECORDS = 256;

const STREAM_KINDS = new Set(["text.delta", "client.delivery_acknowledged"]);

export function projectActivity(event: ClientEventDto): SafeActivity | null {
  // Acknowledgements of anything but text and terminals carry no news.
  if (
    event.kind === "client.delivery_acknowledged" &&
    !["text.delta", "turn.terminal"].includes(event.deliveredKind)
  ) {
    return null;
  }
  return {
    taskId: event.taskId,
    turnId: event.turnId,
    generation: event.generation,
    kind: event.kind,
    phase: "phase" in event ? event.phase : event.kind,
    sequence:
      event.kind === "text.delta" ||
      event.kind === "client.delivery_acknowledged"
        ? event.sequence
        : null,
    callId:
      event.kind === "computer.requested" || event.kind === "computer.completed"
        ? event.callId
        : null,
    operation: event.kind === "computer.requested" ? event.operation : null,
    code: event.kind === "turn.terminal" ? event.code : null,
    at: event.at,
    coalesced: 1,
  };
}

/**
 * Bounded Activity. Stream noise is folded before anything is evicted: the
 * next stream record of the same task, turn and kind replaces the previous
 * one and counts it. When the bound is still exceeded, the oldest stream
 * record goes first; a lifecycle record goes only when no stream record is
 * left. Every record dropped is counted, so the view can say so.
 */
export class ActivityLog {
  private readonly records: SafeActivity[] = [];
  private omittedRecords = 0;

  constructor(private readonly limit = ACTIVITY_RETAINED_RECORDS) {}

  record(entry: SafeActivity): void {
    if (STREAM_KINDS.has(entry.kind)) {
      for (let index = this.records.length - 1; index >= 0; index -= 1) {
        const previous = this.records[index]!;
        if (
          previous.kind === entry.kind &&
          previous.taskId === entry.taskId &&
          previous.turnId === entry.turnId &&
          previous.generation === entry.generation
        ) {
          this.records.splice(index, 1);
          this.records.push({
            ...entry,
            coalesced: previous.coalesced + entry.coalesced,
          });
          return;
        }
        if (previous.taskId === entry.taskId) break;
      }
    }
    this.records.push(entry);
    while (this.records.length > this.limit) {
      const stream = this.records.findIndex((record) =>
        STREAM_KINDS.has(record.kind),
      );
      this.records.splice(stream >= 0 ? stream : 0, 1);
      this.omittedRecords += 1;
    }
  }

  entries(): readonly SafeActivity[] {
    return this.records;
  }

  omitted(): number {
    return this.omittedRecords;
  }
}

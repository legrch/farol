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

const SETUP_CHECK_STORAGE_KEY = "farol.next.setup-check-history.v1";
const SETUP_CHECK_HISTORY_LIMIT = 64;
export type SetupCheckOperation =
  "connector.check-health" | "connector.verify-app";
export type SetupCheckPhase =
  "running" | "completed" | "failed" | "outcome_unknown";

function isSetupCheckRecord(value: unknown): value is SafeActivity {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SafeActivity>;
  return (
    record.taskId === "setup" &&
    record.kind === "setup.check" &&
    typeof record.turnId === "string" &&
    /^\d{1,16}-\d{1,5}$/u.test(record.turnId) &&
    record.generation === 0 &&
    ["running", "completed", "failed", "outcome_unknown"].includes(
      record.phase ?? "",
    ) &&
    record.sequence === null &&
    record.callId === null &&
    ["connector.check-health", "connector.verify-app"].includes(
      record.operation ?? "",
    ) &&
    (record.code === null ||
      (typeof record.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/u.test(record.code))) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    record.at > 0 &&
    record.coalesced === 1
  );
}

/** Content-free setup attempts, retained across app restarts in the Dev profile. */
export class SetupCheckHistory {
  private readonly records: SafeActivity[];
  private nextId = 0;

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {
    let loaded: unknown = null;
    try {
      loaded = JSON.parse(storage.getItem(SETUP_CHECK_STORAGE_KEY) ?? "null");
    } catch {
      // An unavailable or damaged store must not block Setup.
    }
    this.records = Array.isArray(loaded)
      ? loaded.filter(isSetupCheckRecord).slice(-SETUP_CHECK_HISTORY_LIMIT)
      : [];
  }

  start(operation: SetupCheckOperation): string {
    const runId = `${Date.now()}-${++this.nextId}`;
    this.record(operation, "running", runId);
    return runId;
  }

  record(
    operation: SetupCheckOperation,
    phase: SetupCheckPhase,
    runId: string,
    code: string | null = null,
  ): SafeActivity {
    const entry: SafeActivity = {
      taskId: "setup",
      turnId: runId,
      generation: 0,
      kind: "setup.check",
      phase,
      sequence: null,
      callId: null,
      operation,
      code: code && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : null,
      at: Date.now(),
      coalesced: 1,
    };
    this.records.push(entry);
    if (this.records.length > SETUP_CHECK_HISTORY_LIMIT)
      this.records.splice(0, this.records.length - SETUP_CHECK_HISTORY_LIMIT);
    try {
      this.storage.setItem(
        SETUP_CHECK_STORAGE_KEY,
        JSON.stringify(this.records),
      );
    } catch {
      // Keep the current session's evidence even if persistence is unavailable.
    }
    return entry;
  }

  entries(): readonly SafeActivity[] {
    return this.records;
  }
}

import type { Context, EventData } from "./wire.ts";

export type EventAdmission =
  | Readonly<{ admitted: true; stale: boolean }>
  | Readonly<{
      admitted: false;
      code:
        | "stale_event_context"
        | "event_stream_budget"
        | "event_sequence_regression";
    }>;

// Per-stream event ordering for one connection. A stream becomes stale on its
// first gap, either an explicit gap event or a skipped sequence, and stays
// stale. A regression or replay is never admitted and records nothing.
export function createSequencer(maxStreams = 64): {
  admit(event: EventData, context: Context | undefined): EventAdmission;
} {
  const sequences = new Map<string, bigint>();
  const stale = new Set<string>();
  return {
    admit(event, context) {
      if (
        !context ||
        event.context.profileId !== context.profileId ||
        event.context.backendGeneration !== context.backendGeneration
      )
        return { admitted: false, code: "stale_event_context" };
      if (!sequences.has(event.stream) && sequences.size >= maxStreams)
        return { admitted: false, code: "event_stream_budget" };
      const previous = sequences.get(event.stream) ?? 0n;
      const sequence = BigInt(event.sequence);
      if (sequence <= previous)
        return { admitted: false, code: "event_sequence_regression" };
      if (sequence !== previous + 1n || event.kind === "gap")
        stale.add(event.stream);
      sequences.set(event.stream, sequence);
      return { admitted: true, stale: stale.has(event.stream) };
    },
  };
}

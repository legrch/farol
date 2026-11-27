import type { z } from "zod";
import type { OperationsSnapshotSchema } from "../../../apps/desktop/renderer/operations-contract";
import type { ClientEventSchema } from "../../modules/chat/contract/client-event";
import type { ActivityEntry, WindowSnapshot } from "./contract";
import { displayCode } from "./outcome";

type Operations = z.infer<typeof OperationsSnapshotSchema>;
type ClientEvent = z.infer<typeof ClientEventSchema>;

/** The activity list and diagnostics projected from one operations snapshot. */
export function operationsPatch(result: Operations): Partial<WindowSnapshot> {
  return {
    connectionChecking: result.connectionChecking === true,
    activity: result.entries.map((entry) => ({
      ...entry,
      ...(entry.lifecycle?.phase === "started" &&
      result.activeLifecycleIds?.includes(entry.lifecycle.id)
        ? { inFlight: true as const }
        : {}),
      taskId: "",
      turnId: "",
      generation: 0,
      label:
        entry.code === "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN"
          ? "Interrupted command: outcome unknown"
          : entry.kind.replaceAll("_", " ").replaceAll(".", " "),
      phase: entry.outcome === "unknown" ? "outcome_unknown" : entry.outcome,
      operation:
        [
          entry.target.workspace,
          entry.target.relativePath,
          entry.target.command,
          entry.target.handle
            ? `Handle ${entry.target.handle}${entry.target.start === "unknown" ? " (start unknown)" : ""}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || null,
    })),
    activityDiagnostics: {
      readPending: result.readPending === true,
      corruptLines: result.corruptLines,
      writeFailures: result.writeFailures,
      droppedEntries: result.droppedEntries,
      unrecordedUncertainEntries: result.unrecordedUncertainEntries,
      unmappedCodes: result.unmappedCodes,
      rejectedMetadata: result.rejectedMetadata,
    },
  };
}

/** The diagnostic recorded when an operations read fails. */
export function operationsReadFailure(): Partial<WindowSnapshot> {
  return { activityDiagnostics: { corruptLines: 0, writeFailures: 1 } };
}

/** One activity-history entry for a runtime event; `ordinal` makes it unique. */
export function eventEntry(
  event: ClientEvent,
  label: string | undefined,
  ordinal: number,
): ActivityEntry {
  return {
    id: `${event.taskId}:${event.turnId}:${event.generation}:${ordinal}`,
    taskId: event.taskId,
    turnId: event.turnId,
    generation: event.generation,
    label: label ?? "Task",
    kind: event.kind,
    at: event.at,
    phase: "phase" in event ? event.phase : null,
    operation: "operation" in event ? event.operation : null,
    code: "code" in event ? displayCode(event.code) : null,
  };
}

/** Live activity keeps only the newest 256 entries. */
export function appendActivity(
  activity: readonly ActivityEntry[],
  entry: ActivityEntry,
): ActivityEntry[] {
  return [...activity, entry].slice(-256);
}

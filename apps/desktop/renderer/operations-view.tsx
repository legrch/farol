import { useActivityNotifications } from "./activity-notifications";
import { useState } from "react";
import { operationSources, operationOutcomes } from "./operations-contract";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

export function OperationsActivity({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const notifications = useActivityNotifications(snapshot);
  const unreadIds = new Set(
    notifications.unread
      .filter((row) => row.id.startsWith("operation:"))
      .map((row) => row.id.slice(10)),
  );
  const [source, setSource] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [query, setQuery] = useState("");
  const rows = [...snapshot.activity]
    .sort((a, b) => b.at - a.at)
    .filter(
      (row) =>
        (source === "all" || row.source === source) &&
        (outcome === "all" ||
          (outcome === "unread"
            ? unreadIds.has(row.id)
            : outcome === "attention"
              ? row.outcome === "unknown" || row.outcome === "pending"
              : row.outcome === outcome)) &&
        [
          row.kind,
          row.source,
          row.outcome,
          row.operation,
          row.code,
          row.target?.workspace,
          row.target?.relativePath,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const diagnostics = snapshot.activityDiagnostics;
  return (
    <section className="operations-activity" aria-label="Operations log">
      <p className="description">
        What Farol did, with recorded outcomes. Metadata is kept for up to 30
        days within the storage limit.
      </p>
      <div className="operations-filters">
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All sources</option>
            {operationSources.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="all">All outcomes</option>
            <option value="attention">Unconfirmed results</option>
            <option value="unread">Unread notifications</option>
            {operationOutcomes.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Search activity
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Operation, workspace or code"
          />
        </label>
      </div>
      {notifications.error && <p role="status">{notifications.error}</p>}
      {diagnostics?.readPending && (
        <p role="status">
          Updating activity… Recent events may not appear yet.
        </p>
      )}
      {diagnostics &&
      (diagnostics.corruptLines > 0 ||
        diagnostics.writeFailures > 0 ||
        (diagnostics.droppedEntries ?? 0) > 0 ||
        (diagnostics.unmappedCodes ?? 0) > 0) ? (
        <p role="status">
          {diagnostics.corruptLines > 0 &&
            `${diagnostics.corruptLines} unreadable log lines skipped. `}
          {diagnostics.writeFailures > 0 &&
            `${diagnostics.writeFailures} log reads or writes unavailable. `}
          {(diagnostics.droppedEntries ?? 0) > 0 &&
            `${diagnostics.droppedEntries} entries were not recorded. `}
          {(diagnostics.unrecordedUncertainEntries ?? 0) > 0 &&
            `${diagnostics.unrecordedUncertainEntries} of these had pending or unknown outcomes. `}
          {(diagnostics.unmappedCodes ?? 0) > 0 &&
            `${diagnostics.unmappedCodes} unmapped result codes were recorded as unknown. `}
          Do not repeat unconfirmed actions.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p role="status">No matching activity.</p>
      ) : (
        rows.map((row) => (
          <details
            className="operation-row"
            key={row.id}
            open={snapshot.destination.activityId === row.id || undefined}
          >
            <summary>
              <span>
                <strong>{row.label}</strong>
                <small>
                  <time dateTime={new Date(row.at).toISOString()}>
                    {new Date(row.at).toLocaleString()}
                  </time>{" "}
                  · {row.kind} · {row.source}
                  {row.operation ? ` · ${row.operation}` : ""}
                </small>
              </span>
              <span className="operation-outcome" data-outcome={row.outcome}>
                {row.kind === "computer.process.terminal"
                  ? "observed"
                  : row.outcome}
              </span>
            </summary>
            <dl className="activity-facts">
              {[
                ["Source", row.source],
                ["Operation", row.kind],
                ["Workspace", row.target?.workspace ?? "—"],
                ["Path", row.target?.relativePath ?? "—"],
                ["Command category", row.target?.command ?? "—"],
                ["Target", row.operation || "App"],
                ["Outcome", row.outcome],
                ["Code", row.code ?? "—"],
                [
                  "Duration",
                  row.durationMs == null
                    ? "Unavailable"
                    : `${row.durationMs} ms`,
                ],
                ...(row.operationRef
                  ? [["Operation ID", row.operationRef.operationId]]
                  : []),
                ...(row.subjectRef
                  ? [["Process ID", row.subjectRef.operationId]]
                  : []),
                ...(row.exit
                  ? [
                      [
                        "Exit",
                        row.exit.kind === "code"
                          ? `Code ${row.exit.value}`
                          : `Signal ${row.exit.value}`,
                      ],
                    ]
                  : []),
                ...(row.executionFacts
                  ? [
                      [
                        "Root waited",
                        row.executionFacts.rootWaited ? "Yes" : "No",
                      ],
                      [
                        "Output drained",
                        row.executionFacts.outputDrained ? "Yes" : "No",
                      ],
                      ["Group cleanup", row.executionFacts.groupCleanup],
                      [
                        "Descendant cleanup",
                        row.executionFacts.descendantCleanup,
                      ],
                      ["Timed out", row.executionFacts.timedOut ? "Yes" : "No"],
                      [
                        "Authority lost",
                        row.executionFacts.authorityLost ? "Yes" : "No",
                      ],
                    ]
                  : []),
              ].map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {row.outcome === "pending" && (
              <p role="status">
                Waiting for the result. This entry updates when the operation
                finishes.
              </p>
            )}
            {row.outcome === "unknown" && (
              <>
                <p>
                  The recorded outcome remains unconfirmed. Do not repeat the
                  action.
                </p>
                {unreadIds.has(row.id) && (
                  <button
                    onClick={() =>
                      notifications.markRead(
                        notifications.unread.filter(
                          (item) => item.id === `operation:${row.id}`,
                        ),
                      )
                    }
                  >
                    Mark as read
                  </button>
                )}
                <button onClick={() => facade.overlay("unresolved-actions")}>
                  Review unresolved actions
                </button>
              </>
            )}
          </details>
        ))
      )}
    </section>
  );
}

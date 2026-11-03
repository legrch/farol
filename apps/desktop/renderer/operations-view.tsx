import { useState } from "react";
import { operationSources, operationOutcomes } from "./operations-contract";
import {
  activityCategory,
  activityGroups,
  activityGroupResult,
  activityResult,
  activitySearchText,
} from "./activity-presentation";
import type {
  ActivityEntry,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

const auditReason: Record<string, string> = {
  invalid_utf8: "Not valid text",
  source_too_large: "Original output exceeds the size limit",
  ambiguous_control: "Contains unsupported control characters",
  inline_body: "Contains an inline body",
  entry_limit: "Activity entry exceeds the size limit",
  filter_failed: "Filtering could not be completed",
  filter_unavailable: "Filtering is unavailable",
  source_incomplete: "Original output is incomplete",
};

export function OperationsActivity({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("requests");
  const [outcome, setOutcome] = useState("all");
  const [query, setQuery] = useState("");
  const rows = [...snapshot.activity]
    .sort((a, b) => b.at - a.at)
    .filter(
      (row) =>
        (category === "all" ||
          activityCategory(row) === category ||
          (category === "requests" &&
            row.id === snapshot.destination.activityId)) &&
        (source === "all" || row.source === source),
    );
  const groups = activityGroups(rows).filter(
    (group) =>
      (outcome === "done"
        ? activityGroupResult(group).outcome === "done" &&
          !activityGroupResult(group).issue
        : group.some(
            (row) =>
              outcome === "all" ||
              (outcome === "attention"
                ? row.outcome === "unknown" || row.outcome === "pending"
                : outcome === "issues"
                  ? activityResult(row).issue
                  : outcome === "failed"
                    ? row.outcome === "failed" ||
                      activityResult(row).outcome === "failed"
                    : row.outcome === outcome),
          )) &&
      group.some((row) =>
        activitySearchText(row).includes(query.toLowerCase()),
      ),
  );
  const renderRow = (row: ActivityEntry) => (
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
        <span
          className="operation-outcome"
          data-outcome={activityResult(row).outcome}
        >
          {activityResult(row).text}
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
          ...(row.kind === "computer.process.terminal"
            ? [["Observation", "Recorded"]]
            : []),
          ["Code", row.code ?? "—"],
          [
            "Duration",
            row.durationMs == null ? "Unavailable" : `${row.durationMs} ms`,
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
                ["Root waited", row.executionFacts.rootWaited ? "Yes" : "No"],
                [
                  "Output drained",
                  row.executionFacts.outputDrained ? "Yes" : "No",
                ],
                ["Group cleanup", row.executionFacts.groupCleanup],
                ["Descendant cleanup", row.executionFacts.descendantCleanup],
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
      {row.auditDetails && (
        <dl className="activity-facts">
          {(
            [
              ["Command", row.auditDetails.command],
              ["Standard output", row.auditDetails.stdout],
              ["Standard error", row.auditDetails.stderr],
            ] as const
          ).map(([label, excerpt]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {excerpt.state === "filtered" ||
                excerpt.state === "filtered-truncated" ? (
                  <pre>
                    {excerpt.text || "(empty)"}
                    {excerpt.state === "filtered-truncated"
                      ? "\n[Excerpt truncated]"
                      : ""}
                  </pre>
                ) : (
                  `${excerpt.state === "withheld" ? "Withheld" : "Unavailable"} · ${auditReason[excerpt.reason]}`
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {row.outcome === "pending" && (
        <p role="status">
          Waiting for the result. This entry updates when the operation
          finishes.
        </p>
      )}
      {row.outcome === "unknown" && (
        <>
          <p>
            The recorded outcome remains unconfirmed. Do not repeat the action.
          </p>
          <button onClick={() => facade.overlay("unresolved-actions")}>
            Review unresolved actions
          </button>
        </>
      )}
    </details>
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
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="requests">Requests</option>
            <option value="system">System</option>
            <option value="all">All</option>
          </select>
        </label>
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
            <option value="issues">Issues</option>
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
      {groups.length === 0 ? (
        <p role="status">No matching activity.</p>
      ) : (
        groups.map((group) => {
          if (group.length === 1) return renderRow(group[0]!);
          const start = group.find(
            (row) => row.kind === "computer_shell_start",
          )!;
          const result = activityGroupResult(group);
          return (
            <details
              className="operation-group"
              key={start.id}
              open={
                group.some(
                  (row) => row.id === snapshot.destination.activityId,
                ) || undefined
              }
            >
              <summary>
                <strong>{start.label}</strong>
                <span
                  className="operation-outcome"
                  data-outcome={result.outcome}
                >
                  {result.text}
                </span>
              </summary>
              {group.map(renderRow)}
            </details>
          );
        })
      )}
    </section>
  );
}

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
  const [source, setSource] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [query, setQuery] = useState("");
  const rows = [...snapshot.activity]
    .sort((a, b) => b.at - a.at)
    .filter(
      (row) =>
        (source === "all" || row.source === source) &&
        (outcome === "all" ||
          (outcome === "attention"
            ? row.outcome === "unknown" || row.outcome === "pending"
            : row.outcome === outcome)) &&
        [row.kind, row.source, row.outcome, row.operation, row.code]
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
            <option value="attention">Needs attention</option>
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
      {diagnostics &&
      (diagnostics.corruptLines > 0 ||
        diagnostics.writeFailures > 0 ||
        (diagnostics.droppedEntries ?? 0) > 0) ? (
        <p role="status">
          {diagnostics.corruptLines} unreadable log lines skipped.{" "}
          {diagnostics.writeFailures} log writes or reads unavailable.{" "}
          {diagnostics.droppedEntries ?? 0} entries were not recorded.{" "}
          {diagnostics.unrecordedUncertainEntries ?? 0} of these had pending or
          unknown outcomes. Do not repeat unconfirmed actions.
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
                  {row.source} · {new Date(row.at).toLocaleString()}
                  {row.operation ? ` · ${row.operation}` : ""}
                </small>
              </span>
              <span className="operation-outcome" data-outcome={row.outcome}>
                {row.outcome}
              </span>
            </summary>
            <dl className="activity-facts">
              {[
                ["Source", row.source],
                ["Operation", row.kind],
                ["Target", row.operation || "App"],
                ["Outcome", row.outcome],
                ["Code", row.code ?? "—"],
                ["Duration", `${row.durationMs ?? 0} ms`],
              ].map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {(row.outcome === "unknown" || row.outcome === "pending") && (
              <>
                <p>
                  The recorded outcome remains unconfirmed. Do not repeat the
                  action.
                </p>
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

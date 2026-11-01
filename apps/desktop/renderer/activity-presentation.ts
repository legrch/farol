import type { ActivityEntry } from "../../../src/ui/renderer/contract";

export function activityCategory(row: ActivityEntry): "requests" | "system" {
  return row.source === "Setup" &&
    (row.kind === "connection.health" || row.kind === "connection.lifecycle")
    ? "system"
    : "requests";
}

export function activityResult(row: ActivityEntry): {
  text: string;
  outcome: string;
  issue: boolean;
} {
  if (row.kind === "computer.process.terminal") {
    const exit = row.exit;
    const issue = Boolean(
      row.executionFacts?.timedOut ||
      row.executionFacts?.authorityLost ||
      row.outcome === "unknown" ||
      row.outcome === "failed" ||
      row.outcome === "refused" ||
      (exit && (exit.kind === "signal" || exit.value !== 0)),
    );
    const text = row.executionFacts?.timedOut
      ? "Timed out"
      : row.executionFacts?.authorityLost
        ? "Authority lost"
        : exit
          ? exit.kind === "code"
            ? `Exit ${exit.value}`
            : `Signal ${exit.value}`
          : "Observation recorded";
    return {
      text,
      outcome: issue ? "failed" : exit ? (row.outcome ?? "unknown") : "unknown",
      issue,
    };
  }
  return {
    text: row.outcome ?? row.phase ?? "recorded",
    outcome: row.outcome ?? row.phase ?? "unknown",
    issue:
      row.outcome === "failed" ||
      row.outcome === "refused" ||
      row.outcome === "unknown",
  };
}

export function activitySearchText(row: ActivityEntry): string {
  return [
    row.kind,
    row.source,
    row.outcome,
    row.operation,
    row.code,
    row.target?.workspace,
    row.target?.relativePath,
    row.operationRef?.operationId,
    row.subjectRef?.operationId,
    row.exit?.value,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" ")
    .toLowerCase();
}

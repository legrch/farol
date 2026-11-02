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

// Correlate only records carrying the same bounded process identity. Older
// records without a reference remain separate and are never guessed together.
export function activityGroups(
  rows: readonly ActivityEntry[],
): ActivityEntry[][] {
  const referenceKey = (
    reference: NonNullable<ActivityEntry["operationRef"]>,
  ) =>
    JSON.stringify([
      reference.owner,
      reference.operationId,
      reference.buildId,
      reference.runtimeId,
      reference.backendGeneration ?? null,
    ]);
  const key = (row: ActivityEntry): string | null => {
    if (
      ![
        "computer_shell_start",
        "computer_shell_read",
        "computer_shell_cancel",
        "computer.process.terminal",
      ].includes(row.kind)
    )
      return null;
    const ref =
      row.kind === "computer_shell_read" || row.kind === "computer_shell_cancel"
        ? row.subjectRef
        : row.operationRef;
    return ref?.owner === "computer.process" ? referenceKey(ref) : null;
  };
  const starts = new Set(
    rows
      .filter((row) => row.kind === "computer_shell_start")
      .map(key)
      .filter((value): value is string => value !== null),
  );
  const groups: ActivityEntry[][] = [],
    byKey = new Map<string, ActivityEntry[]>();
  for (const row of rows) {
    const id = key(row);
    if (!id || !starts.has(id)) {
      groups.push([row]);
      continue;
    }
    let group = byKey.get(id);
    if (!group) {
      group = [];
      byKey.set(id, group);
      groups.push(group);
    }
    group.push(row);
  }
  return groups;
}

export function activityGroupResult(group: readonly ActivityEntry[]) {
  const terminal = group.find(
    (row) => row.kind === "computer.process.terminal",
  );
  const original =
    group.find((row) => row.kind === "computer_shell_start") ?? group[0]!;
  const observed = activityResult(terminal ?? original);
  if (group.some((row) => row.outcome === "unknown")) {
    return {
      text: terminal
        ? `${observed.text} · result unconfirmed`
        : "Result unconfirmed",
      outcome: "unknown",
      issue: true,
    };
  }
  return observed;
}

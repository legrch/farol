import type {
  OperationEntry,
  OperationReference,
} from "../renderer/operations-contract";

function supportReference(
  value: OperationReference | null,
): OperationReference | null {
  if (value === null) return null;
  return {
    owner: value.owner,
    operationId: value.operationId,
    buildId: value.buildId,
    runtimeId: value.runtimeId,
    binding: value.binding,
  };
}

/** Support exports have an explicit metadata allowlist. New local Activity
 * fields do not become transferable merely by extending the Activity schema. */
export function supportOperationMetadata(
  entry: OperationEntry,
): OperationEntry {
  const common = {
    id: entry.id,
    at: entry.at,
    source: entry.source,
    kind: entry.kind,
    target: {
      ...(entry.target.workspace === undefined
        ? {}
        : { workspace: entry.target.workspace }),
      ...(entry.target.workspaceIdentity === undefined
        ? {}
        : { workspaceIdentity: entry.target.workspaceIdentity }),
      ...(entry.target.relativePath === undefined
        ? {}
        : { relativePath: entry.target.relativePath }),
      ...(entry.target.command === undefined
        ? {}
        : { command: entry.target.command }),
      ...(entry.target.handle === undefined
        ? {}
        : { handle: entry.target.handle }),
      ...(entry.target.start === undefined
        ? {}
        : { start: entry.target.start }),
    },
    outcome: entry.outcome,
    code: entry.code,
    durationMs: entry.durationMs,
    ...(entry.lifecycle === undefined
      ? {}
      : {
          lifecycle: { id: entry.lifecycle.id, phase: entry.lifecycle.phase },
        }),
  };
  if (!("schema" in entry)) return { ...common, durationMs: entry.durationMs };
  return {
    ...common,
    schema: entry.schema,
    operationRef: supportReference(entry.operationRef),
    subjectRef: supportReference(entry.subjectRef),
    timing:
      entry.timing === null
        ? null
        : {
            requestedAt: entry.timing.requestedAt,
            startedAt: entry.timing.startedAt,
            endedAt: entry.timing.endedAt,
          },
    exit:
      entry.exit === null
        ? null
        : entry.exit.kind === "code"
          ? { kind: "code", value: entry.exit.value }
          : { kind: "signal", value: entry.exit.value },
    executionFacts:
      entry.executionFacts === null
        ? null
        : {
            rootWaited: entry.executionFacts.rootWaited,
            outputDrained: entry.executionFacts.outputDrained,
            groupCleanup: entry.executionFacts.groupCleanup,
            descendantCleanup: entry.executionFacts.descendantCleanup,
            timedOut: entry.executionFacts.timedOut,
            authorityLost: entry.executionFacts.authorityLost,
          },
  };
}

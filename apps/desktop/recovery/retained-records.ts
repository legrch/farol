import { createHash } from "node:crypto";
import { parseJSON } from "../bridge/frame";

type ObjectValue = Record<string, unknown>;
type Owner = Readonly<{
  ownerId: string;
  profileId: string;
  computerId: string;
}>;
type Entry = Readonly<{ key: string; bytes: Buffer }>;
const keyPattern = /^[a-f0-9]{64}\.json$/u;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw Error("STARTUP_PRESERVED_SELECTION_INVALID");
}
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}
function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
  return value;
}
function uint64(value: unknown): string {
  const result = text(value);
  if (
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(result) ||
    BigInt(result) > 18446744073709551615n
  )
    invalid();
  return result;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid();
  return result;
}
type OutputReference = Readonly<{
  stream: "stdout" | "stderr";
  offset: number;
  sha256: string;
}>;
function outputReferences(stored: ObjectValue): OutputReference[] {
  const result: OutputReference[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const list = stored[stream];
    if (!Array.isArray(list)) invalid();
    for (const value of list) {
      const v = object(value);
      if (counter(v.bytes) === 0) invalid();
      result.push({
        stream,
        offset: counter(v.offset),
        sha256: digest(v.sha256),
      });
    }
  }
  return result;
}
function identity(value: unknown, scope: string, owner: Owner) {
  const v = object(value);
  if (
    v.scope !== scope ||
    v.ownerId !== owner.ownerId ||
    v.profileId !== owner.profileId ||
    v.computerId !== owner.computerId
  )
    invalid();
  return {
    OperationID: text(v.operationId),
    OwnerID: text(v.ownerId),
    ProfileID: text(v.profileId),
    ComputerID: text(v.computerId),
    Scope: scope,
    SessionID: "",
    TaskID: "",
    TaskEpoch: 0,
    ParticipantID: "",
  };
}
function fileBinding(v: ObjectValue, scope: string, owner: Owner) {
  const origin = scope === "external-connector" ? object(v.origin) : null;
  return {
    Identity: identity(v.identity, scope, owner),
    ComputerGeneration: counter(v.computerGeneration),
    WorkspaceID: text(v.workspaceId),
    RelativePath: text(v.relativePath),
    RequestDigest: text(v.requestDigest),
    Connector: origin
      ? {
          BuildID: text(origin.buildId),
          BackendGeneration: text(origin.backendGeneration),
          RuntimeID: text(origin.runtimeId),
          ConnectorGeneration: uint64(origin.connectorGeneration),
          SessionID: text(origin.sessionId),
          TaskID: text(origin.taskId),
          ParticipantID: text(origin.participantId),
          TurnID: text(origin.turnId),
          CallID: text(origin.callId),
          TaskEpoch: counter(origin.taskEpoch),
          Generation: counter(origin.generation),
          Operation: text(origin.operation),
        }
      : {
          BuildID: "",
          BackendGeneration: "",
          RuntimeID: "",
          ConnectorGeneration: 0,
          SessionID: "",
          TaskID: "",
          ParticipantID: "",
          TurnID: "",
          CallID: "",
          TaskEpoch: 0,
          Generation: 0,
          Operation: "",
        },
  };
}
type Base = Readonly<{ Key: string; SHA256: string }>;
type FileRecord = Base &
  Readonly<{
    kind: "owner-file" | "connector-file";
    Binding: ReturnType<typeof fileBinding>;
  }>;
type ProcessRecord = Base &
  Readonly<{
    kind: "process";
    version: 4 | 5 | 6;
    Identity: ReturnType<typeof identity>;
    Host: Readonly<{
      ProfileID: string;
      BackendGeneration: string;
      BuildID: string;
      RuntimeID: string;
      LaunchDigest: string;
      ConnectorGeneration: string;
    }>;
    ComputerGeneration: string;
    Generation: string;
    phase: string;
    OutputReferences: readonly OutputReference[];
  }>;
type OutputRecord = Base &
  Readonly<{
    kind: "output";
    OutputParent: string;
    Identity: ReturnType<typeof identity>;
  }>;
export type StartupRetainedRecord = FileRecord | ProcessRecord | OutputRecord;

/** Mechanical read selection only, never canonical Go validation or eligibility.
 * Whole bytes bind phases, receipts, generations and output. No body is returned,
 * no record is omitted, and no UNKNOWN is settled. Known unsupported shapes
 * remain distinct from an owner-file input to the existing native consumer.
 */
export function projectStartupRetainedRecords(
  entries: readonly Entry[],
  owner: Owner,
): readonly StartupRetainedRecord[] {
  if (
    entries.length > 128 ||
    new Set(entries.map((e) => e.key)).size !== entries.length
  )
    invalid();
  const selected: StartupRetainedRecord[] = [];
  const outputs: { base: Base; parent: string; reference: OutputReference }[] =
    [];
  for (const entry of entries) {
    if (
      !keyPattern.test(entry.key) ||
      entry.bytes.length === 0 ||
      entry.bytes.length > 65536
    )
      invalid();
    const envelope = object(
      parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes)),
    );
    const stored = object(envelope.record);
    const base = { Key: entry.key, SHA256: hash(entry.bytes) };
    if (
      envelope.schemaVersion === 2 &&
      envelope.kind === "workspace_owner_mutation"
    ) {
      selected.push({
        ...base,
        kind: "owner-file",
        Binding: fileBinding(stored, "owner-settings", owner),
      });
    } else if (
      envelope.schemaVersion === 3 &&
      envelope.kind === "workspace_connector_mutation"
    ) {
      selected.push({
        ...base,
        kind: "connector-file",
        Binding: fileBinding(stored, "external-connector", owner),
      });
    } else if (
      (envelope.schemaVersion === 4 &&
        envelope.kind === "workspace_connector_process") ||
      ((envelope.schemaVersion === 5 || envelope.schemaVersion === 6) &&
        envelope.kind === "workspace_connector_process_terminal")
    ) {
      const scope = object(stored.scope),
        host = object(scope.host),
        intent = object(stored.intent);
      // The producer derives process identity from this exact scope and intent.
      // It does not derive owner file paths, default receipts or cleanup facts.
      const i = identity(
        {
          operationId: intent.operationId,
          ownerId: scope.ownerId,
          profileId: host.profileId,
          computerId: scope.computerId,
          scope: "external-connector",
        },
        "external-connector",
        owner,
      );
      selected.push({
        ...base,
        kind: "process",
        version: envelope.schemaVersion,
        Identity: i,
        phase: text(stored.phase),
        OutputReferences:
          envelope.schemaVersion === 4 ? [] : outputReferences(stored),
        ComputerGeneration: uint64(scope.computerGeneration),
        Generation: uint64(scope.generation),
        Host: {
          ProfileID: text(host.profileId),
          BackendGeneration: text(host.backendGeneration),
          BuildID: text(host.buildId),
          RuntimeID: text(host.runtimeId),
          LaunchDigest: text(host.launchDigest),
          ConnectorGeneration: uint64(host.connectorGeneration),
        },
      });
    } else if (
      envelope.schemaVersion === 5 &&
      envelope.kind === "workspace_connector_process_output"
    ) {
      const parent = text(stored.parent);
      if (!keyPattern.test(parent)) invalid();
      if (stored.stream !== "stdout" && stored.stream !== "stderr") invalid();
      outputs.push({
        base,
        parent,
        reference: {
          stream: stored.stream,
          offset: counter(stored.offset),
          sha256: digest(stored.sha256),
        },
      });
    } else invalid();
  }
  for (const output of outputs) {
    const parent = selected.find((r) => r.Key === output.parent);
    if (!parent || parent.kind !== "process" || parent.version === 4) invalid();
    const matching = parent.OutputReferences.filter(
      (ref) =>
        ref.stream === output.reference.stream &&
        ref.offset === output.reference.offset &&
        ref.sha256 === output.reference.sha256,
    );
    if (
      matching.length !== 1 ||
      outputs.filter(
        (candidate) =>
          candidate.parent === output.parent &&
          candidate.reference.stream === output.reference.stream &&
          candidate.reference.offset === output.reference.offset,
      ).length !== 1
    )
      invalid();
    selected.push({
      ...output.base,
      kind: "output",
      OutputParent: output.parent,
      Identity: { ...parent.Identity },
    });
  }
  for (const record of selected) {
    if (record.kind !== "process") continue;
    for (const ref of record.OutputReferences) {
      if (
        outputs.filter(
          (output) =>
            output.parent === record.Key &&
            output.reference.stream === ref.stream &&
            output.reference.offset === ref.offset &&
            output.reference.sha256 === ref.sha256,
        ).length !== 1
      )
        invalid();
    }
  }
  return selected.sort((a, b) => a.Key.localeCompare(b.Key));
}

/** Preserve the current native eligibility boundary. Projection is not admission.
 * A mixed namespace needs an independently accepted native consumer contract;
 * passing a fabricated owner Binding or filtering neighbors is never compatible.
 */
export function ownerCompletedInputs(
  records: readonly StartupRetainedRecord[],
) {
  return records.map((record) => {
    if (record.kind !== "owner-file")
      throw Error("STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED");
    return { Key: record.Key, SHA256: record.SHA256, Binding: record.Binding };
  });
}

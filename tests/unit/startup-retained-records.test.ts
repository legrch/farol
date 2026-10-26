import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ownerCompletedInputs,
  projectStartupRetainedRecords,
} from "../../apps/desktop/recovery/retained-records";
import { maintenanceFailureCode } from "../../apps/desktop/recovery/diagnostics";

// Anonymized producer shapes, not original owner bytes or canonical Go receipts.
// Pure CPU projection: no profile, claims, Go child, native eligibility or effects.
const owner = {
  ownerId: "owner-desktop",
  profileId: "fixture-profile",
  computerId: "fixture-computer",
};
const key = (n: number) => n.toString(16).padStart(64, "0") + ".json";
const entry = (n: number, value: unknown) => ({
  key: key(n),
  bytes: Buffer.from(JSON.stringify(value) + "\n"),
});
function file(connector = false) {
  return {
    schemaVersion: connector ? 3 : 2,
    kind: connector
      ? "workspace_connector_mutation"
      : "workspace_owner_mutation",
    record: {
      identity: {
        ...owner,
        scope: connector ? "external-connector" : "owner-settings",
        operationId: "fixture-write",
      },
      computerGeneration: 13,
      workspaceId: "fixture-workspace",
      relativePath: "canary.txt",
      requestDigest: "a".repeat(64),
      ...(connector
        ? {
            origin: {
              buildId: "old-build",
              backendGeneration: "original-backend",
              runtimeId: "original-runtime",
              connectorGeneration: "3",
              sessionId: "session",
              taskId: "task",
              participantId: "participant",
              turnId: "turn",
              callId: "call",
              taskEpoch: 0,
              generation: 2,
              operation: "write",
            },
          }
        : {}),
      phase: "outcome_unknown",
      outcome: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" },
    },
  };
}
function processRecord(version: 4 | 5 | 6 = 6, withOutput = false) {
  return {
    schemaVersion: version,
    kind:
      version === 4
        ? "workspace_connector_process"
        : "workspace_connector_process_terminal",
    record: {
      scope: {
        ownerId: owner.ownerId,
        computerId: owner.computerId,
        callId: "fixture-call",
        computerGeneration: "13",
        generation: "2",
        host: {
          profileId: owner.profileId,
          backendGeneration: "original-backend",
          buildId: "old-build",
          runtimeId: "original-runtime",
          launchDigest: "b".repeat(64),
          connectorGeneration: "3",
        },
      },
      intent: {
        operationId: "fixture-process",
        binding: {
          ownerId: owner.ownerId,
          sessionId: "session",
          taskId: "task",
          taskEpoch: "0",
          participantId: "participant",
          turnId: "turn",
        },
        seal: {
          digest: "c".repeat(64),
          workspaceId: "fixture-workspace",
          root: "/fixture/workspace",
          cwd: "/fixture/workspace",
          device: "1",
          inode: "2",
          write: false,
        },
        deadlineUnixNano: "1790000000000000000",
      },
      phase: version === 4 ? "reserved" : version === 5 ? "terminal" : "exited",
      observation: {
        supervisorState: "exited",
        root: "exited",
        waited: true,
        exitCode: 127,
        exitSignal: 0,
        outputDrained: true,
        groupCleanup: "unverified",
        descendantCleanup: "unverified",
        cancelRequested: false,
      },
      stdout: [],
      stderr: withOutput
        ? [{ offset: 0, bytes: 6, sha256: "d".repeat(64) }]
        : [],
    },
  };
}
const output = (parent = key(2)) => ({
  schemaVersion: 5,
  kind: "workspace_connector_process_output",
  record: {
    parent,
    stream: "stderr",
    offset: 0,
    sha256: "d".repeat(64),
    data: "PRIVATE_OUTPUT_CANARY",
  },
});
const select = (values: ReturnType<typeof entry>[]) =>
  projectStartupRetainedRecords(values, owner);

describe("closed startup retained inventory projection", () => {
  it.each(["operationId", "ownerId", "profileId", "computerId", "scope"])(
    "refuses missing file identity %s",
    (field) => {
      const value = file();
      Reflect.deleteProperty(value.record.identity, field);
      expect(() => select([entry(1, value)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it("refuses a connector file whose original origin is missing", () => {
    const value = file(true);
    Reflect.deleteProperty(value.record, "origin");
    expect(() => select([entry(1, value)])).toThrow(
      "STARTUP_PRESERVED_SELECTION_INVALID",
    );
  });
  it.each([
    "missing-chunk",
    "unlisted-output",
    "wrong-digest",
    "wrong-stream",
    "duplicate-offset",
  ])("rejects incomplete output inventory: %s", (kind) => {
    const parent = processRecord(6, kind !== "unlisted-output");
    const child = output();
    if (kind === "wrong-digest") child.record.sha256 = "e".repeat(64);
    if (kind === "wrong-stream") child.record.stream = "stdout";
    const entries = [entry(2, parent)];
    if (kind !== "missing-chunk") entries.push(entry(3, child));
    if (kind === "duplicate-offset") entries.push(entry(4, child));
    expect(() => select(entries)).toThrow(
      "STARTUP_PRESERVED_SELECTION_INVALID",
    );
  });
  it("projects the whole mixed inventory in key order without disclosing output or claiming admission", () => {
    const entries = [
      entry(3, output()),
      entry(4, file(true)),
      entry(1, file()),
      entry(2, processRecord(6, true)),
    ];
    const before = entries.map((e) => e.bytes.toString("hex"));
    const selected = select(entries);
    expect(selected.map((r) => [r.Key, r.kind])).toEqual([
      [key(1), "owner-file"],
      [key(2), "process"],
      [key(3), "output"],
      [key(4), "connector-file"],
    ]);
    for (const e of entries)
      expect(selected.find((r) => r.Key === e.key)?.SHA256).toBe(
        createHash("sha256").update(e.bytes).digest("hex"),
      );
    expect(selected[2]).toMatchObject({
      OutputParent: key(2),
      Identity: {
        Scope: "external-connector",
        OperationID: "fixture-process",
        OwnerID: owner.ownerId,
      },
    });
    expect(JSON.stringify(selected)).not.toContain("PRIVATE_OUTPUT_CANARY");
    expect(entries.map((e) => e.bytes.toString("hex"))).toEqual(before);
    expect(() => ownerCompletedInputs(selected)).toThrow(
      "STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED",
    );
  });
  it("preserves connector origin and uint64 process generations without lossy defaults", () => {
    const p = processRecord();
    p.record.scope.generation = "18446744073709551615";
    const selected = select([entry(1, file(true)), entry(2, p)]);
    expect(selected[0]).toMatchObject({
      Binding: {
        Connector: {
          BuildID: "old-build",
          BackendGeneration: "original-backend",
          ConnectorGeneration: "3",
          Generation: 2,
        },
      },
    });
    expect(selected[1]).toMatchObject({
      Generation: "18446744073709551615",
      phase: "exited",
      Host: { BackendGeneration: "original-backend" },
    });
    expect(() => ownerCompletedInputs(selected)).toThrow(
      "STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED",
    );
  });
  it.each([4, 5, 6] as const)(
    "recognizes process version %s without upgrading a reservation/exit to owner completion",
    (version) => {
      const [selected] = select([entry(2, processRecord(version))]);
      expect(selected).toMatchObject({ kind: "process", version });
      expect(() => ownerCompletedInputs([selected!])).toThrow(
        "STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED",
      );
    },
  );
  it("keeps file phases opaque: an owner projection is not a completed receipt", () => {
    const values = ["prepared", "outcome_unknown", "completed"].map(
      (phase, n) => {
        const v = file();
        v.record.phase = phase;
        return entry(n, v);
      },
    );
    const selected = ownerCompletedInputs(select(values));
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((s) => s.SHA256)).size).toBe(3);
    expect(JSON.stringify(selected)).not.toContain('"phase"');
    // Canonical Go OwnerCompleted remains responsible for refusing the first two.
  });
  it.each(["ownerId", "profileId", "computerId"] as const)(
    "refuses foreign file %s without returning a partial set",
    (field) => {
      const v = file();
      v.record.identity[field] = "foreign";
      expect(() => select([entry(1, file()), entry(2, v)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it.each(["ownerId", "computerId", "profileId"] as const)(
    "refuses foreign process %s",
    (field) => {
      const v = processRecord();
      if (field === "profileId") v.record.scope.host.profileId = "foreign";
      else v.record.scope[field] = "foreign";
      expect(() => select([entry(2, v), entry(3, output())])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it.each(["scope", "intent", "host", "operationId"])(
    "refuses missing process identity component %s",
    (field) => {
      const v = processRecord();
      if (field === "scope" || field === "intent")
        Reflect.deleteProperty(v.record, field);
      else if (field === "host") Reflect.deleteProperty(v.record.scope, field);
      else Reflect.deleteProperty(v.record.intent, field);
      expect(() => select([entry(2, v)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it.each(["", "-1", "01", "18446744073709551616", "not-a-counter"])(
    "refuses malformed process generation %s",
    (generation) => {
      const v = processRecord();
      v.record.scope.generation = generation;
      expect(() => select([entry(2, v)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it("pins foreign historical backend generation in the hash, without making it current", () => {
    const p = processRecord();
    const original = select([entry(2, p)])[0]!;
    p.record.scope.host.backendGeneration = "foreign-generation";
    const changed = select([entry(2, p)])[0]!;
    expect(changed.SHA256).not.toBe(original.SHA256);
    expect(changed).toMatchObject({
      Host: { BackendGeneration: "foreign-generation" },
    });
    expect(() => ownerCompletedInputs([changed])).toThrow(
      "STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED",
    );
  });
  it.each(["unknown-type", "unknown-version", "mismatched-version"])(
    "refuses %s rather than filtering or applying file defaults",
    (which) => {
      const v = file();
      if (which === "unknown-type") v.kind = "future_record";
      else v.schemaVersion = which === "unknown-version" ? 99 : 6;
      expect(() => select([entry(1, file()), entry(2, v)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it.each(["orphan", "file-parent", "reserved-parent", "malformed-parent"])(
    "refuses %s output without inventing identity",
    (which) => {
      const parent =
        which === "file-parent"
          ? file()
          : processRecord(which === "reserved-parent" ? 4 : 6);
      const child = output(
        which === "orphan"
          ? key(99)
          : which === "malformed-parent"
            ? "../other.json"
            : key(2),
      );
      expect(() => select([entry(2, parent), entry(3, child)])).toThrow(
        "STARTUP_PRESERVED_SELECTION_INVALID",
      );
    },
  );
  it("rejects duplicate names and invalid JSON/duplicate keys without effects", () => {
    expect(() => select([entry(1, file()), entry(1, file())])).toThrow();
    for (const bytes of [
      Buffer.from('{"record":'),
      Buffer.from('{"kind":"x","kind":"y"}'),
    ])
      expect(() => select([{ key: key(1), bytes }])).toThrow();
  });
  it("exports only the new closed diagnostic at the maintenance boundary", () => {
    expect(
      maintenanceFailureCode(
        Error("STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED"),
      ),
    ).toBe("STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED");
    expect(
      maintenanceFailureCode(
        Error("STARTUP_PRESERVED_MUTATION_CONTRACT_UNSUPPORTED private"),
      ),
    ).toBe("UNCLASSIFIED_MAINTENANCE_FAILURE");
  });
});

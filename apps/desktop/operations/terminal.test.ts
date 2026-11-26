import { describe, expect, it } from "vitest";
import type { ComputerProcessTerminalAudit } from "../bridge/wire";
import type { OperationReference } from "../renderer/operations-contract";
import {
  buildTerminalEntry,
  matchesTerminalOperation,
  parseTerminalAuditDetails,
  terminalAdmissible,
  terminalExecutionFacts,
  terminalExit,
  terminalKey,
  terminalRepeatVerdict,
} from "./terminal";

const reference: OperationReference = {
  owner: "computer.process",
  operationId: "op",
  buildId: "build",
  runtimeId: "runtime",
  binding: "requested",
};
const { exitCode: _code, ...signalBase } = {
  exitCode: 0,
  operationId: "op",
  buildId: "build",
  runtimeId: "runtime",
  exitSignal: 0,
  rootWaited: true,
  outputDrained: true,
  groupCleanup: "confirmed" as const,
  descendantCleanup: "confirmed" as const,
  timedOut: false,
  authorityLost: false,
};
const signalled: ComputerProcessTerminalAudit = {
  ...signalBase,
  exitSignal: 9,
};
const fact: ComputerProcessTerminalAudit = {
  operationId: "op",
  buildId: "build",
  runtimeId: "runtime",
  exitCode: 0,
  exitSignal: 0,
  rootWaited: true,
  outputDrained: true,
  groupCleanup: "confirmed",
  descendantCleanup: "confirmed",
  timedOut: false,
  authorityLost: false,
};

describe("terminal admission", () => {
  it("accepts a settled fact bound to its reference", () => {
    expect(terminalAdmissible(reference, fact)).toBe(true);
    expect(terminalAdmissible(reference, signalled)).toBe(true);
  });
  it.each([
    ["another operation", { operationId: "other" }],
    ["another build", { buildId: "other" }],
    ["another runtime", { runtimeId: "other" }],
    ["an unwaited root", { rootWaited: false }],
    ["undrained output", { outputDrained: false }],
    ["pending group cleanup", { groupCleanup: "pending" as const }],
    ["pending descendant cleanup", { descendantCleanup: "pending" as const }],
    ["an exit code above 255", { exitCode: 256 }],
    ["a code with a signal", { exitSignal: 9 }],
  ])("refuses %s", (_name, change) => {
    expect(terminalAdmissible(reference, { ...fact, ...change })).toBe(false);
  });
  it("refuses a missing code with no signal or an out-of-range signal", () => {
    expect(terminalAdmissible(reference, { ...signalled, exitSignal: 0 })).toBe(
      false,
    );
    expect(
      terminalAdmissible(reference, { ...signalled, exitSignal: 129 }),
    ).toBe(false);
  });
  it("refuses a reference of another owner", () => {
    expect(terminalAdmissible({ ...reference, owner: "release" }, fact)).toBe(
      false,
    );
  });
});

describe("terminal identity", () => {
  it("keys on build, runtime and operation in that order", () => {
    expect(terminalKey(fact)).toBe('["build","runtime","op"]');
  });
  it("matches only the process entry of the same operation", () => {
    const entry = (patch: object) =>
      ({
        schema: "farol.operation/2",
        operationRef: { ...reference },
        ...patch,
      }) as never;
    expect(matchesTerminalOperation(entry({}), fact)).toBe(true);
    expect(
      matchesTerminalOperation(
        entry({ operationRef: { ...reference, runtimeId: "x" } }),
        fact,
      ),
    ).toBe(false);
    expect(matchesTerminalOperation({ id: "v1" } as never, fact)).toBe(false);
  });
  it("derives the exit and facts without extra keys", () => {
    expect(terminalExit(fact)).toEqual({ kind: "code", value: 0 });
    expect(terminalExit(signalled)).toEqual({
      kind: "signal",
      value: 9,
    });
    expect(Object.keys(terminalExecutionFacts(fact))).toEqual([
      "rootWaited",
      "outputDrained",
      "groupCleanup",
      "descendantCleanup",
      "timedOut",
      "authorityLost",
    ]);
  });
  it("calls the same exit and facts a duplicate and any other a conflict", () => {
    const exit = terminalExit(fact);
    const facts = terminalExecutionFacts(fact);
    expect(
      terminalRepeatVerdict({ exit, executionFacts: facts }, exit, facts),
    ).toBe("duplicate");
    expect(
      terminalRepeatVerdict(
        { exit: { kind: "code", value: 1 }, executionFacts: facts },
        exit,
        facts,
      ),
    ).toBe("conflict");
    expect(
      terminalRepeatVerdict(
        { exit, executionFacts: { ...facts, timedOut: true } },
        exit,
        facts,
      ),
    ).toBe("conflict");
  });
});

describe("terminal entry", () => {
  const build = (auditDetails: ReturnType<typeof parseTerminalAuditDetails>) =>
    buildTerminalEntry({
      id: "00000000-0000-4000-8000-000000000001",
      at: 5,
      reference,
      exit: terminalExit(fact),
      executionFacts: terminalExecutionFacts(fact),
      auditDetails,
    });
  it("stores an accepted reference with no duration", () => {
    const entry = build(undefined) as Record<string, unknown>;
    expect(entry).toMatchObject({
      kind: "computer.process.terminal",
      outcome: "done",
      durationMs: null,
      operationRef: { ...reference, binding: "accepted" },
      exit: { kind: "code", value: 0 },
    });
    expect("auditDetails" in entry).toBe(false);
  });
  it("reports an invalid detail block and an absent one", () => {
    expect(parseTerminalAuditDetails(fact)).toBeUndefined();
    expect(
      parseTerminalAuditDetails({ ...fact, auditDetails: {} as never })
        ?.success,
    ).toBe(false);
  });
  it("withholds filtered excerpts when the record is over the cap", () => {
    const text = "\n".repeat(2048);
    const filtered = { state: "filtered" as const, text };
    const details = parseTerminalAuditDetails({
      ...fact,
      auditDetails: {
        command: filtered,
        stdout: filtered,
        stderr: filtered,
      } as never,
    });
    expect(details?.success).toBe(true);
    const entry = build(details) as unknown as {
      auditDetails: { stdout: { state: string; reason?: string } };
    };
    expect(entry.auditDetails.stdout).toEqual({
      state: "withheld",
      reason: "entry_limit",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  methodKinds,
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
  validate,
  type ComputerCatalogueRequest,
  type ComputerBootstrapRequest,
  type ComputerInstructionRead,
  type ComputerInstructionMissing,
  type ComputerInstructionUnavailable,
} from "../../apps/desktop/bridge/wire.ts";

// Pure generated-wire vectors only: no Client, child, filesystem or live owner.
const correlation: ComputerCatalogueRequest = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  generation: "18446744073709551615",
  callId: "call",
};
const bootstrap: ComputerBootstrapRequest = {
  ...correlation,
  workspaceId: "workspace",
  relativeDirectory: "a/b",
};

describe("canonical desktop discovery wire", () => {
  it("adds reads within the existing protocol and frame limit", () => {
    expect(methodKinds["computer.workspace.catalogue"]).toBe("read");
    expect(methodKinds["computer.workspace.bootstrap"]).toBe("read");
    expect([protocolMajor, protocolMinor, maxFrameBytes]).toEqual([
      1, 0, 1048576,
    ]);
  });

  it.each([
    ["ComputerCatalogueRequest", correlation],
    ["ComputerBootstrapRequest", bootstrap],
  ])(
    "admits %s correlation but no authority-bearing input",
    (name, request) => {
      expect(validate(name, request)).toBe(true);
      for (const field of [
        "root",
        "approvedRoot",
        "grants",
        "home",
        "positiveAdmission",
      ]) {
        expect(validate(name, { ...request, [field]: {} })).toBe(false);
      }
      for (const taskEpoch of [
        9007199254740992,
        "01",
        "-1",
        "1e3",
        "18446744073709551616",
      ]) {
        expect(validate(name, { ...request, taskEpoch })).toBe(false);
      }
      expect(validate(name, { ...request, ownerId: "\ud800" })).toBe(false);
    },
  );

  it("preserves uint64 strings in physical root identity", () => {
    const root = {
      path: "/disposable",
      device: "18446744073709551615",
      inode: "9007199254740993",
    };
    expect(validate("ComputerApprovedRoot", root)).toBe(true);
    expect(JSON.parse(JSON.stringify(root))).toEqual(root);
    expect(
      validate("ComputerApprovedRoot", { ...root, device: 9007199254740992 }),
    ).toBe(false);
    expect(
      validate("ComputerApprovedRoot", {
        ...root,
        inode: "18446744073709551616",
      }),
    ).toBe(false);
  });

  it("keeps instruction facts as distinct closed canonical elements", () => {
    const read: ComputerInstructionRead = {
      status: "read",
      relativePath: "AGENTS.md",
      text: "🌊",
      bytes: "9007199254740993",
    };
    const missing: ComputerInstructionMissing = {
      status: "not_found",
      relativePath: "a/AGENTS.md",
    };
    const unavailable: ComputerInstructionUnavailable = {
      status: "unavailable",
      relativePath: "a/b/AGENTS.md",
      code: "WORKSPACE_NOT_TEXT",
    };
    for (const [name, instruction] of [
      ["ComputerInstructionRead", read],
      ["ComputerInstructionMissing", missing],
      ["ComputerInstructionUnavailable", unavailable],
    ] as const) {
      expect(validate(name, instruction)).toBe(true);
      expect(validate(name, { ...instruction, grant: {} })).toBe(false);
      expect(validate(name, { ...instruction, status: "unknown" })).toBe(false);
    }
    expect(validate("ComputerInstructionRead", missing)).toBe(false);
    expect(validate("ComputerInstructionMissing", unavailable)).toBe(false);
    expect(validate("ComputerInstructionUnavailable", missing)).toBe(false);
    expect(
      validate("ComputerInstructionUnavailable", {
        ...unavailable,
        code: "unclassified",
      }),
    ).toBe(false);
    expect(
      validate("ComputerInstructionMissing", { ...missing, text: "" }),
    ).toBe(false);
  });

  it.each([
    ["ComputerCatalogueRefusal", correlation],
    ["ComputerBootstrapRefusal", bootstrap],
  ])("admits %s with exact correlation and retry never", (name, request) => {
    const refused = {
      request,
      code: "AUTHORITY_EXPIRED",
      source: "task-grant",
      retry: "never",
    };
    expect(validate(name, refused)).toBe(true);
    expect(validate(name, { ...refused, retry: "later" })).toBe(false);
    expect(validate(name, { ...refused, source: "unclassified" })).toBe(false);
    expect(validate(name, { ...refused, data: "private" })).toBe(false);
  });
});

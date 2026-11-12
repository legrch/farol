import { describe, expect, it } from "vitest";
import { validate } from "../../apps/desktop/bridge/wire.ts";

// Canonical schema source is api/desktop/v1/schema.json. These tests are
// intentionally against the GENERATED strict boundary after host regeneration.
// The Go StopRequest domain validates command kind vs empty/fixed scope.
const base = {
  operationId: "11111111-1111-4111-8111-111111111111",
  requestDigest: "a".repeat(64),
  commandKind: "computer.add-workspace",
  commandDigest: "b".repeat(64),
  purpose: "workspace-change",
  consentDigest: "c".repeat(64),
  expectedRevision: "9",
  computerGeneration: "4",
  connectorGeneration: "3",
  settingsDigest: "d".repeat(64),
  stopEffectId: "22222222-2222-4222-8222-222222222222",
  settingsEffectId: "33333333-3333-4333-8333-333333333333",
  cleanupEffectId: "44444444-4444-4444-8444-444444444444",
} as const;

describe("C7 exact canonical Stop scope", () => {
  it.each([
    "computer.add-workspace",
    "computer.update-commands",
    "computer.update-file-policy",
  ])("accepts a global %s without borrowing a workspace ID or root", (kind) => {
    expect(
      validate("ComputerStopAdmitRequest", { ...base, commandKind: kind }),
    ).toBe(true);
  });

  it("accepts a fixed original workspace/root pair", () => {
    expect(
      validate("ComputerStopAdmitRequest", {
        ...base,
        commandKind: "computer.update-access",
        workspaceId: "existing",
        root: "/Users/example/project",
      }),
    ).toBe(true);
  });

  it("rejects invalid root or unknown fields before Go admission", () => {
    expect(
      validate("ComputerStopAdmitRequest", {
        ...base,
        workspaceId: "existing",
        root: "",
      }),
    ).toBe(false);
    expect(
      validate("ComputerStopAdmitRequest", {
        ...base,
        success: true,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  SeparateAppVerificationScopeSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import { separateAppVerificationScopeCurrent } from "../../src/pkg/product-settings/separate-app-verification";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

// Synthetic settings admission only, never a provider or current Go receipt.
function pending() {
  const settings = guidedSettingsFixture();
  const c = settings.connectors.secureMcp;
  c.attachment = null;
  c.appVerificationPending = true;
  c.chatgptApp = {
    name: "Farol Dev",
    tunnelId: c.tunnelId!,
    connectorGeneration: c.generation,
  };
  c.challenge = {
    value: "00000000-0000-4000-8000-000000000003",
    challengeSha256: "c".repeat(64),
    runtimeGeneration: c.runtime!.runtimeGeneration,
    buildId: fixtureBuildId,
    computerGeneration: 1,
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  settings.setup.connect.outcomeUnknown = true;
  const expected = SeparateAppVerificationScopeSchema.parse({
    ownerAuthorized: true,
    appName: "Farol Dev",
    tunnelId: c.tunnelId,
    connectorGeneration: c.generation,
    computerGeneration: settings.computer.generation,
    runtimeGeneration: c.runtime!.runtimeGeneration,
    buildId: fixtureBuildId,
    workspaceId: fixtureWorkspaceId,
    challengeSha256: c.challenge.challengeSha256,
  });
  return { settings, expected };
}

describe("separate owner-authorized app check scope", () => {
  it("admits only a new explicit scope and preserves predecessor uncertainty", () => {
    const { settings, expected } = pending();
    const before = structuredClone(settings);
    expect(
      separateAppVerificationScopeCurrent(settings, expected, fixtureBuildId),
    ).toBe(true);
    expect(settings).toEqual(before);
    expect(settings.setup.connect.outcomeUnknown).toBe(true);
    expect(settings.connectors.secureMcp.appVerificationPending).toBe(true);
  });

  it.each([
    ["appName", "Other app"],
    ["tunnelId", "other-tunnel"],
    ["connectorGeneration", 2],
    ["computerGeneration", 2],
    ["runtimeGeneration", "d".repeat(64)],
    ["buildId", "d".repeat(64)],
    ["challengeSha256", "d".repeat(64)],
    ["workspaceId", null],
    ["ownerAuthorized", false],
  ])("rejects drift or missing consent in %s", (key, value) => {
    const { settings, expected } = pending();
    expect(
      separateAppVerificationScopeCurrent(
        settings,
        { ...expected, [key as string]: value },
        fixtureBuildId,
      ),
    ).toBe(false);
  });

  const unsafe: [string, (s: ProductSettings) => void][] = [
    [
      "Computer outcome",
      (s) => {
        s.setup.computer.outcomeUnknown = true;
      },
    ],
    [
      "pending edit",
      (s) => {
        s.computer.pendingEdit = {
          operationId: "00000000-0000-4000-8000-000000000004",
          workspaceId: fixtureWorkspaceId,
          relativePath: "file.txt",
          computerGeneration: 1,
          submittedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    ],
    [
      "credential missing",
      (s) => {
        s.connectors.secureMcp.credential = "missing";
      },
    ],
    [
      "Chat outcome",
      (s) => {
        s.setup.chatgpt.outcomeUnknown = true;
      },
    ],
    [
      "host outcome",
      (s) => {
        s.setup.hosts.outcomeUnknown = true;
      },
    ],
    [
      "verification outcome",
      (s) => {
        s.setup.verify.outcomeUnknown = true;
      },
    ],
    [
      "runtime lost",
      (s) => {
        s.connectors.secureMcp.runtime = null;
      },
    ],
    [
      "challenge lost",
      (s) => {
        s.connectors.secureMcp.challenge = null;
      },
    ],
    [
      "workspace grant changed",
      (s) => {
        s.computer.generation++;
      },
    ],
    [
      "already settled",
      (s) => {
        s.setup.connect.outcomeUnknown = false;
      },
    ],
    [
      "pending flag lost",
      (s) => {
        s.connectors.secureMcp.appVerificationPending = false;
      },
    ],
  ];
  it.each(unsafe)("does not bypass %s", (_label, change) => {
    const { settings, expected } = pending();
    change(settings);
    expect(
      separateAppVerificationScopeCurrent(settings, expected, fixtureBuildId),
    ).toBe(false);
  });
});

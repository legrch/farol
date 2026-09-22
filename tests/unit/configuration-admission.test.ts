import { describe, expect, it } from "vitest";

import { configurationAdmission } from "../../src/apps/desktop/configuration-admission";

const computerAuthorityCommands = [
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-commands",
  "dev-proof.prepare",
] as const;

describe("AUTH-07 Computer authority while a native Agent runs", () => {
  it("refuses every authority change and re-verification during a running Agent", () => {
    for (const kind of [
      ...computerAuthorityCommands,
      "computer.verify-workspace",
    ]) {
      expect(
        configurationAdmission(kind, {
          agentActive: true,
          connectorRunning: false,
        }),
      ).toBe("CODEX_HOST_TASK_IN_PROGRESS");
    }
  });

  it("admits the same revocation once the owner has stopped the Agent", () => {
    for (const kind of computerAuthorityCommands) {
      expect(
        configurationAdmission(kind, {
          agentActive: false,
          connectorRunning: false,
        }),
      ).toBe("admitted");
    }
  });

  it("keeps unrelated preferences available while an Agent runs", () => {
    expect(
      configurationAdmission("general.update", {
        agentActive: true,
        connectorRunning: true,
      }),
    ).toBe("admitted");
    expect(
      configurationAdmission("dev-proof.run", {
        agentActive: true,
        connectorRunning: true,
      }),
    ).toBe("admitted");
  });

  it("asks for the connector to stop before changing the authority it carries", () => {
    for (const kind of computerAuthorityCommands) {
      expect(
        configurationAdmission(kind, {
          agentActive: false,
          connectorRunning: true,
        }),
      ).toBe("CONNECTOR_STOP_REQUIRED");
    }
    // Re-verification records a new root identity and replaces the linked
    // Git metadata grant, both of which a running connector carries.
    expect(
      configurationAdmission("computer.verify-workspace", {
        agentActive: false,
        connectorRunning: true,
      }),
    ).toBe("CONNECTOR_STOP_REQUIRED");
  });
});

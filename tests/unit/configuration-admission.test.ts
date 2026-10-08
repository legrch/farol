import { describe, expect, it } from "vitest";

import {
  changesComputerAuthority,
  configurationAdmission,
  isDrainedWorkspaceChange,
  workspaceConfigurationRoute,
} from "../../src/apps/desktop/configuration-admission";

const computerAuthorityCommands = [
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-git-history",
  "computer.update-commands",
  "computer.update-file-policy",
  "dev-proof.prepare",
  "host.configure-codex-tasks",
  "host.clear-codex-tasks",
] as const;

describe("AUTH-07 Computer authority while a native Agent runs", () => {
  it("refuses retained stop uncertainty independently of connector child liveness", () => {
    expect(workspaceConfigurationRoute(true, true)).toBe("unconfirmed");
    expect(workspaceConfigurationRoute(true, false)).toBe("unconfirmed");
    expect(workspaceConfigurationRoute(false, true)).toBe("drain");
    expect(workspaceConfigurationRoute(false, false)).toBe("configure-stopped");
  });
  it("selects only the three workspace changes for an existing admitted host drain", () => {
    const changes = [
      "computer.add-workspace",
      "computer.remove-workspace",
      "computer.update-access",
    ];
    for (const kind of changes) {
      expect(isDrainedWorkspaceChange(kind)).toBe(true);
      expect(
        configurationAdmission(kind, {
          agentActive: false,
          connectorRunning: true,
          workspaceDrainAvailable: true,
        }),
      ).toBe("admitted");
      expect(
        configurationAdmission(kind, {
          agentActive: true,
          connectorRunning: true,
          workspaceDrainAvailable: true,
        }),
      ).toBe("CODEX_HOST_TASK_IN_PROGRESS");
    }
    for (const kind of computerAuthorityCommands.filter(
      (candidate) => !changes.includes(candidate),
    )) {
      expect(isDrainedWorkspaceChange(kind)).toBe(false);
      expect(
        configurationAdmission(kind, {
          agentActive: false,
          connectorRunning: true,
          workspaceDrainAvailable: true,
        }),
      ).toBe("CONNECTOR_STOP_REQUIRED");
    }
  });

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
    for (const kind of [
      "host.select-codex",
      "host.select-discovered-codex",
      "host.verify-codex",
      "host.remove-codex",
    ]) {
      expect(
        configurationAdmission(kind, {
          agentActive: false,
          connectorRunning: true,
        }),
      ).toBe("CONNECTOR_STOP_REQUIRED");
      expect(changesComputerAuthority(kind)).toBe(true);
    }
    expect(
      configurationAdmission("host.discover-codex", {
        agentActive: false,
        connectorRunning: true,
      }),
    ).toBe("admitted");
    expect(changesComputerAuthority("host.discover-codex")).toBe(false);
  });
});

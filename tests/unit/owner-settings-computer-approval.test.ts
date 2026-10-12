import { describe, expect, it } from "vitest";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";
import { guidedSettingsFixture } from "../fixtures/guided-onboarding";

// Value-only readiness projection. Saved fixtures do not establish native,
// filesystem, connector or live-provider acceptance.
function settings(filePolicy: ProductSettings["computer"]["filePolicy"]) {
  const value = guidedSettingsFixture();
  value.computer.commands = "workspace";
  if (filePolicy !== undefined) value.computer.filePolicy = filePolicy;
  const workspace = value.computer.workspaces[0]!;
  workspace.access = "write";
  workspace.excludedPaths = [`${workspace.root}/private`];
  workspace.gitHistoryApproved = true;
  workspace.gitMetadata = {
    gitDirectory: `${workspace.root}/.git`,
    commonDirectory: `${workspace.root}/.git`,
  };
  return value;
}

const ordinaryCapabilities = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "verification.run",
  "workspace.write",
];

describe("owner settings Computer approval readiness", () => {
  it.each([undefined, ""] as const)(
    "keeps exact legacy policy %s without advertising shell",
    (filePolicy) => {
      const value = settings(filePolicy);
      const before = structuredClone(value);
      const approval = ownerSettingsComputerApproval(value, 1_000);
      expect(approval.capabilities).toEqual(ordinaryCapabilities);
      expect(approval.commands).toBe("verification");
      expect(approval.workspaces[0]!.shellVerified).toBe(false);
      expect(approval).not.toHaveProperty("filePolicy");
      expect(value).toEqual(before);
      const roots = ownerSettingsComputerApproval(
        settings("approved-roots-v1"),
        1_000,
      );
      const { filePolicy: _policy, ...rootPolicy } = roots;
      expect(approval).toEqual({
        ...rootPolicy,
        commands: "verification",
        capabilities: ordinaryCapabilities,
        workspaces: rootPolicy.workspaces.map((workspace) => ({
          ...workspace,
          shellVerified: false,
        })),
      });
    },
  );

  it("advertises shell for the exact root policy and fresh saved evidence", () => {
    const value = settings("approved-roots-v1");
    const approval = ownerSettingsComputerApproval(value, 1_000);
    expect(approval.filePolicy).toBe("approved-roots-v1");
    expect(approval.commands).toBe("workspace");
    expect(approval.capabilities).toEqual([
      ...ordinaryCapabilities.slice(0, 4),
      "workspace.shell",
      "workspace.write",
    ]);
    expect(approval.workspaces[0]).toEqual({
      workspaceId: value.computer.workspaces[0]!.workspaceId,
      root: value.computer.workspaces[0]!.root,
      access: "write",
      rootIdentity: { device: "1", inode: "2" },
      gitHistoryApproved: true,
      gitMetadata: value.computer.workspaces[0]!.gitMetadata,
      shellVerified: true,
    });
    expect(approval.excludedPaths).toEqual([
      {
        workspaceId: value.computer.workspaces[0]!.workspaceId,
        path: value.computer.workspaces[0]!.excludedPaths[0],
      },
    ]);
    expect(approval.network).toBe("none");
  });

  it.each([
    [
      "unreachable",
      (value: ProductSettings) => {
        value.setup.computer.reachable = "unreachable";
      },
    ],
    [
      "outcome unknown",
      (value: ProductSettings) => {
        value.setup.computer.outcomeUnknown = true;
      },
    ],
    [
      "missing verification",
      (value: ProductSettings) => {
        value.setup.computer.verified = null;
      },
    ],
    [
      "old generation",
      (value: ProductSettings) => {
        value.computer.generation++;
      },
    ],
    [
      "old access generation",
      (value: ProductSettings) => {
        value.computer.workspaces[0]!.accessCheck!.computerGeneration++;
      },
    ],
    [
      "different build",
      (value: ProductSettings) => {
        value.computer.workspaces[0]!.accessCheck!.buildId = "f".repeat(64);
      },
    ],
    [
      "changed device",
      (value: ProductSettings) => {
        value.computer.workspaces[0]!.rootIdentity!.device = "replacement";
      },
    ],
    [
      "changed inode",
      (value: ProductSettings) => {
        value.computer.workspaces[0]!.rootIdentity!.inode = "replacement";
      },
    ],
    [
      "missing access evidence",
      (value: ProductSettings) => {
        value.computer.workspaces[0]!.accessCheck = null;
      },
    ],
  ] as const)("keeps shell unavailable with %s", (_name, change) => {
    const value = settings("approved-roots-v1");
    change(value);
    const approval = ownerSettingsComputerApproval(value, 1_000);
    expect(approval.capabilities).toEqual(ordinaryCapabilities);
    expect(approval.commands).toBe("verification");
    expect(approval.workspaces[0]!.shellVerified).toBe(false);
  });

  it.each([undefined, "", "approved-roots-v1"] as const)(
    "retains a selected root and unverified second root under policy %s",
    (filePolicy) => {
      const value = settings(filePolicy);
      const first = value.computer.workspaces[0]!;
      const second = {
        ...first,
        workspaceId: "00000000-0000-4000-8000-000000000003",
        root: "/synthetic/second",
        rootIdentity: { device: "1", inode: "3" },
        access: "read" as const,
        accessCheck: null,
        gitHistoryApproved: false,
        gitMetadata: {
          gitDirectory: "/synthetic/second/.git",
          commonDirectory: "/synthetic/second/.git",
        },
        excludedPaths: ["/synthetic/second/private"],
      };
      value.computer.workspaces.push(second);
      const before = structuredClone(value);
      const approval = ownerSettingsComputerApproval(value, 1_000);
      expect(approval.workspaces.map((workspace) => workspace.root)).toEqual([
        first.root,
        second.root,
      ]);
      expect(
        approval.workspaces.map((workspace) => workspace.shellVerified),
      ).toEqual([filePolicy === "approved-roots-v1", false]);
      expect(approval.workspaces[1]).toEqual({
        workspaceId: second.workspaceId,
        root: second.root,
        rootIdentity: second.rootIdentity,
        access: second.access,
        gitHistoryApproved: false,
        gitMetadata: second.gitMetadata,
        shellVerified: false,
      });
      expect(approval.excludedPaths).toContainEqual({
        workspaceId: second.workspaceId,
        path: second.excludedPaths[0],
      });
      expect(approval.capabilities).toEqual(
        filePolicy === "approved-roots-v1"
          ? [
              ...ordinaryCapabilities.slice(0, 4),
              "workspace.shell",
              "workspace.write",
            ]
          : ordinaryCapabilities,
      );
      expect(value).toEqual(before);
    },
  );

  it.each(["none", "verification"] as const)(
    "preserves the %s command grant",
    (commands) => {
      const value = settings("approved-roots-v1");
      value.computer.commands = commands;
      const approval = ownerSettingsComputerApproval(value, 1_000);
      expect(approval.commands).toBe(commands);
      expect(approval.capabilities).not.toContain("workspace.shell");
      expect(approval.capabilities.includes("verification.run")).toBe(
        commands === "verification",
      );
      expect(approval.capabilities).toContain("workspace.write");
    },
  );
});

import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  computerCommandsUnchanged,
  computerFilePolicyUnchanged,
  withComputerCommands,
  withComputerFilePolicy,
  withComputerRenamed,
  type ComputerCommands,
  type ComputerFilePolicy,
} from "./machine";

const uuid = "12345678-1234-4234-8234-123456789abc";
const other = "22345678-1234-4234-8234-123456789abc";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";

type Workspace = ProductSettings["computer"]["workspaces"][number];

const folderA = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: uuid,
  root: "/fixture/alpha",
  label: "Alpha",
  access: "read",
  excludedPaths: [],
  rootIdentity: { device: "1", inode: "2" },
  gitHistoryApproved: true,
  ...overrides,
});

const folderB = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: other,
  root: "/fixture/beta",
  label: "Beta",
  access: "write",
  excludedPaths: [],
  rootIdentity: { device: "1", inode: "3" },
  ...overrides,
});

// A Computer that was verified and reachable, so a transform has something to
// withdraw. `computer` overrides apply on top of the defaults.
function settingsWith(
  workspaces: Workspace[],
  computer: Partial<ProductSettings["computer"]> = {},
  setupComputer: Partial<ProductSettings["setup"]["computer"]> = {},
): ProductSettings {
  const base = defaultSettings(() => uuid);
  return ProductSettingsSchema.parse({
    ...base,
    computer: { ...base.computer, ...computer, workspaces },
    setup: {
      ...base.setup,
      computer: {
        ...base.setup.computer,
        configured: workspaces.length > 0,
        reachable: "reachable",
        outcomeUnknown: true,
        unavailable: "Computer is unavailable.",
        verified: {
          profile: "computer/1",
          configRevision: 1,
          workspaceId: workspaces[0]?.workspaceId ?? null,
          runtimeGeneration: "runtime-1",
          buildId: sha("a"),
          protocol: "computer/v1",
          verifiedAt: NOW,
        },
        ...setupComputer,
      },
    },
  });
}

const valid = (settings: ProductSettings) =>
  ProductSettingsSchema.parse(settings);

describe("computer rename transform", () => {
  it("renames, bumps both counters and withdraws verification when a folder exists", () => {
    const before = settingsWith([folderA(), folderB()]);
    const next = withComputerRenamed(before, "Studio Mac");
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
    expect(next.computer.name).toBe("Studio Mac");
    expect(next.computer.workspaces).toBe(before.computer.workspaces);
    expect(next.computer.commands).toBe(before.computer.commands);
    expect(next.setup.computer).toMatchObject({
      reachable: "unknown",
      verified: null,
      needsAction: "Verify read access after changing This Mac.",
      outcomeUnknown: false,
    });
    valid(next);
  });

  it("asks for a first read-only workspace when none is approved", () => {
    const next = withComputerRenamed(settingsWith([]), "Studio Mac");
    expect(next.setup.computer.needsAction).toBe("Add a read-only workspace.");
    valid(next);
  });

  it("leaves what rename does not own untouched", () => {
    const before = settingsWith([folderA()], { commands: "workspace" });
    const next = withComputerRenamed(before, "Studio Mac");
    expect(next.setup.computer.configured).toBe(
      before.setup.computer.configured,
    );
    expect(next.setup.computer.unavailable).toBe(
      before.setup.computer.unavailable,
    );
    expect(next.computer.commands).toBe("workspace");
    expect(next.general).toBe(before.general);
    expect(next.connectors).toBe(before.connectors);
  });

  it("does not mutate its input", () => {
    const before = settingsWith([folderA()]);
    const frozen = structuredClone(before);
    withComputerRenamed(before, "Studio Mac");
    expect(before).toEqual(frozen);
  });

  it("is not a no-op for the same name", () => {
    const before = settingsWith([folderA()]);
    const next = withComputerRenamed(before, before.computer.name);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
  });
});

describe("computer commands transform", () => {
  it.each<[ComputerCommands, ComputerCommands, boolean]>([
    ["none", "none", true],
    ["verification", "verification", true],
    ["workspace", "workspace", true],
    ["none", "verification", false],
    ["verification", "workspace", false],
    ["workspace", "none", false],
  ])("from %s to %s reports unchanged=%s", (from, to, unchanged) => {
    expect(
      computerCommandsUnchanged(settingsWith([], { commands: from }), to),
    ).toBe(unchanged);
  });

  it.each<ComputerCommands>(["none", "verification", "workspace"])(
    "grants %s, bumps both counters and withdraws verification",
    (commands) => {
      const from: ComputerCommands = commands === "none" ? "workspace" : "none";
      const before = settingsWith([folderA(), folderB()], { commands: from });
      const next = withComputerCommands(before, commands);
      expect(next.revision).toBe(before.revision + 1);
      expect(next.computer.generation).toBe(before.computer.generation + 1);
      expect(next.computer.commands).toBe(commands);
      expect(next.setup.computer).toMatchObject({
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction:
          "Verify workspace access after changing command authority.",
        unavailable: null,
        outcomeUnknown: false,
      });
      valid(next);
    },
  );

  it("withdraws Git history approval from every folder and keeps the rest", () => {
    const before = settingsWith([
      folderA({ gitHistoryApproved: true }),
      folderB({ gitHistoryApproved: true, excludedPaths: ["/fixture/beta/x"] }),
    ]);
    const next = withComputerCommands(before, "workspace");
    expect(next.computer.workspaces).toEqual([
      { ...folderA(), gitHistoryApproved: false },
      {
        ...folderB(),
        excludedPaths: ["/fixture/beta/x"],
        gitHistoryApproved: false,
      },
    ]);
    expect(next.computer.workspaces[0]).not.toBe(before.computer.workspaces[0]);
    valid(next);
  });

  it("writes an explicit false for a folder that had no Git history field", () => {
    const next = withComputerCommands(settingsWith([folderB()]), "workspace");
    expect(next.computer.workspaces[0]?.gitHistoryApproved).toBe(false);
  });

  it("asks for a first read-only workspace when none is approved", () => {
    const next = withComputerCommands(settingsWith([]), "verification");
    expect(next.computer.workspaces).toEqual([]);
    expect(next.setup.computer).toMatchObject({
      configured: false,
      needsAction: "Add a read-only workspace.",
    });
    valid(next);
  });

  it("does not mutate its input", () => {
    const before = settingsWith([folderA()]);
    const frozen = structuredClone(before);
    withComputerCommands(before, "workspace");
    expect(before).toEqual(frozen);
  });
});

describe("computer file policy transform", () => {
  it.each<[ComputerFilePolicy | undefined, ComputerFilePolicy, boolean]>([
    [undefined, "", true],
    ["", "", true],
    ["approved-roots-v1", "approved-roots-v1", true],
    [undefined, "approved-roots-v1", false],
    ["", "approved-roots-v1", false],
    ["approved-roots-v1", "", false],
  ])("from %s to %s reports unchanged=%s", (from, to, unchanged) => {
    const base = settingsWith([]);
    const computer: ProductSettings["computer"] = { ...base.computer };
    if (from === undefined) delete computer.filePolicy;
    else computer.filePolicy = from;
    expect(computerFilePolicyUnchanged({ ...base, computer }, to)).toBe(
      unchanged,
    );
  });

  it.each<ComputerFilePolicy>(["", "approved-roots-v1"])(
    "records %j, bumps both counters and withdraws verification",
    (policy) => {
      const before = settingsWith([folderA(), folderB()]);
      const next = withComputerFilePolicy(before, policy);
      expect(next.revision).toBe(before.revision + 1);
      expect(next.computer.generation).toBe(before.computer.generation + 1);
      expect(next.computer.filePolicy).toBe(policy);
      expect(next.setup.computer).toMatchObject({
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction: "Verify folder access after changing file permissions.",
        unavailable: null,
        outcomeUnknown: false,
      });
      valid(next);
    },
  );

  it("leaves the folders and command authority as they were", () => {
    const before = settingsWith([folderA(), folderB()], {
      commands: "workspace",
    });
    const next = withComputerFilePolicy(before, "approved-roots-v1");
    expect(next.computer.workspaces).toBe(before.computer.workspaces);
    expect(next.computer.commands).toBe("workspace");
  });

  it("asks for a first folder when none is approved", () => {
    const next = withComputerFilePolicy(settingsWith([]), "approved-roots-v1");
    expect(next.setup.computer).toMatchObject({
      configured: false,
      needsAction: "Add a folder.",
    });
    valid(next);
  });

  it("does not mutate its input", () => {
    const before = settingsWith([folderA()]);
    const frozen = structuredClone(before);
    withComputerFilePolicy(before, "approved-roots-v1");
    expect(before).toEqual(frozen);
  });
});

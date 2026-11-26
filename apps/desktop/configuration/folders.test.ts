import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  ProductSettingsSchema,
  type ProductSettings,
  type WorkspaceRootIdentity,
} from "../../../src/pkg/product-settings/contract";
import {
  WORKSPACE_DRIFT_NEEDS_ACTION,
  verificationInputSchema,
  workspaceCheckEvidence,
  workspaceInputSchema,
} from "./input";
import {
  driftedWorkspaceRefusal,
  driftedWorkspaceWithdrawn,
  folderAccessCheckRefusal,
  withComputerMutationOutcomeUnknown,
  withDriftedWorkspaceChecksWithdrawn,
  withFolderAccessCheck,
  withoutWorkspace,
  withWorkspace,
  withWorkspaceAccess,
  withWorkspaceExclusions,
  withWorkspaceGitHistory,
  withWorkspaceRootIdentity,
  withWorkspaceRootRebound,
  withWorkspaceVerification,
  workspaceApproved,
  workspaceGitHistoryGrantable,
  workspaceRootBindRefusal,
  workspaceRootRebindRefusal,
  workspaceRootRebindUnchanged,
  workspaceVerificationRefusal,
  type DriftedWorkspace,
} from "./folders";

const uuid = "12345678-1234-4234-8234-123456789abc";
const other = "22345678-1234-4234-8234-123456789abc";
const unknownId = "32345678-1234-4234-8234-123456789abc";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";
const LATER = "2026-11-26T11:00:00.000Z";
const LATEST = "2026-11-26T12:00:00.000Z";

const clock = (value = NOW) => vi.fn(() => value);

type Workspace = ProductSettings["computer"]["workspaces"][number];

const identity = (device = "1", inode = "2"): WorkspaceRootIdentity => ({
  device,
  inode,
});

const folderA = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: uuid,
  root: "/fixture/alpha",
  label: "Alpha",
  access: "read",
  excludedPaths: [],
  rootIdentity: identity("1", "2"),
  ...overrides,
});

const folderB = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: other,
  root: "/fixture/beta",
  label: "Beta",
  access: "write",
  excludedPaths: ["/fixture/beta/cache"],
  rootIdentity: identity("1", "3"),
  gitHistoryApproved: true,
  ...overrides,
});

const checkRecord = (overrides: Record<string, unknown> = {}) => ({
  checkId: uuid,
  buildId: sha("a"),
  computerGeneration: 1,
  verifiedAt: NOW,
  rootIdentity: identity("1", "2"),
  ...overrides,
});

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
      computer: { ...base.setup.computer, ...setupComputer },
    },
  });
}

const verifiedFor = (
  workspaceId: string,
  configRevision: number,
): ProductSettings["setup"]["computer"]["verified"] => ({
  profile: "computer/1",
  configRevision,
  workspaceId,
  runtimeGeneration: "runtime-1",
  buildId: sha("a"),
  protocol: "computer/v1",
  verifiedAt: NOW,
});

// Two approved folders at generation 1, Computer verified for alpha.
function verifiedPair(): ProductSettings {
  const base = settingsWith([folderA(), folderB()]);
  return settingsWith(
    [folderA(), folderB()],
    {},
    {
      configured: true,
      reachable: "reachable",
      verified: verifiedFor(uuid, base.computer.generation),
    },
  );
}

const valid = (settings: ProductSettings) =>
  ProductSettingsSchema.parse(settings);

const workspaceOf = (settings: ProductSettings, workspaceId = uuid) =>
  settings.computer.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  ) as Workspace;

const verificationInput = (overrides: Record<string, unknown> = {}) =>
  verificationInputSchema.parse({
    profile: "computer/1",
    runtimeGeneration: "runtime-2",
    buildId: sha("b"),
    protocol: "computer/v1",
    ...overrides,
  });

describe("workspace approval transform", () => {
  it("adds a read folder, bumps both counters and asks for an access check", () => {
    const id = vi.fn(() => other);
    const before = settingsWith([folderA()]);
    const next = withWorkspace(
      before,
      workspaceInputSchema.parse({
        root: "/fixture/beta",
        label: "  Beta  ",
        rootIdentity: identity("1", "3"),
      }),
      "read",
      id,
    );
    expect(id).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
    expect(next.computer.workspaces).toEqual([
      folderA(),
      {
        workspaceId: other,
        root: "/fixture/beta",
        label: "Beta",
        access: "read",
        excludedPaths: [],
        rootIdentity: identity("1", "3"),
      },
    ]);
    expect(next.computer.workspaces[0]).toBe(before.computer.workspaces[0]);
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Check access to this workspace.",
      outcomeUnknown: false,
    });
    valid(next);
  });

  it("records write access and leaves the identity out until one is measured", () => {
    const next = withWorkspace(
      settingsWith([]),
      workspaceInputSchema.parse({ root: "/fixture/beta", label: "Beta" }),
      "write",
      () => other,
    );
    const added = workspaceOf(next, other);
    expect(added.access).toBe("write");
    expect("rootIdentity" in added).toBe(false);
    expect(added.excludedPaths).toEqual([]);
  });

  it("is a no-op for a root already approved, without asking for an id", () => {
    const id = vi.fn(() => other);
    const before = settingsWith([folderA()]);
    const input = workspaceInputSchema.parse({
      root: "/fixture/alpha",
      label: "Renamed",
    });
    expect(withWorkspace(before, input, "write", id)).toBe(before);
    expect(id).not.toHaveBeenCalled();
  });

  it("answers whether a folder is approved by its own id", () => {
    const settings = settingsWith([folderA(), folderB()]);
    expect(workspaceApproved(settings, uuid)).toBe(true);
    expect(workspaceApproved(settings, other)).toBe(true);
    expect(workspaceApproved(settings, unknownId)).toBe(false);
  });
});

describe("workspace removal transform", () => {
  it("removes only the named folder and keeps the others configured", () => {
    const before = verifiedPair();
    const next = withoutWorkspace(before, uuid);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
    expect(next.computer.workspaces).toEqual([folderB()]);
    expect(next.computer.workspaces[0]).toBe(before.computer.workspaces[1]);
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify read access to an approved workspace.",
      outcomeUnknown: false,
    });
    valid(next);
  });

  it("marks the step unconfigured when the last folder goes", () => {
    const next = withoutWorkspace(settingsWith([folderA()]), uuid);
    expect(next.computer.workspaces).toEqual([]);
    expect(next.setup.computer).toMatchObject({
      configured: false,
      needsAction: "Add a read-only workspace.",
    });
  });

  it("changes no other folder when the id is unknown", () => {
    const before = settingsWith([folderA(), folderB()]);
    const next = withoutWorkspace(before, unknownId);
    expect(next.computer.workspaces).toEqual(before.computer.workspaces);
  });
});

describe("workspace exclusions transform", () => {
  it("replaces the list and withdraws Git history for that folder only", () => {
    const before = settingsWith([
      folderA({ gitHistoryApproved: true }),
      folderB(),
    ]);
    const next = withWorkspaceExclusions(before, uuid, ["/fixture/alpha/tmp"]);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
    expect(workspaceOf(next)).toMatchObject({
      excludedPaths: ["/fixture/alpha/tmp"],
      gitHistoryApproved: false,
    });
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(workspaceOf(next, other).gitHistoryApproved).toBe(true);
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify read access after changing exclusions.",
      unavailable: null,
      outcomeUnknown: false,
    });
    valid(next);
  });

  it("is a no-op for the same exclusions in the same order", () => {
    const before = settingsWith([
      folderA({ excludedPaths: ["/fixture/alpha/a", "/fixture/alpha/b"] }),
    ]);
    expect(
      withWorkspaceExclusions(before, uuid, [
        "/fixture/alpha/a",
        "/fixture/alpha/b",
      ]),
    ).toBe(before);
  });

  it("treats a reordered list as a change", () => {
    const before = settingsWith([
      folderA({ excludedPaths: ["/fixture/alpha/a", "/fixture/alpha/b"] }),
    ]);
    const next = withWorkspaceExclusions(before, uuid, [
      "/fixture/alpha/b",
      "/fixture/alpha/a",
    ]);
    expect(next).not.toBe(before);
    expect(workspaceOf(next).excludedPaths).toEqual([
      "/fixture/alpha/b",
      "/fixture/alpha/a",
    ]);
  });

  it("clears the exclusions of a folder that has some", () => {
    const before = settingsWith([folderB()]);
    const next = withWorkspaceExclusions(before, other, []);
    expect(workspaceOf(next, other).excludedPaths).toEqual([]);
  });
});

describe("workspace access transform", () => {
  it("sets the access and withdraws Git history for that folder only", () => {
    const before = settingsWith([
      folderA({ gitHistoryApproved: true }),
      folderB(),
    ]);
    const next = withWorkspaceAccess(before, uuid, "write");
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation + 1);
    expect(workspaceOf(next)).toMatchObject({
      access: "write",
      gitHistoryApproved: false,
    });
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify write access after changing workspace access.",
      unavailable: null,
      outcomeUnknown: false,
    });
    valid(next);
  });

  it("names the new access in the instruction", () => {
    const next = withWorkspaceAccess(settingsWith([folderB()]), other, "read");
    expect(workspaceOf(next, other).access).toBe("read");
    expect(next.setup.computer.needsAction).toBe(
      "Verify read access after changing workspace access.",
    );
  });
});

describe("workspace Git history transform", () => {
  const grantable = (): ProductSettings => {
    const base = settingsWith([folderA(), folderB()], {
      commands: "workspace",
    });
    return settingsWith(
      [folderA(), folderB()],
      { commands: "workspace" },
      {
        configured: true,
        reachable: "reachable",
        verified: verifiedFor(uuid, base.computer.generation),
      },
    );
  };

  it("grants Git history only for the verified, bound folder under workspace commands", () => {
    expect(workspaceGitHistoryGrantable(grantable(), uuid)).toBe(true);
  });

  it("refuses without workspace commands", () => {
    const base = settingsWith([folderA()], { commands: "verification" });
    const settings = settingsWith(
      [folderA()],
      { commands: "verification" },
      { verified: verifiedFor(uuid, base.computer.generation) },
    );
    expect(workspaceGitHistoryGrantable(settings, uuid)).toBe(false);
  });

  it("refuses an unbound folder", () => {
    const unbound = folderA();
    delete unbound.rootIdentity;
    const settings = settingsWith(
      [unbound],
      { commands: "workspace" },
      { verified: verifiedFor(uuid, 1) },
    );
    expect(workspaceGitHistoryGrantable(settings, uuid)).toBe(false);
  });

  it("refuses a folder the Computer step did not verify", () => {
    expect(workspaceGitHistoryGrantable(grantable(), other)).toBe(false);
  });

  it("refuses a verification of an older approval generation", () => {
    const settings = settingsWith(
      [folderA()],
      { commands: "workspace", generation: 3 },
      { verified: verifiedFor(uuid, 2) },
    );
    expect(workspaceGitHistoryGrantable(settings, uuid)).toBe(false);
  });

  it("refuses when nothing is verified or the folder is unknown", () => {
    const settings = settingsWith([folderA()], { commands: "workspace" });
    expect(workspaceGitHistoryGrantable(settings, uuid)).toBe(false);
    expect(workspaceGitHistoryGrantable(grantable(), unknownId)).toBe(false);
  });

  it("grants and withdraws for the named folder only", () => {
    const before = grantable();
    const granted = withWorkspaceGitHistory(before, uuid, true);
    expect(granted.revision).toBe(before.revision + 1);
    expect(granted.computer.generation).toBe(before.computer.generation + 1);
    expect(workspaceOf(granted).gitHistoryApproved).toBe(true);
    expect(workspaceOf(granted, other)).toBe(workspaceOf(before, other));
    expect(granted.setup.computer).toMatchObject({
      reachable: "unknown",
      verified: null,
      needsAction:
        "Verify workspace access after changing Git history authority.",
      outcomeUnknown: false,
    });
    const withdrawn = withWorkspaceGitHistory(granted, uuid, false);
    expect(workspaceOf(withdrawn).gitHistoryApproved).toBe(false);
    valid(withdrawn);
  });
});

describe("folder access check transform", () => {
  const checked = (
    overrides: Partial<Parameters<typeof withFolderAccessCheck>[1]> = {},
  ) => ({
    workspaceId: uuid,
    expectedGeneration: 1,
    buildId: sha("a"),
    rootIdentity: identity("9", "9"),
    success: true,
    ...overrides,
  });

  it("refuses an unknown folder before anything else", () => {
    expect(
      folderAccessCheckRefusal(settingsWith([folderA()]), unknownId, 99),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  it("refuses a stale approval generation", () => {
    expect(folderAccessCheckRefusal(settingsWith([folderA()]), uuid, 2)).toBe(
      "WORKSPACE_ROOT_CHANGED",
    );
  });

  it("refuses an unbound folder", () => {
    const unbound = folderA();
    delete unbound.rootIdentity;
    expect(folderAccessCheckRefusal(settingsWith([unbound]), uuid, 1)).toBe(
      "WORKSPACE_ROOT_CHANGED",
    );
  });

  it("admits a bound folder at the current generation", () => {
    expect(
      folderAccessCheckRefusal(settingsWith([folderA()]), uuid, 1),
    ).toBeNull();
  });

  it("records a successful check keyed to the saved pair and reads the clock once", () => {
    const now = clock(LATER);
    const before = settingsWith([folderA(), folderB()]);
    const next = withFolderAccessCheck(
      before,
      checked({ checkId: other }),
      now,
    );
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation);
    expect(workspaceOf(next).accessCheck).toEqual({
      checkId: other,
      buildId: sha("a"),
      computerGeneration: 1,
      verifiedAt: LATER,
      rootIdentity: identity("1", "2"),
    });
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(next.setup).toBe(before.setup);
    valid(next);
  });

  it("falls back to the measured pair for a folder that has none", () => {
    const unbound = folderA();
    delete unbound.rootIdentity;
    const next = withFolderAccessCheck(
      settingsWith([unbound]),
      checked(),
      clock(),
    );
    expect(workspaceOf(next).accessCheck?.rootIdentity).toEqual(
      identity("9", "9"),
    );
  });

  it("leaves the check id out when none was issued", () => {
    const next = withFolderAccessCheck(
      settingsWith([folderA()]),
      checked(),
      clock(),
    );
    expect("checkId" in (workspaceOf(next).accessCheck ?? {})).toBe(false);
  });

  it("sets the writable-by-others flag only when reported", () => {
    const flagged = withFolderAccessCheck(
      settingsWith([folderA()]),
      checked({ writableByOthers: true }),
      clock(),
    );
    expect(workspaceOf(flagged).accessCheck?.writableByOthers).toBe(true);
    const plain = withFolderAccessCheck(
      settingsWith([folderA()]),
      checked({ writableByOthers: undefined }),
      clock(),
    );
    expect("writableByOthers" in (workspaceOf(plain).accessCheck ?? {})).toBe(
      false,
    );
  });

  it("rebuilds the check on every run so a later clean check clears the flag", () => {
    const before = settingsWith([
      folderA({ accessCheck: checkRecord({ writableByOthers: true }) }),
    ]);
    const next = withFolderAccessCheck(
      before,
      checked({ checkId: undefined }),
      clock(LATEST),
    );
    expect(workspaceOf(next).accessCheck).toEqual({
      buildId: sha("a"),
      computerGeneration: 1,
      verifiedAt: LATEST,
      rootIdentity: identity("1", "2"),
    });
  });

  it("records a failed check as none, without reading the clock", () => {
    const now = clock();
    const before = settingsWith([
      folderA({ accessCheck: checkRecord({ writableByOthers: true }) }),
      folderB({
        accessCheck: checkRecord({ rootIdentity: identity("1", "3") }),
      }),
    ]);
    const next = withFolderAccessCheck(
      before,
      checked({ success: false, writableByOthers: true }),
      now,
    );
    expect(now).not.toHaveBeenCalled();
    expect(workspaceOf(next).accessCheck).toBeNull();
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(workspaceOf(next, other).accessCheck).not.toBeNull();
  });
});

describe("workspace root identity binding", () => {
  it("refuses an unknown folder", () => {
    expect(
      workspaceRootBindRefusal(
        settingsWith([folderA()]),
        unknownId,
        1,
        "/fixture/alpha",
      ),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  it("refuses a moved revision, a different root and a folder already bound", () => {
    const unbound = folderA();
    delete unbound.rootIdentity;
    const settings = settingsWith([unbound]);
    expect(
      workspaceRootBindRefusal(
        settings,
        uuid,
        settings.revision + 1,
        "/fixture/alpha",
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      workspaceRootBindRefusal(
        settings,
        uuid,
        settings.revision,
        "/fixture/elsewhere",
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    const bound = settingsWith([folderA()]);
    expect(
      workspaceRootBindRefusal(bound, uuid, bound.revision, "/fixture/alpha"),
    ).toBe("WORKSPACE_ROOT_CHANGED");
  });

  it("admits an unbound folder at the measured revision and root", () => {
    const unbound = folderA();
    delete unbound.rootIdentity;
    const settings = settingsWith([unbound]);
    expect(
      workspaceRootBindRefusal(
        settings,
        uuid,
        settings.revision,
        "/fixture/alpha",
      ),
    ).toBeNull();
  });

  it("binds a copy of the identity and withdraws the folder's check", () => {
    const measured = identity("7", "8");
    const before = settingsWith([
      folderA({ accessCheck: checkRecord() }),
      folderB({
        accessCheck: checkRecord({ rootIdentity: identity("1", "3") }),
      }),
    ]);
    const next = withWorkspaceRootIdentity(before, uuid, measured);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation);
    expect(workspaceOf(next).rootIdentity).toEqual(measured);
    expect(workspaceOf(next).rootIdentity).not.toBe(measured);
    expect(workspaceOf(next).accessCheck).toBeNull();
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(next.setup).toBe(before.setup);
    valid(next);
  });
});

describe("workspace root identity rebinding", () => {
  const settings = () => settingsWith([folderA(), folderB()]);
  const rev = () => settings().revision;

  it("refuses an unknown folder", () => {
    expect(
      workspaceRootRebindRefusal(
        settings(),
        unknownId,
        rev(),
        "/fixture/alpha",
        identity(),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  it("refuses a moved revision, a different root, an unbound folder and another inode", () => {
    expect(
      workspaceRootRebindRefusal(
        settings(),
        uuid,
        rev() + 1,
        "/fixture/alpha",
        identity("5", "2"),
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      workspaceRootRebindRefusal(
        settings(),
        uuid,
        rev(),
        "/fixture/other",
        identity("5", "2"),
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    const unbound = folderA();
    delete unbound.rootIdentity;
    const bare = settingsWith([unbound]);
    expect(
      workspaceRootRebindRefusal(
        bare,
        uuid,
        bare.revision,
        "/fixture/alpha",
        identity("5", "2"),
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      workspaceRootRebindRefusal(
        settings(),
        uuid,
        rev(),
        "/fixture/alpha",
        identity("1", "99"),
      ),
    ).toBe("WORKSPACE_ROOT_CHANGED");
  });

  it("admits the same inode under a new device number", () => {
    expect(
      workspaceRootRebindRefusal(
        settings(),
        uuid,
        rev(),
        "/fixture/alpha",
        identity("5", "2"),
      ),
    ).toBeNull();
  });

  it("reports an identical pair as unchanged and anything else as changed", () => {
    expect(
      workspaceRootRebindUnchanged(settings(), uuid, identity("1", "2")),
    ).toBe(true);
    expect(
      workspaceRootRebindUnchanged(settings(), uuid, identity("5", "2")),
    ).toBe(false);
    expect(
      workspaceRootRebindUnchanged(settings(), unknownId, identity("1", "2")),
    ).toBe(false);
    const unbound = folderA();
    delete unbound.rootIdentity;
    expect(
      workspaceRootRebindUnchanged(
        settingsWith([unbound]),
        uuid,
        identity("1", "2"),
      ),
    ).toBe(false);
  });

  it("rebinds the device, withdraws the check and the Computer verification", () => {
    const before = settingsWith(
      [
        folderA({ accessCheck: checkRecord() }),
        folderB({
          accessCheck: checkRecord({ rootIdentity: identity("1", "3") }),
        }),
      ],
      {},
      {
        configured: true,
        reachable: "reachable",
        verified: verifiedFor(uuid, 1),
      },
    );
    const next = withWorkspaceRootRebound(before, uuid, identity("5", "2"));
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation);
    expect(workspaceOf(next).rootIdentity).toEqual(identity("5", "2"));
    expect(workspaceOf(next).accessCheck).toBeNull();
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    expect(next.setup.computer).toMatchObject({
      verified: null,
      needsAction: "Check this workspace's access again.",
      reachable: "unknown",
      configured: true,
    });
    valid(next);
  });
});

describe("workspace verification transform", () => {
  const unbound = (overrides: Partial<Workspace> = {}) => {
    const item = folderA(overrides);
    delete item.rootIdentity;
    return item;
  };

  it("refuses an unknown folder before any fence", () => {
    expect(
      workspaceVerificationRefusal(settingsWith([folderA()]), unknownId, {
        expectedGeneration: 99,
      }),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  it("refuses a moved generation or root only when the caller named them", () => {
    const settings = settingsWith([folderA()]);
    expect(
      workspaceVerificationRefusal(settings, uuid, { expectedGeneration: 2 }),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      workspaceVerificationRefusal(settings, uuid, {
        expectedRoot: "/fixture/other",
      }),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(workspaceVerificationRefusal(settings, uuid, {})).toBeNull();
    expect(
      workspaceVerificationRefusal(settings, uuid, {
        expectedGeneration: 1,
        expectedRoot: "/fixture/alpha",
      }),
    ).toBeNull();
  });

  it("keeps the saved pair, records the check and verifies the Computer step", () => {
    let calls = 0;
    const now = vi.fn(() => [LATER, LATEST][calls++] as string);
    const before = settingsWith([folderA(), folderB()]);
    const next = withWorkspaceVerification(
      before,
      uuid,
      verificationInput(),
      { rootIdentity: identity("9", "9"), checkId: other },
      now,
    );
    expect(now).toHaveBeenCalledTimes(2);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer.generation).toBe(before.computer.generation);
    expect(workspaceOf(next).rootIdentity).toEqual(identity("1", "2"));
    // The folder's check takes the first reading, the Computer step the second.
    expect(workspaceOf(next).accessCheck).toEqual({
      checkId: other,
      buildId: sha("b"),
      computerGeneration: 1,
      verifiedAt: LATER,
      rootIdentity: identity("1", "2"),
    });
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "computer/1",
        runtimeGeneration: "runtime-2",
        buildId: sha("b"),
        protocol: "computer/v1",
        configRevision: 1,
        workspaceId: uuid,
        verifiedAt: LATEST,
      },
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
    expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    valid(next);
  });

  it("binds an unbound folder to the measured pair", () => {
    const next = withWorkspaceVerification(
      settingsWith([unbound()]),
      uuid,
      verificationInput(),
      { rootIdentity: identity("9", "9") },
      clock(),
    );
    expect(workspaceOf(next).rootIdentity).toEqual(identity("9", "9"));
    expect(workspaceOf(next).accessCheck?.rootIdentity).toEqual(
      identity("9", "9"),
    );
  });

  it("sets the writable-by-others flag only when reported and rebuilds it each time", () => {
    const before = settingsWith([
      folderA({ accessCheck: checkRecord({ writableByOthers: true }) }),
    ]);
    const clean = withWorkspaceVerification(
      before,
      uuid,
      verificationInput(),
      { rootIdentity: identity() },
      clock(),
    );
    expect("writableByOthers" in (workspaceOf(clean).accessCheck ?? {})).toBe(
      false,
    );
    expect("checkId" in (workspaceOf(clean).accessCheck ?? {})).toBe(false);
    const flagged = withWorkspaceVerification(
      before,
      uuid,
      verificationInput(),
      { rootIdentity: identity(), writableByOthers: true },
      clock(),
    );
    expect(workspaceOf(flagged).accessCheck?.writableByOthers).toBe(true);
  });

  it("records the check at the current approval generation", () => {
    const next = withWorkspaceVerification(
      settingsWith([folderA()], { generation: 4 }),
      uuid,
      verificationInput(),
      { rootIdentity: identity() },
      clock(),
    );
    expect(workspaceOf(next).accessCheck?.computerGeneration).toBe(4);
    expect(next.setup.computer.verified?.configRevision).toBe(4);
  });

  describe("linked Git metadata", () => {
    const inRoot = {
      gitDirectory: "/fixture/alpha/.git",
      commonDirectory: "/fixture/alpha/.git",
    };
    const linked = {
      gitDirectory: "/fixture/main/.git/worktrees/alpha",
      commonDirectory: "/fixture/main/.git",
    };
    const verify = (
      before: ProductSettings,
      gitMetadata: Parameters<
        typeof withWorkspaceVerification
      >[3]["gitMetadata"],
    ) =>
      withWorkspaceVerification(
        before,
        uuid,
        verificationInput(),
        { rootIdentity: identity(), gitMetadata },
        clock(),
      );

    it("keeps the saved metadata and grant when none was observed", () => {
      const before = settingsWith([
        folderA({ gitMetadata: linked, gitHistoryApproved: true }),
      ]);
      const next = verify(before, undefined);
      expect(workspaceOf(next).gitMetadata).toEqual(linked);
      expect(workspaceOf(next).gitHistoryApproved).toBe(true);
    });

    it("clears the metadata and the grant when it now lives inside the root", () => {
      const before = settingsWith([
        folderA({ gitMetadata: linked, gitHistoryApproved: true }),
      ]);
      const next = verify(before, null);
      expect("gitMetadata" in workspaceOf(next)).toBe(false);
      expect(workspaceOf(next).gitHistoryApproved).toBe(false);
    });

    it("keeps the grant when the observation equals the saved metadata", () => {
      const before = settingsWith([
        folderA({ gitMetadata: linked, gitHistoryApproved: true }),
      ]);
      const next = verify(before, linked);
      expect(workspaceOf(next).gitMetadata).toEqual(linked);
      expect(workspaceOf(next).gitHistoryApproved).toBe(true);
    });

    it("withdraws the grant when the metadata changed", () => {
      const before = settingsWith([
        folderA({ gitMetadata: linked, gitHistoryApproved: true }),
      ]);
      const next = verify(before, inRoot);
      expect(workspaceOf(next).gitMetadata).toEqual(inRoot);
      expect(workspaceOf(next).gitHistoryApproved).toBe(false);
    });

    it("keeps an explicit grant for the first in-root measurement of a primary checkout", () => {
      const before = settingsWith([folderA({ gitHistoryApproved: true })]);
      const next = verify(before, inRoot);
      expect(workspaceOf(next).gitMetadata).toEqual(inRoot);
      expect(workspaceOf(next).gitHistoryApproved).toBe(true);
    });

    it("withdraws an explicit grant for a first linked layout", () => {
      const before = settingsWith([folderA({ gitHistoryApproved: true })]);
      const next = verify(before, linked);
      expect(workspaceOf(next).gitMetadata).toEqual(linked);
      expect(workspaceOf(next).gitHistoryApproved).toBe(false);
    });

    it("records an explicit denial for an ungranted folder's first measurement", () => {
      const before = settingsWith([folderA()]);
      const next = verify(before, inRoot);
      expect(workspaceOf(next).gitMetadata).toEqual(inRoot);
      expect(workspaceOf(next).gitHistoryApproved).toBe(false);
    });

    it("never touches the other folder's metadata or grant", () => {
      const before = settingsWith([
        folderA({ gitMetadata: linked, gitHistoryApproved: true }),
        folderB({ gitMetadata: linked }),
      ]);
      const next = verify(before, null);
      expect(workspaceOf(next, other)).toBe(workspaceOf(before, other));
    });
  });
});

describe("computer mutation outcome-unknown transform", () => {
  it("withdraws verification and fences the Computer step", () => {
    const before = verifiedPair();
    const next = withComputerMutationOutcomeUnknown(before);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.computer).toBe(before.computer);
    expect(next.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction:
        "Inspect the selected file, then verify workspace access again.",
      unavailable: null,
      outcomeUnknown: true,
    });
    valid(next);
  });
});

describe("workspace drift withdrawal", () => {
  const observation = (
    settings: ProductSettings,
    workspaceId = uuid,
    root = "/fixture/alpha",
    rootIdentity = identity("1", "2"),
  ): DriftedWorkspace => ({
    workspaceId,
    root,
    rootIdentity,
    observed: workspaceCheckEvidence(settings, workspaceId),
  });

  const secureMcpRuntime = (settings: ProductSettings): ProductSettings =>
    ProductSettingsSchema.parse({
      ...settings,
      connectors: {
        secureMcp: {
          ...settings.connectors.secureMcp,
          generation: 2,
          tunnelId: "tunnel-1",
          tunnelClient: {
            executablePath: "/fixture/bin/tunnel-client",
            executableSha256: sha("a"),
            version: "1.2.3",
            protocol: "openai-tunnel-client/v1",
            verifiedAt: NOW,
          },
          credential: "stored",
          runtime: {
            state: "ready",
            connectorGeneration: 2,
            runtimeGeneration: sha("1"),
            computerGeneration: settings.computer.generation,
            buildId: sha("2"),
            observedAt: NOW,
          },
        },
      },
    });

  it("admits an observation that still matches the folder and its evidence", () => {
    const settings = verifiedPair();
    expect(
      driftedWorkspaceRefusal(settings, [observation(settings)]),
    ).toBeNull();
  });

  it("refuses an unknown folder, another root, another pair and changed evidence", () => {
    const settings = verifiedPair();
    const seen = observation(settings);
    expect(
      driftedWorkspaceRefusal(settings, [{ ...seen, workspaceId: unknownId }]),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      driftedWorkspaceRefusal(settings, [{ ...seen, root: "/fixture/else" }]),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      driftedWorkspaceRefusal(settings, [
        { ...seen, rootIdentity: identity("9", "2") },
      ]),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    expect(
      driftedWorkspaceRefusal(settings, [
        { ...seen, rootIdentity: identity("1", "9") },
      ]),
    ).toBe("WORKSPACE_ROOT_CHANGED");
    // A newer successful check must not be erased by an older observation.
    const newer = withFolderAccessCheck(
      settings,
      {
        workspaceId: uuid,
        expectedGeneration: 1,
        buildId: sha("c"),
        rootIdentity: identity(),
        success: true,
      },
      clock(LATER),
    );
    expect(driftedWorkspaceRefusal(newer, [seen])).toBe(
      "WORKSPACE_ROOT_CHANGED",
    );
  });

  it("refuses the whole batch when any one folder no longer matches", () => {
    const settings = verifiedPair();
    const good = observation(settings);
    const bad = observation(
      settings,
      other,
      "/fixture/beta",
      identity("1", "9"),
    );
    expect(driftedWorkspaceRefusal(settings, [good, bad])).toBe(
      "WORKSPACE_ROOT_CHANGED",
    );
  });

  it("withdraws only the drifted folder's check and keeps its approval", () => {
    const before = verifiedPair();
    const checked = settingsWith(
      [
        folderA({ accessCheck: checkRecord() }),
        folderB({
          accessCheck: checkRecord({ rootIdentity: identity("1", "3") }),
        }),
      ],
      {},
      before.setup.computer,
    );
    const next = withDriftedWorkspaceChecksWithdrawn(checked, [
      observation(checked),
    ]);
    expect(next.revision).toBe(checked.revision + 1);
    expect(next.computer.generation).toBe(checked.computer.generation);
    expect(workspaceOf(next).accessCheck).toBeNull();
    expect(workspaceOf(next)).toMatchObject({
      workspaceId: uuid,
      root: "/fixture/alpha",
      rootIdentity: identity("1", "2"),
    });
    expect(workspaceOf(next, other)).toBe(workspaceOf(checked, other));
    expect(workspaceOf(next, other).accessCheck).not.toBeNull();
    expect(next.setup.computer).toMatchObject({
      verified: null,
      needsAction: WORKSPACE_DRIFT_NEEDS_ACTION,
      reachable: "unknown",
    });
    valid(next);
  });

  it("keeps a Computer verification that belongs to another folder", () => {
    const before = verifiedPair();
    const next = withDriftedWorkspaceChecksWithdrawn(before, [
      observation(before, other, "/fixture/beta", identity("1", "3")),
    ]);
    expect(next.setup.computer.verified).toEqual(
      before.setup.computer.verified,
    );
    expect(next.setup.computer).toMatchObject({
      needsAction: WORKSPACE_DRIFT_NEEDS_ACTION,
      reachable: "unknown",
    });
  });

  it("withdraws the saved connector runtime that carried the grant", () => {
    const before = secureMcpRuntime(verifiedPair());
    expect(before.connectors.secureMcp.runtime).not.toBeNull();
    const next = withDriftedWorkspaceChecksWithdrawn(before, [
      observation(before),
    ]);
    expect(next.connectors.secureMcp.runtime).toBeNull();
    expect(next.connectors.secureMcp.tunnelId).toBe("tunnel-1");
    expect(next.connectors.secureMcp.generation).toBe(2);
  });

  it("withdraws every folder named in one batch", () => {
    const checked = settingsWith([
      folderA({ accessCheck: checkRecord() }),
      folderB({
        accessCheck: checkRecord({ rootIdentity: identity("1", "3") }),
      }),
    ]);
    const next = withDriftedWorkspaceChecksWithdrawn(checked, [
      observation(checked),
      observation(checked, other, "/fixture/beta", identity("1", "3")),
    ]);
    expect(workspaceOf(next).accessCheck).toBeNull();
    expect(workspaceOf(next, other).accessCheck).toBeNull();
  });

  describe("already withdrawn", () => {
    it("is not settled while a drifted folder still holds a check or verification", () => {
      const before = verifiedPair();
      expect(driftedWorkspaceWithdrawn(before, [observation(before)])).toBe(
        false,
      );
      const checked = settingsWith(
        [folderA({ accessCheck: checkRecord() })],
        {},
        { needsAction: WORKSPACE_DRIFT_NEEDS_ACTION, reachable: "unknown" },
      );
      expect(driftedWorkspaceWithdrawn(checked, [observation(checked)])).toBe(
        false,
      );
    });

    it("is not settled while the connector runtime or the instruction differ", () => {
      const settled = settingsWith(
        [folderA()],
        {},
        { needsAction: WORKSPACE_DRIFT_NEEDS_ACTION, reachable: "unknown" },
      );
      expect(driftedWorkspaceWithdrawn(settled, [observation(settled)])).toBe(
        true,
      );
      const withRuntime = secureMcpRuntime(settled);
      expect(
        driftedWorkspaceWithdrawn(withRuntime, [observation(withRuntime)]),
      ).toBe(false);
      const reachable = settingsWith(
        [folderA()],
        {},
        { needsAction: WORKSPACE_DRIFT_NEEDS_ACTION, reachable: "reachable" },
      );
      expect(
        driftedWorkspaceWithdrawn(reachable, [observation(reachable)]),
      ).toBe(false);
      const other2 = settingsWith([folderA()], {}, { needsAction: "Other." });
      expect(driftedWorkspaceWithdrawn(other2, [observation(other2)])).toBe(
        false,
      );
    });

    it("is settled by the withdrawal itself, so a repeat does not write again", () => {
      const before = secureMcpRuntime(verifiedPair());
      const drifted = [observation(before)];
      const next = withDriftedWorkspaceChecksWithdrawn(before, drifted);
      expect(driftedWorkspaceWithdrawn(next, drifted)).toBe(true);
    });

    it("ignores a check held by a folder that did not drift", () => {
      const settled = settingsWith(
        [folderA(), folderB({ accessCheck: checkRecord() })],
        {},
        { needsAction: WORKSPACE_DRIFT_NEEDS_ACTION, reachable: "unknown" },
      );
      expect(driftedWorkspaceWithdrawn(settled, [observation(settled)])).toBe(
        true,
      );
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  ProductSettingsSchema,
  type ProductSettings,
  type WorkspaceRootIdentity,
} from "../../src/pkg/product-settings/contract";
import {
  verifiedProductWorkspace,
  workspaceDeniedPaths,
  workspaceDescriptor,
  workspaceRootIsExcluded,
} from "../../src/apps/desktop/workspace-descriptor";

// S35-TA-4. Every desktop Computer call is composed here: which workspace may
// be used, which of its paths are denied, and which folder identity the helper
// must still find at the approved path. The adapters underneath have thorough
// tests, but each of them builds its own descriptor, so none of them would
// notice a composition that denied the wrong paths or bound a stale identity.
// This file drives the production functions `main.ts` calls, with the states
// enumerated rather than sampled.

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/primary";
const IDENTITY: WorkspaceRootIdentity = { device: "16777232", inode: "4242" };

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

type WorkspaceOverrides = Readonly<{
  workspaceId?: string;
  root?: string;
  excludedPaths?: readonly string[];
  rootIdentity?: WorkspaceRootIdentity | undefined;
  gitMetadata?: Readonly<{ gitDirectory: string; commonDirectory: string }>;
}>;

/** A real, schema-validated workspace: no hand-built shape bypasses the contract. */
function workspaceOf(overrides: WorkspaceOverrides = {}) {
  const identity =
    "rootIdentity" in overrides ? overrides.rootIdentity : IDENTITY;
  return {
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    root: overrides.root ?? ROOT,
    label: "Primary",
    access: "read" as const,
    // The contract's array is mutable; copy so a readonly case table fits it.
    excludedPaths: [...(overrides.excludedPaths ?? [])],
    ...(identity ? { rootIdentity: identity } : {}),
    ...(overrides.gitMetadata ? { gitMetadata: overrides.gitMetadata } : {}),
  };
}

/**
 * Settings parsed by the real schema. `verification` is what
 * `setup.computer.verified` carries; `generation` is the Computer generation
 * it is compared against.
 */
function settingsOf(
  options: Readonly<{
    workspaces?: readonly ReturnType<typeof workspaceOf>[];
    generation?: number;
    verification?: Readonly<{
      workspaceId: string | null;
      configRevision: number;
    }> | null;
  }> = {},
): ProductSettings {
  const verification = options.verification;
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: COMPUTER_ID,
      generation: options.generation ?? 7,
      name: "This Mac",
      workspaces: options.workspaces ?? [workspaceOf()],
    },
    nativeHosts: { generation: 1, codex: null },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: {
        ...readiness(),
        verified:
          verification === undefined || verification === null
            ? null
            : {
                profile: "farol",
                configRevision: verification.configRevision,
                workspaceId: verification.workspaceId,
                runtimeGeneration: "next-1",
                buildId: "a".repeat(64),
                protocol: "next-1",
                verifiedAt: "2026-09-20T12:00:00.000Z",
              },
      },
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

describe("workspace denied paths", () => {
  // The whole shape space of `excludedPaths` against a root. The rule is one
  // sentence: an exclusion is carried as the part of it below `<root>/`, and
  // anything that is not below `<root>/` is not carried at all.
  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      root: string;
      excluded: readonly string[];
      denied: readonly string[];
    }>
  > = [
    { name: "no exclusions", root: ROOT, excluded: [], denied: [] },
    {
      name: "a direct child",
      root: ROOT,
      excluded: [`${ROOT}/secrets`],
      denied: ["secrets"],
    },
    {
      name: "a nested path keeps its whole relative prefix",
      root: ROOT,
      excluded: [`${ROOT}/a/b/c`],
      denied: ["a/b/c"],
    },
    {
      name: "several exclusions keep their order",
      root: ROOT,
      excluded: [`${ROOT}/b`, `${ROOT}/a`],
      denied: ["b", "a"],
    },
    {
      name: "a sibling that merely shares the root's prefix is not carried",
      // `/workspace/primary-notes` starts with `/workspace/primary` but is a
      // different folder; only the `<root>/` form may match.
      root: ROOT,
      excluded: ["/workspace/primary-notes"],
      denied: [],
    },
    {
      name: "a path outside the root is not carried",
      root: ROOT,
      excluded: ["/etc/hosts"],
      denied: [],
    },
    {
      name: "the filesystem root carries its children without a doubled slash",
      root: "/",
      excluded: ["/etc"],
      denied: ["etc"],
    },
  ];

  for (const testCase of cases) {
    it(`S35-TA-4 ${testCase.name}`, () => {
      expect(
        workspaceDeniedPaths(
          workspaceOf({
            root: testCase.root,
            excludedPaths: testCase.excluded,
          }),
        ),
      ).toEqual(testCase.denied);
    });
  }

  // The gap this file used to record, now closed at its source. An exclusion
  // equal to the approved root matches no `<root>/` prefix, so a descriptor
  // built from it denied nothing — a workspace saying "exclude everything"
  // reading as "exclude nothing". The schema no longer accepts it, so the
  // state cannot reach the consumer at all: settings carrying one are refused
  // as invalid, exactly like any other invalid state, rather than loaded and
  // silently read as permissive.
  it("S35-TA-4 settings that exclude the approved root itself are invalid", () => {
    expect(() =>
      settingsOf({ workspaces: [workspaceOf({ excludedPaths: [ROOT] })] }),
    ).toThrow(/exclusion escapes root/u);
    // And the ordinary shapes it must not catch: a path below the root, and
    // the filesystem root excluding one of its children.
    expect(() =>
      settingsOf({
        workspaces: [workspaceOf({ excludedPaths: [`${ROOT}/a`] })],
      }),
    ).not.toThrow();
    expect(() =>
      settingsOf({
        workspaces: [workspaceOf({ root: "/", excludedPaths: ["/etc"] })],
      }),
    ).not.toThrow();
  });

  // S35-TA-10 (R4 P1). The refusal above was incomplete, and the filesystem
  // root is where it leaked. For any other root the prefix carries a trailing
  // slash, so `<root>` never starts with `<root>/` and the exclusion is
  // refused. For `root: "/"` the prefix IS "/", so `"/".startsWith("/")` is
  // true and the exclusion was accepted — the one case where excluding the
  // approved root validated.
  //
  // What that would have meant downstream, stated so the refusal's purpose is
  // legible: `workspaceDeniedPaths` slices the prefix off, so `"/"` became the
  // empty string and the descriptor carried `deniedPaths: [""]` — an exclusion
  // naming nothing, for a workspace whose settings said to exclude everything.
  // The schema now refuses it, so that value cannot reach the consumer.
  it("S35-TA-10 settings that exclude the filesystem root itself are invalid", () => {
    expect(() =>
      settingsOf({
        workspaces: [workspaceOf({ root: "/", excludedPaths: ["/"] })],
      }),
    ).toThrow(/exclusion escapes root/u);
  });

  it("S35-TA-10 settings whose exclusion escapes the root entirely are invalid", () => {
    // The other half of the same guard. Found by mutation, not by review:
    // removing the prefix test and keeping only the root-equality test left
    // every row above green, because nothing here had ever asked the SCHEMA
    // about a path that simply is not under the root.
    expect(() =>
      settingsOf({
        workspaces: [workspaceOf({ excludedPaths: ["/etc/hosts"] })],
      }),
    ).toThrow(/exclusion escapes root/u);
    // And the sibling that merely shares the root's textual prefix.
    expect(() =>
      settingsOf({
        workspaces: [workspaceOf({ excludedPaths: ["/workspace/primary-x"] })],
      }),
    ).toThrow(/exclusion escapes root/u);
  });

  it("S35-TA-10 the filesystem root is still a supported root that can exclude its children", () => {
    // The control for the row above: this must keep working, or the fix has
    // made `/` unusable rather than made one exclusion invalid.
    expect(() =>
      settingsOf({
        workspaces: [
          workspaceOf({ root: "/", excludedPaths: ["/etc", "/private/var"] }),
        ],
      }),
    ).not.toThrow();
    expect(
      workspaceDeniedPaths(
        workspaceOf({ root: "/", excludedPaths: ["/etc", "/private/var"] }),
      ),
    ).toEqual(["etc", "private/var"]);
  });

  // The detector stays exported: it is what a caller uses to recognise the
  // shape if one ever arrives from somewhere the schema does not guard.
  it("S35-TA-4 the root-exclusion detector still names that exact shape and nothing else", () => {
    expect(
      workspaceRootIsExcluded(workspaceOf({ excludedPaths: [ROOT] })),
    ).toBe(true);
    expect(workspaceRootIsExcluded(workspaceOf({ excludedPaths: [] }))).toBe(
      false,
    );
    expect(
      workspaceRootIsExcluded(workspaceOf({ excludedPaths: [`${ROOT}/a`] })),
    ).toBe(false);
  });
});

describe("workspace descriptor", () => {
  it("S35-TA-4 carries the approved path together with the identity verification bound to it", () => {
    const descriptor = workspaceDescriptor(
      workspaceOf({ excludedPaths: [`${ROOT}/secrets`] }),
      IDENTITY,
    );
    expect(descriptor).toEqual({
      workspaceId: WORKSPACE_ID,
      root: ROOT,
      deniedPaths: ["secrets"],
      approvedRoot: { path: ROOT, device: "16777232", inode: "4242" },
    });
  });

  it("S35-TA-4 carries the identity it is given, not one the workspace happens to hold", () => {
    // `verifiedProductWorkspace` re-attaches the stored identity, but a
    // caller that measured the folder just now passes the measurement. The
    // descriptor must carry the argument: reading the workspace's own field
    // here would send the helper a stale identity to compare against.
    const measured: WorkspaceRootIdentity = {
      device: "16777232",
      inode: "9999",
    };
    expect(
      workspaceDescriptor(workspaceOf({ rootIdentity: IDENTITY }), measured)
        .approvedRoot,
    ).toEqual({ path: ROOT, device: "16777232", inode: "9999" });
  });

  it("S35-TA-4 omits gitMetadata entirely when the workspace has none, and carries it when it does", () => {
    expect("gitMetadata" in workspaceDescriptor(workspaceOf(), IDENTITY)).toBe(
      false,
    );
    const gitMetadata = {
      gitDirectory: "/workspace/meta/worktrees/primary",
      commonDirectory: "/workspace/meta",
    };
    expect(
      workspaceDescriptor(workspaceOf({ gitMetadata }), IDENTITY).gitMetadata,
    ).toEqual(gitMetadata);
  });
});

describe("verified product workspace", () => {
  // Three conditions, each load-bearing, plus the two ways a workspace can be
  // absent. `not_verified` is deliberately the same answer for all three
  // failures: telling them apart would tell a caller which workspaces exist.
  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      settings: () => ProductSettings;
      ask: string;
      status: "verified" | "not_found" | "not_verified";
    }>
  > = [
    {
      name: "verification names this workspace at the current generation and it carries an identity",
      settings: () =>
        settingsOf({
          generation: 7,
          verification: { workspaceId: WORKSPACE_ID, configRevision: 7 },
        }),
      ask: WORKSPACE_ID,
      status: "verified",
    },
    {
      name: "the workspace is not in settings at all",
      settings: () =>
        settingsOf({
          verification: { workspaceId: WORKSPACE_ID, configRevision: 7 },
        }),
      ask: OTHER_ID,
      status: "not_found",
    },
    {
      name: "nothing has been verified yet",
      settings: () => settingsOf({ verification: null }),
      ask: WORKSPACE_ID,
      status: "not_verified",
    },
    {
      name: "the verification names another workspace",
      settings: () =>
        settingsOf({
          workspaces: [workspaceOf(), workspaceOf({ workspaceId: OTHER_ID })],
          generation: 7,
          verification: { workspaceId: OTHER_ID, configRevision: 7 },
        }),
      ask: WORKSPACE_ID,
      status: "not_verified",
    },
    {
      name: "the verification names no workspace at all",
      settings: () =>
        settingsOf({
          generation: 7,
          verification: { workspaceId: null, configRevision: 7 },
        }),
      ask: WORKSPACE_ID,
      status: "not_verified",
    },
    {
      name: "the verification predates the current Computer generation",
      settings: () =>
        settingsOf({
          generation: 8,
          verification: { workspaceId: WORKSPACE_ID, configRevision: 7 },
        }),
      ask: WORKSPACE_ID,
      status: "not_verified",
    },
    {
      name: "the workspace carries no bound identity, so its pathname alone is not trusted",
      settings: () =>
        settingsOf({
          workspaces: [workspaceOf({ rootIdentity: undefined })],
          generation: 7,
          verification: { workspaceId: WORKSPACE_ID, configRevision: 7 },
        }),
      ask: WORKSPACE_ID,
      status: "not_verified",
    },
  ];

  for (const testCase of cases) {
    it(`S35-TA-4 ${testCase.name} -> ${testCase.status}`, () => {
      const result = verifiedProductWorkspace(
        testCase.settings(),
        testCase.ask,
      );
      expect(result.status).toBe(testCase.status);
      if (result.status === "verified") {
        // The verified result carries the identity, so the caller cannot
        // build a descriptor without one.
        expect(result.workspace.rootIdentity).toEqual(IDENTITY);
        expect(result.workspace.workspaceId).toBe(WORKSPACE_ID);
      }
    });
  }

  it("S35-TA-4 a verified workspace composes straight into a descriptor bound to that identity", () => {
    const result = verifiedProductWorkspace(
      settingsOf({
        workspaces: [workspaceOf({ excludedPaths: [`${ROOT}/secrets`] })],
        generation: 7,
        verification: { workspaceId: WORKSPACE_ID, configRevision: 7 },
      }),
      WORKSPACE_ID,
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(
      workspaceDescriptor(result.workspace, result.workspace.rootIdentity),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      root: ROOT,
      deniedPaths: ["secrets"],
      approvedRoot: { path: ROOT, ...IDENTITY },
    });
  });
});

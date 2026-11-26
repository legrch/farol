import { describe, expect, it } from "vitest";

import {
  deniedBy,
  exclusionAffectsScope,
  exclusionKey,
  exclusionsAreValid,
  mergeExclusions,
  relevantExclusions,
  RESTRICTION_FAILURE_SOURCE,
} from "./exclusion";
import type { WorkspaceScope } from "./model";

const subtree: WorkspaceScope = {
  workspaceId: "ws",
  mode: "subtree",
  root: "/work",
  access: "write",
};

describe("exclusionsAreValid", () => {
  it("requires canonical, unique exclusions inside a scope", () => {
    expect(
      exclusionsAreValid([subtree], [{ workspaceId: "ws", path: "/work/x" }]),
    ).toBe(true);
    expect(
      exclusionsAreValid([subtree], [{ workspaceId: "ws", path: "/other" }]),
    ).toBe(false);
    expect(
      exclusionsAreValid([subtree], [{ workspaceId: "no", path: "/work/x" }]),
    ).toBe(false);
    expect(
      exclusionsAreValid(
        [subtree],
        [
          { workspaceId: "ws", path: "/work/x" },
          { workspaceId: "ws", path: "/work/x" },
        ],
      ),
    ).toBe(false);
    expect(
      exclusionsAreValid([subtree], [{ workspaceId: "ws", path: "/work/x/" }]),
    ).toBe(false);
  });

  it("allows 32 exclusions and refuses 33", () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        workspaceId: "ws",
        path: `/work/p${index}`,
      }));
    expect(exclusionsAreValid([subtree], make(32))).toBe(true);
    expect(exclusionsAreValid([subtree], make(33))).toBe(false);
  });
});

describe("exclusionAffectsScope", () => {
  it("matches a subtree overlapping either way, case-insensitively", () => {
    expect(
      exclusionAffectsScope({ workspaceId: "ws", path: "/WORK/x" }, subtree),
    ).toBe(true);
    expect(
      exclusionAffectsScope({ workspaceId: "ws", path: "/work" }, subtree),
    ).toBe(true);
    expect(
      exclusionAffectsScope({ workspaceId: "ws", path: "/else" }, subtree),
    ).toBe(false);
    expect(
      exclusionAffectsScope({ workspaceId: "no", path: "/work/x" }, subtree),
    ).toBe(false);
  });

  it("matches an exact scope only through its listed paths", () => {
    const exact: WorkspaceScope = {
      workspaceId: "ws",
      mode: "exact",
      root: "/work",
      paths: ["/work/a/file"],
      access: "read",
    };
    expect(
      exclusionAffectsScope({ workspaceId: "ws", path: "/work/a" }, exact),
    ).toBe(true);
    expect(
      exclusionAffectsScope({ workspaceId: "ws", path: "/work/b" }, exact),
    ).toBe(false);
  });
});

describe("relevant and merged exclusions", () => {
  it("keeps affecting exclusions and stamps their source", () => {
    expect(
      relevantExclusions(
        [subtree],
        [
          { workspaceId: "ws", path: "/work/x" },
          { workspaceId: "ws", path: "/else" },
        ],
        "task-grant",
      ),
    ).toEqual([
      { workspaceId: "ws", path: "/work/x", restrictionSource: "task-grant" },
    ]);
  });

  it("lets a later group win for the same key", () => {
    const merged = mergeExclusions(
      [{ workspaceId: "ws", path: "/work/x", restrictionSource: "task-grant" }],
      [
        {
          workspaceId: "ws",
          path: "/work/x",
          restrictionSource: "owner-restriction",
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.restrictionSource).toBe("owner-restriction");
    expect(exclusionKey({ workspaceId: "ws", path: "/work/x" })).toBe(
      "ws\0/work/x",
    );
  });
});

describe("deniedBy", () => {
  const list = [{ workspaceId: "ws", path: "/work/secret" }];
  it("denies the excluded path and descendants in its workspace", () => {
    expect(deniedBy(list, "ws", "/work/secret/a")).toBe(list[0]);
    expect(deniedBy(list, "ws", "/work/open")).toBeNull();
    expect(deniedBy(list, "other", "/work/secret")).toBeNull();
  });
});

describe("RESTRICTION_FAILURE_SOURCE", () => {
  it("maps unknown provenance to its own source", () => {
    expect(RESTRICTION_FAILURE_SOURCE).toEqual({
      "computer-approval": "computer-approval",
      "task-grant": "task-grant",
      "owner-restriction": "owner-restriction",
      unknown: "unverified-provenance",
    });
  });
});

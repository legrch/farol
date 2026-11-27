import { describe, expect, it } from "vitest";

import type { ApprovedWorkspace, WorkspaceScope } from "./model";
import {
  cloneScope,
  publicScopes,
  scopeContainsPath,
  scopeContainsScope,
  scopesAreSubset,
} from "./scope";

const subtree: WorkspaceScope = {
  workspaceId: "ws",
  mode: "subtree",
  root: "/work",
  access: "write",
};
const exact: WorkspaceScope = {
  workspaceId: "ws",
  mode: "exact",
  root: "/work",
  paths: ["/work/a.txt", "/work/b.txt"],
  access: "write",
};
const approved: ApprovedWorkspace = {
  workspaceId: "ws",
  root: "/work",
  access: "write",
  rootIdentity: { device: "1", inode: "2" },
};

describe("scopeContainsPath", () => {
  it("admits subtree descendants and listed exact paths only", () => {
    expect(scopeContainsPath(subtree, "/work/deep/file")).toBe(true);
    expect(scopeContainsPath(exact, "/work/a.txt")).toBe(true);
    expect(scopeContainsPath(exact, "/work/c.txt")).toBe(false);
    expect(scopeContainsPath(subtree, "/other/file")).toBe(false);
    expect(scopeContainsPath(subtree, "/work/../etc")).toBe(false);
  });
});

describe("scopeContainsScope", () => {
  it("lets a subtree or approved workspace contain narrower scopes", () => {
    expect(
      scopeContainsScope(subtree, {
        ...exact,
        root: "/work",
        paths: ["/work/a.txt"],
      }),
    ).toBe(true);
    expect(scopeContainsScope(approved, subtree)).toBe(true);
    expect(scopeContainsScope(subtree, { ...subtree, root: "/work/sub" })).toBe(
      true,
    );
  });

  it("refuses other workspaces, widened access and escaping roots", () => {
    expect(scopeContainsScope(subtree, { ...subtree, workspaceId: "x" })).toBe(
      false,
    );
    expect(
      scopeContainsScope(
        { ...subtree, access: "read" },
        { ...subtree, access: "write" },
      ),
    ).toBe(false);
    expect(scopeContainsScope(subtree, { ...subtree, root: "/workshop" })).toBe(
      false,
    );
  });

  it("refuses empty, duplicate or escaping exact paths", () => {
    expect(scopeContainsScope(subtree, { ...exact, paths: [] })).toBe(false);
    expect(
      scopeContainsScope(subtree, {
        ...exact,
        paths: ["/work/a.txt", "/work/a.txt"],
      }),
    ).toBe(false);
    expect(
      scopeContainsScope(subtree, { ...exact, paths: ["/elsewhere/a"] }),
    ).toBe(false);
  });

  it("keeps an exact parent exact and bounded by its listed paths", () => {
    expect(scopeContainsScope(exact, subtree)).toBe(false);
    expect(
      scopeContainsScope(exact, { ...exact, paths: ["/work/a.txt"] }),
    ).toBe(true);
    expect(
      scopeContainsScope(exact, { ...exact, paths: ["/work/c.txt"] }),
    ).toBe(false);
  });
});

describe("scopesAreSubset", () => {
  it("refuses duplicate workspace ids and non-canonical roots", () => {
    expect(scopesAreSubset([approved], [subtree])).toBe(true);
    expect(scopesAreSubset([approved], [subtree, subtree])).toBe(false);
    expect(scopesAreSubset([approved], [{ ...subtree, root: "/work/" }])).toBe(
      false,
    );
    expect(scopesAreSubset([], [subtree])).toBe(false);
  });
});

describe("scope copies", () => {
  it("stamps provenance and copies exact paths", () => {
    const granted = cloneScope(exact, "owner-restriction");
    expect(granted.restrictionSource).toBe("owner-restriction");
    if (granted.mode === "exact" && exact.mode === "exact") {
      expect(granted.paths).not.toBe(exact.paths);
    }
  });

  it("strips provenance from public scopes", () => {
    const [publicScope] = publicScopes([cloneScope(subtree, "task-grant")]);
    expect(publicScope).toEqual(subtree);
    expect(publicScope).not.toHaveProperty("restrictionSource");
  });
});

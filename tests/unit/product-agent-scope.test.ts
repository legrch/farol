import { describe, expect, it } from "vitest";

import {
  productAgentInitialPaths,
  productAgentScopeMatchesWorkspace,
  resolveProductAgentScope,
} from "../../src/apps/desktop/product-agent-scope";

describe("Product Agent owner scope", () => {
  it("keeps the whole verified workspace unless the owner narrows it", () => {
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/private"],
        { mode: "workspace", excludedPaths: [] },
      ),
    ).toEqual({
      scope: { mode: "subtree", root: "/workspace/approved" },
      excludedPaths: [],
    });
  });

  it("resolves one explicit subtree and owner exclusions inside it", () => {
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/private"],
        {
          mode: "subtree",
          relativeRoot: "docs",
          excludedPaths: ["docs/drafts"],
        },
      ),
    ).toEqual({
      scope: { mode: "subtree", root: "/workspace/approved/docs" },
      excludedPaths: ["/workspace/approved/docs/drafts"],
    });
  });

  it("resolves exact paths and rejects configured or contradictory scope", () => {
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/private"],
        {
          mode: "exact",
          relativePaths: ["README.md", "docs/plan.md"],
        },
      ),
    ).toEqual({
      scope: {
        mode: "exact",
        root: "/workspace/approved",
        paths: [
          "/workspace/approved/README.md",
          "/workspace/approved/docs/plan.md",
        ],
      },
      excludedPaths: [],
    });
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/private"],
        { mode: "exact", relativePaths: ["private/secret.txt"] },
      ),
    ).toBeNull();
    expect(
      resolveProductAgentScope("/workspace/approved", [], {
        mode: "subtree",
        relativeRoot: "docs",
        excludedPaths: ["private"],
      }),
    ).toBeNull();
  });

  it("rejects macOS case and Unicode aliases of configured exclusions", () => {
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/Private"],
        { mode: "subtree", relativeRoot: "private", excludedPaths: [] },
      ),
    ).toBeNull();
    expect(
      resolveProductAgentScope(
        "/workspace/approved",
        ["/workspace/approved/Caf\u00e9"],
        {
          mode: "exact",
          relativePaths: ["Cafe\u0301/secret.md"],
        },
      ),
    ).toBeNull();
  });

  it("never narrows the Agent to a subtree the workspace denies by default", () => {
    // The default denied names apply from the folder's root; a subtree rooted
    // inside one would apply them below it and serve what they protect.
    for (const relativeRoot of [
      ".git",
      ".git/refs",
      ".ENV",
      ".\u017f\u017fh",
      "Library/Keychains/login",
      ".docker/config.json",
    ]) {
      expect({
        relativeRoot,
        scope: resolveProductAgentScope("/workspace/approved", [], {
          mode: "subtree",
          relativeRoot,
          excludedPaths: [],
        }),
      }).toEqual({ relativeRoot, scope: null });
    }
    expect(
      resolveProductAgentScope("/workspace/approved", [], {
        mode: "subtree",
        relativeRoot: "src/.github",
        excludedPaths: [],
      }),
    ).toMatchObject({ scope: { root: "/workspace/approved/src/.github" } });
  });
});

// S35-TA-5. Exact mode is a designed, narrower scope, not a stage on the way
// to a subtree: the owner names specific files inside the approved workspace
// and the Agent gets those files and nothing around them. A review packet
// claimed every accepted scope collapses to `{mode: "subtree", root}`; the
// rows below pin the shape the resolver actually delivers so that claim
// cannot be restated from the type alone.
//
// The resolver reports every refusal the same way, as `null`. It carries no
// error codes of its own: `main.ts` turns that `null` into
// `AGENT_SCOPE_INVALID`, and `runProductAgentAssignment` refuses a scope that
// no longer matches its workspace with `AGENT_AUTHORITY_DENIED`.
describe("S35-TA-5 an accepted exact selection stays exact", () => {
  const ROOT = "/workspace/approved";
  const EXCLUSIONS = ["/workspace/approved/private"];

  it("delivers the owner's files, in the owner's order, and nothing else", () => {
    expect(
      resolveProductAgentScope(ROOT, EXCLUSIONS, {
        mode: "exact",
        relativePaths: ["docs/plan.md", "README.md", "src/main.ts"],
      }),
    ).toEqual({
      scope: {
        mode: "exact",
        root: ROOT,
        paths: [
          "/workspace/approved/docs/plan.md",
          "/workspace/approved/README.md",
          "/workspace/approved/src/main.ts",
        ],
      },
      excludedPaths: [],
    });
  });

  it("keeps the root at the workspace, never at the folder holding the files", () => {
    // Every chosen file sits under one nested folder, which is the shape that
    // would tempt a reader into calling the result "a subtree of deep/nested".
    // The root stays the workspace root, because that is what
    // `productAgentScopeMatchesWorkspace` re-checks on every later turn.
    expect(
      resolveProductAgentScope(ROOT, EXCLUSIONS, {
        mode: "exact",
        relativePaths: ["deep/nested/a.md", "deep/nested/b.md"],
      })?.scope,
    ).toEqual({
      mode: "exact",
      root: ROOT,
      paths: [
        "/workspace/approved/deep/nested/a.md",
        "/workspace/approved/deep/nested/b.md",
      ],
    });
  });

  it("gives the Agent the chosen files as its initial paths, never the root", () => {
    const exact = resolveProductAgentScope(ROOT, EXCLUSIONS, {
      mode: "exact",
      relativePaths: ["README.md", "docs/plan.md"],
    });
    if (!exact) throw new Error("TEST_EXACT_SCOPE_REFUSED");
    expect(productAgentInitialPaths(exact.scope)).toEqual([
      "/workspace/approved/README.md",
      "/workspace/approved/docs/plan.md",
    ]);

    const subtree = resolveProductAgentScope(ROOT, EXCLUSIONS, {
      mode: "subtree",
      relativeRoot: "docs",
      excludedPaths: [],
    });
    if (!subtree) throw new Error("TEST_SUBTREE_SCOPE_REFUSED");
    expect(productAgentInitialPaths(subtree.scope)).toEqual([
      "/workspace/approved/docs",
    ]);
  });

  it("confines every exact path to the approved workspace", () => {
    for (const row of [
      { why: "escapes the workspace", relativePaths: ["../sibling/secret.md"] },
      {
        why: "escapes after descending first",
        relativePaths: ["docs/../../sibling/secret.md"],
      },
      {
        why: "escapes to the filesystem root",
        relativePaths: ["../../../../etc/passwd"],
      },
      {
        why: "one accepted file cannot carry one escaping file",
        relativePaths: ["README.md", "../sibling/secret.md"],
      },
      {
        why: "sits inside a configured exclusion",
        relativePaths: ["private/secret.txt"],
      },
      { why: "is the configured exclusion itself", relativePaths: ["private"] },
    ]) {
      expect({
        why: row.why,
        scope: resolveProductAgentScope(ROOT, EXCLUSIONS, {
          mode: "exact",
          relativePaths: row.relativePaths,
        }),
      }).toEqual({ why: row.why, scope: null });
    }
  });

  it("joins an absolute-looking selection under the workspace root", () => {
    // The contract schema refuses a leading slash before this point. The
    // resolver must confine it anyway, so that a selection reaching it by
    // another route cannot name an absolute path outside the workspace.
    expect(
      resolveProductAgentScope(ROOT, [], {
        mode: "exact",
        relativePaths: ["/etc/passwd"],
      }),
    ).toEqual({
      scope: {
        mode: "exact",
        root: ROOT,
        paths: ["/workspace/approved/etc/passwd"],
      },
      excludedPaths: [],
    });
  });
});

// R10a. `denied()` asks whether a candidate sits *inside* a configured
// exclusion, never whether it contains one, so a subtree root that merely
// covers an exclusion is not refused here. That is deliberate and it is not
// the enforcement point: `runProductAgentAssignment` carries every configured
// exclusion into the task admission, and a narrowing may only subtract from a
// task grant, so the exclusion still reaches the host. The integration rows in
// `tests/integration/product-agent-scope-boundary.test.ts` hold that half.
// Pinned here so the asymmetry is stated rather than rediscovered as a bypass.
describe("R10a which way a configured exclusion is compared", () => {
  const ROOT = "/workspace/approved";

  it("refuses a scope rooted inside a configured exclusion", () => {
    expect(
      productAgentScopeMatchesWorkspace(ROOT, ["/workspace/approved/docs"], {
        scope: { mode: "subtree", root: "/workspace/approved/docs/api" },
        excludedPaths: [],
      }),
    ).toBe(false);
  });

  it("accepts a scope that merely contains one, which the task grant covers", () => {
    expect(
      productAgentScopeMatchesWorkspace(
        ROOT,
        ["/workspace/approved/docs/private"],
        {
          scope: { mode: "subtree", root: "/workspace/approved/docs" },
          excludedPaths: [],
        },
      ),
    ).toBe(true);
  });
});

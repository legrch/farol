import { describe, expect, it } from "vitest";

import { resolveProductAgentScope } from "../../src/apps/desktop/product-agent-scope";

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

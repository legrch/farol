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
});

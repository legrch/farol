import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENIED_PATHS,
  DEFAULT_WRITE_DENIED_PATHS,
  deniedPaths,
  verificationDeniedPaths,
  writeDeniedPaths,
} from "./denied";
import type { WorkspaceMutationRequest } from "../../app/port/mutable-workspace";

const workspace = (denied: readonly string[]) => ({
  workspace: { deniedPaths: denied },
});

describe("deniedPaths", () => {
  it("keeps every default and appends owner exclusions once", () => {
    const result = deniedPaths(workspace(["secrets", ".env"]));
    expect(result.slice(0, DEFAULT_DENIED_PATHS.length)).toEqual([
      ...DEFAULT_DENIED_PATHS,
    ]);
    expect(result.slice(DEFAULT_DENIED_PATHS.length)).toEqual(["secrets"]);
  });
  it("lists .git among the defaults", () => {
    expect(deniedPaths(workspace([]))).toContain(".git");
  });
});

describe("verificationDeniedPaths", () => {
  it("drops only .git from the defaults", () => {
    const result = verificationDeniedPaths(workspace(["secrets"]));
    expect(result).not.toContain(".git");
    expect(result).toContain(".git-credentials");
    expect(result).toContain("secrets");
    expect(result).toHaveLength(DEFAULT_DENIED_PATHS.length);
  });
  it("still honours an owner exclusion of .git", () => {
    expect(verificationDeniedPaths(workspace([".git"]))).toContain(".git");
  });
});

describe("writeDeniedPaths", () => {
  it("unions the write defaults with the request's own", () => {
    const request = {
      workspace: { writeDeniedPaths: ["dist", ".git"] },
    } as unknown as WorkspaceMutationRequest;
    expect(writeDeniedPaths(request)).toEqual([
      ...DEFAULT_WRITE_DENIED_PATHS,
      "dist",
    ]);
  });
});

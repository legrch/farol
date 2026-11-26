import { describe, expect, it } from "vitest";
import { DEFAULT_READ_WINDOW_BYTES } from "./fileinput";
import {
  gitOperation,
  listOperation,
  readOperation,
  searchOperation,
} from "./operations";

describe("tool operations", () => {
  it("builds list and search with their own fields only", () => {
    expect(listOperation("a")).toEqual({
      kind: "workspace.list",
      relativePath: "a",
    });
    expect(searchOperation("a", "b")).toEqual({
      kind: "workspace.search",
      relativePath: "a",
      pattern: "b",
    });
  });

  it("asks for a whole file unless a window end is given", () => {
    expect(readOperation("a")).toEqual({
      kind: "workspace.read",
      relativePath: "a",
    });
    expect("range" in readOperation("a")).toBe(false);
  });

  it("fills the missing end of a window", () => {
    expect(readOperation("a", 5).range).toEqual({
      offset: 5,
      length: DEFAULT_READ_WINDOW_BYTES,
    });
    expect(readOperation("a", undefined, 7).range).toEqual({
      offset: 0,
      length: 7,
    });
    expect(readOperation("a", 0, 0).range).toEqual({ offset: 0, length: 0 });
  });

  it("runs a git verifier at the workspace root", () => {
    expect(gitOperation("git.head")).toEqual({
      kind: "verification.run",
      command: "git.head",
      relativePath: ".",
    });
  });
});

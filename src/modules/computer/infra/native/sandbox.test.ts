import { describe, expect, it } from "vitest";
import {
  COMMAND_PROFILE,
  FIXED_GIT_CONFIG_ARGUMENTS,
  HEAD_ARGUMENTS,
  REVIEWED_DEVELOPER_ROOTS,
  sandboxDeveloperRoot,
  snapshotAncestors,
} from "./sandbox";

describe("sandboxDeveloperRoot", () => {
  it("returns the reviewed root owning the executable", () => {
    for (const root of REVIEWED_DEVELOPER_ROOTS) {
      expect(sandboxDeveloperRoot(`${root}/usr/bin/git`)).toBe(root);
    }
  });

  it("falls back to /System for anything else", () => {
    expect(sandboxDeveloperRoot("/usr/bin/git")).toBe("/System");
    expect(
      sandboxDeveloperRoot("/Library/Developer/CommandLineToolsX/git"),
    ).toBe("/System");
  });
});

describe("snapshotAncestors", () => {
  it("lists every ancestor up to but excluding the root", () => {
    expect(snapshotAncestors("/a/b/c")).toEqual(["/a/b", "/a"]);
    expect(snapshotAncestors("/a")).toEqual([]);
  });
});

describe("fixed command shape", () => {
  it("pins the HEAD invocation", () => {
    expect(HEAD_ARGUMENTS).toEqual([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
  });

  it("pins the config overrides in order", () => {
    expect(FIXED_GIT_CONFIG_ARGUMENTS).toEqual([
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.excludesFile=/dev/null",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.quotepath=true",
      "-c",
      "submodule.recurse=false",
    ]);
  });

  it("keeps the profile closed and offline", () => {
    expect(COMMAND_PROFILE.startsWith("(version 1)")).toBe(true);
    expect(COMMAND_PROFILE).toContain("(deny default)");
    expect(COMMAND_PROFILE).toContain("(deny network*)");
    expect(COMMAND_PROFILE).toContain('(literal (param "FAROL_GIT"))');
  });
});

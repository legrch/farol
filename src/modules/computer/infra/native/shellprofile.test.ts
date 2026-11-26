import { describe, expect, it } from "vitest";

import {
  SANDBOX_EXEC,
  buildShellEnvironment,
  buildWorkspaceShellProfile,
  sandboxCommandArgs,
  type EffectiveWorkspace,
} from "./shellprofile";

const workspace: EffectiveWorkspace = {
  root: "/w/root",
  access: "write",
  gitMetadata: undefined,
  gitHistoryApproved: false,
};

describe("workspace shell profile", () => {
  it("compiles read-only scopes without write rules", () => {
    const { source, parameters } = buildWorkspaceShellProfile(
      [workspace],
      [{ path: "/w/root/secret" }],
      "/s",
      false,
      [],
    );
    expect(parameters.slice(0, 4)).toEqual([
      "-D",
      "ROOT_0=/w/root",
      "-D",
      "DENY_0=/w/root/secret",
    ]);
    expect(
      source.startsWith(
        '(version 1)\n(import "dyld-support.sb")\n(deny default)',
      ),
    ).toBe(true);
    expect(source).not.toContain('(param "WRITE_');
    expect(source).toContain('(subpath (param "SCRATCH_');
    expect(source).toContain(
      '(deny file-read* file-write* (regex #"/\\.git(/|$)"))',
    );
    expect(source.endsWith("(deny network*)")).toBe(true);
  });

  it("adds write rules and omits the .git deny when history is approved", () => {
    const { source, parameters } = buildWorkspaceShellProfile(
      [{ ...workspace, gitHistoryApproved: true }],
      [],
      "/s",
      true,
      ["/h/.gitconfig"],
    );
    expect(parameters).toContain("WRITE_0=/w/root");
    expect(source).toContain('(param "WRITE_0")');
    expect(source).not.toContain(
      '(deny file-read* file-write* (regex #"/\\.git(/|$)"))',
    );
    expect(parameters).toContain("GIT_SETTINGS_1=/h/.gitconfig");
  });

  it("builds the environment from git settings presence", () => {
    expect(buildShellEnvironment([], "/h", "/s", false)).toEqual({
      HOME: "/s",
      TMPDIR: "/s",
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    const withGit = buildShellEnvironment(["/h/.gitconfig"], "/h", "/s", true);
    expect(withGit).toMatchObject({
      HOME: "/h",
      GIT_OPTIONAL_LOCKS: "1",
      XDG_CONFIG_HOME: "/h/.config",
    });
    expect(withGit.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it("orders sandbox argv: parameters, profile, shell, command", () => {
    expect(SANDBOX_EXEC).toBe("/usr/bin/sandbox-exec");
    expect(
      sandboxCommandArgs({ source: "SRC", parameters: ["-D", "A=1"] }, "ls"),
    ).toEqual(["-D", "A=1", "-p", "SRC", "/bin/zsh", "-c", "ls"]);
  });
});

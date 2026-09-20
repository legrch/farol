import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  commandRunsExecutable,
  detectCodexHostPresence,
  parseProcessTable,
  type ProcessEntry,
} from "../../src/apps/desktop/farol-model-host-presence";

const executable = "/Users/owner/.nvm/versions/node/v22.19.0/bin/codex";

function lister(entries: readonly ProcessEntry[]) {
  return async () => entries;
}

describe("Farol Model host presence (read-only process-table scan)", () => {
  it("reports running when a process was started from the discovered executable", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: lister([
        { pid: 100, command: "/sbin/launchd" },
        {
          pid: 4321,
          command: `${executable} exec --skip-git-repo-check say hi`,
        },
        { pid: 4322, command: executable },
      ]),
      resolveRealPath: async (target) => target,
      ownPid: 1,
    });
    expect(presence).toEqual({ state: "running", pids: [4321, 4322] });
  });

  it("recognises an npm shim launched through node as the same executable", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: lister([
        {
          pid: 777,
          command: `/Users/owner/.nvm/versions/node/v22.19.0/bin/node ${executable} app-server`,
        },
      ]),
      resolveRealPath: async (target) => target,
      ownPid: 1,
    });
    expect(presence).toEqual({ state: "running", pids: [777] });
  });

  it("matches the executable's resolved real path too", async () => {
    const real =
      "/Users/owner/.nvm/versions/node/v22.19.0/lib/node_modules/@openai/codex/bin/codex.js";
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: lister([{ pid: 12, command: `node ${real} exec` }]),
      resolveRealPath: async (target) =>
        target === executable ? real : target,
      ownPid: 1,
    });
    expect(presence).toEqual({ state: "running", pids: [12] });
  });

  it("reports not_running when only look-alike paths are present", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: "/usr/local/bin/codex",
      listProcesses: lister([
        { pid: 1, command: "/usr/local/bin/codex-other" },
        { pid: 2, command: "/usr/local/bin/codex2 exec" },
        { pid: 3, command: "vim /usr/local/bin/codex.bak" },
        { pid: 4, command: "/opt/homebrew/bin/codex" },
        { pid: 5, command: "grep /usr/local/bin/codexx" },
      ]),
      resolveRealPath: async (target) => target,
      ownPid: 1,
    });
    expect(presence).toEqual({ state: "not_running" });
  });

  it("never counts this process itself", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: lister([{ pid: process.pid, command: executable }]),
      resolveRealPath: async (target) => target,
    });
    expect(presence).toEqual({ state: "not_running" });
  });

  it("says unknown, never a guess, when the process table cannot be read", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: async () => {
        throw new Error("EPERM");
      },
      resolveRealPath: async (target) => target,
    });
    expect(presence).toEqual({
      state: "unknown",
      reason: "process_table_unavailable",
    });
  });

  it("refuses a relative executable path as unknown", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: "bin/codex",
      listProcesses: lister([{ pid: 9, command: "bin/codex" }]),
    });
    expect(presence).toEqual({
      state: "unknown",
      reason: "executable_path_invalid",
    });
  });

  it("still matches on the recorded path when the real path cannot be resolved", async () => {
    const presence = await detectCodexHostPresence({
      executablePath: executable,
      listProcesses: lister([{ pid: 55, command: `${executable} exec` }]),
      resolveRealPath: async () => {
        throw new Error("ENOENT");
      },
      ownPid: 1,
    });
    expect(presence).toEqual({ state: "running", pids: [55] });
  });

  it("matches a candidate only as a whole space-delimited token", () => {
    expect(commandRunsExecutable("/a/b/codex", ["/a/b/codex"])).toBe(true);
    expect(commandRunsExecutable("/a/b/codex exec", ["/a/b/codex"])).toBe(true);
    expect(commandRunsExecutable("node /a/b/codex", ["/a/b/codex"])).toBe(true);
    expect(commandRunsExecutable("node /a/b/codex exec", ["/a/b/codex"])).toBe(
      true,
    );
    expect(commandRunsExecutable("/a/b/codex-x", ["/a/b/codex"])).toBe(false);
    expect(commandRunsExecutable("/a/b/codexx exec", ["/a/b/codex"])).toBe(
      false,
    );
    expect(commandRunsExecutable("x/a/b/codex", ["/a/b/codex"])).toBe(false);
    expect(commandRunsExecutable("/a/b/codex", [""])).toBe(false);
    // A path with a space in it is matched whole, not token by token.
    expect(
      commandRunsExecutable("/Users/o/My Tools/codex exec", [
        "/Users/o/My Tools/codex",
      ]),
    ).toBe(true);
  });

  it("parses `ps -axo pid=,command=` output line by line", () => {
    expect(
      parseProcessTable(
        [
          "    1 /sbin/launchd",
          "  501 /usr/bin/thing with args  ",
          "garbage line",
          "  0 /not/a/pid",
          "  77 ",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 1, command: "/sbin/launchd" },
      { pid: 501, command: "/usr/bin/thing with args" },
    ]);
  });

  it("is read-only by construction: the module never signals or kills a process", async () => {
    const source = await fs.readFile(
      fileURLToPath(
        new URL(
          "../../src/apps/desktop/farol-model-host-presence.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\.kill\(/u);
    expect(source).not.toMatch(/\bkill\b\s*\(/u);
    expect(source).not.toMatch(/"kill"|'kill'|pkill|killall/u);
  });
});

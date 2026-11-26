import { describe, expect, it } from "vitest";
import {
  absolutePath,
  commandBase,
  configureArguments,
  doctorArguments,
  mcpCommand,
  runArguments,
  runtimeError,
} from "./command";

// The connector command lines are the whole contract with the executable, so
// each vector is pinned exactly. Pure values; nothing runs.

const mcp = {
  electronPath: "/Applications/Farol.app/Contents/MacOS/Farol",
  entryPath: "/Applications/Farol.app/Contents/Resources/computer-mcp.cjs",
  launchContractPath: "/private/state/launch-contract.json",
};

describe("runtimeError", () => {
  it("throws a bare error carrying only the code", () => {
    expect(() => runtimeError("CONNECTOR_X")).toThrow(
      expect.objectContaining({ message: "CONNECTOR_X" }),
    );
  });
});

describe("absolutePath", () => {
  it.each(["/a", "/a/b c"])("admits %s", (value) =>
    expect(absolutePath(value)).toBe(true),
  );
  it.each(["a", "./a", "", "/a\0b"])("refuses %j", (value) =>
    expect(absolutePath(value)).toBe(false),
  );
});

describe("mcpCommand", () => {
  it("quotes every word of the electron-as-node command", () => {
    expect(mcpCommand(mcp)).toBe(
      "'/usr/bin/env' 'ELECTRON_RUN_AS_NODE=1' " +
        "'/Applications/Farol.app/Contents/MacOS/Farol' " +
        "'/Applications/Farol.app/Contents/Resources/computer-mcp.cjs' " +
        "'--launch-contract' '/private/state/launch-contract.json'",
    );
  });

  it("escapes a single quote inside a path", () => {
    expect(mcpCommand({ ...mcp, entryPath: "/a/it's.cjs" })).toContain(
      "'/a/it'\\''s.cjs'",
    );
  });

  it.each(["electronPath", "entryPath", "launchContractPath"] as const)(
    "refuses a relative %s",
    (key) =>
      expect(() => mcpCommand({ ...mcp, [key]: "relative" })).toThrow(
        "CONNECTOR_MCP_COMMAND_INVALID",
      ),
  );

  it.each(["\n", "\r"])("refuses a line break %j in a path", (control) =>
    expect(() => mcpCommand({ ...mcp, entryPath: `/a${control}b` })).toThrow(
      "CONNECTOR_MCP_COMMAND_INVALID",
    ),
  );
});

describe("commandBase", () => {
  const base = {
    root: "/r",
    homePath: "/h",
    tempPath: "/t",
    stateRoot: "/r/state",
  };

  it("runs in the root with a closed environment and the safe path", () => {
    expect(commandBase(base, "/bin-dir/tunnel-client")).toEqual({
      executablePath: "/bin-dir/tunnel-client",
      cwd: "/r",
      environment: {
        PATH: "/bin-dir:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: "/h",
        TMPDIR: "/t",
        TUNNEL_CLIENT_STATE_DIR: "/r/state",
        NO_COLOR: "1",
        TERM: "dumb",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
      maxBufferBytes: 262_144,
    });
  });

  it("does not inherit the caller's environment", () => {
    process.env.FAROL_COMMAND_TEST_LEAK = "1";
    try {
      expect(
        commandBase(base, "/x/tunnel-client").environment,
      ).not.toHaveProperty("FAROL_COMMAND_TEST_LEAK");
    } finally {
      delete process.env.FAROL_COMMAND_TEST_LEAK;
    }
  });
});

describe("argument vectors", () => {
  it("initialises a forced sample profile with the credential reference", () => {
    expect(
      configureArguments({
        profileRoot: "/r/profiles",
        tunnelId: "tun_1",
        credentialReference: "file:/c",
        mcp,
      }),
    ).toEqual([
      "init",
      "--force",
      "--sample",
      "sample_mcp_stdio_local",
      "--profile",
      "farol",
      "--profile-dir",
      "/r/profiles",
      "--tunnel-id",
      "tun_1",
      "--control-plane-api-key-ref",
      "file:/c",
      "--health-listen-addr",
      "127.0.0.1:0",
      "--mcp-command",
      mcpCommand(mcp),
    ]);
  });

  it("refuses an invalid mcp command while building init", () => {
    expect(() =>
      configureArguments({
        profileRoot: "/p",
        tunnelId: "t",
        credentialReference: "file:/c",
        mcp: { ...mcp, entryPath: "relative" },
      }),
    ).toThrow("CONNECTOR_MCP_COMMAND_INVALID");
  });

  it("explains the doctor result as json", () => {
    expect(doctorArguments("/r/profiles")).toEqual([
      "doctor",
      "--profile",
      "farol",
      "--profile-dir",
      "/r/profiles",
      "--json",
      "--explain",
    ]);
  });

  it("runs on a loopback ephemeral port with url and pid files", () => {
    expect(
      runArguments({
        profileRoot: "/r/profiles",
        healthUrlFile: "/r/runtime/health.url",
        pidFile: "/r/runtime/tunnel-client.pid",
      }),
    ).toEqual([
      "run",
      "--profile",
      "farol",
      "--profile-dir",
      "/r/profiles",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      "/r/runtime/health.url",
      "--pid.file",
      "/r/runtime/tunnel-client.pid",
      "--log.format",
      "json",
      "--log.level",
      "info",
    ]);
  });
});

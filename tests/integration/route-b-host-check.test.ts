import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { launchCodexAppServer } from "../../src/apps/desktop/codex-app-server-process";
import {
  ROUTE_B_CHECK_PROMPT,
  runRouteBHostCheck,
} from "../../src/apps/desktop/route-b-host-check";

let root = "";

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function runtimeRoot(): Promise<string> {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-route-b-check-")),
  );
  return root;
}

const endpoint = {
  baseUrl: "http://127.0.0.1:43111/v1",
  token: "route-b-token-that-is-long-enough",
};

describe("Route B host check", () => {
  it("launches an isolated host on the Route B endpoint and runs one harmless turn", async () => {
    const runtime = await runtimeRoot();
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ close }));
    const route = vi.fn(async () => ({
      threadId: "thread-check",
      turnId: "turn-check",
      deltaCount: 1,
      observedCharacters: 5,
    }));

    await expect(
      runRouteBHostCheck(
        {
          executablePath: "/usr/local/bin/codex",
          runtimeRoot: runtime,
          homePath: "/Users/example",
          tempPath: os.tmpdir(),
          clientVersion: "0.1.0-preview.0",
          endpoint,
        },
        { launch, route },
      ),
    ).resolves.toEqual({
      status: "completed",
      deltaCount: 1,
      observedCharacters: 5,
    });
    // The host's Codex home is Next's private directory, never the owner's,
    // and the check runs under the bounded profile the launcher verifies
    // before readiness: the harmless turn cannot reach a built-in tool or
    // an ambient MCP server whatever the host has configured.
    expect(launch).toHaveBeenCalledWith({
      executablePath: "/usr/local/bin/codex",
      cwd: runtime,
      homePath: "/Users/example",
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      codexHomePath: path.join(runtime, "route-b-codex-home"),
      providerRoute: endpoint,
      toolProfile: "dynamic-only",
    });
    expect(
      (await fs.stat(path.join(runtime, "route-b-codex-home"))).mode & 0o777,
    ).toBe(0o700);
    expect(route).toHaveBeenCalledWith(expect.anything(), {
      model: "farol-next/mind",
      cwd: runtime,
      prompt: ROUTE_B_CHECK_PROMPT,
      timeoutMs: 120_000,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a start failure as not run and a later failure as unknown, never retrying", async () => {
    const runtime = await runtimeRoot();
    const input = {
      executablePath: "/usr/local/bin/codex",
      runtimeRoot: runtime,
      homePath: "/Users/example",
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      endpoint,
    };

    await expect(
      runRouteBHostCheck(input, {
        launch: async () => {
          throw new Error("CODEX_APP_SERVER_START_FAILED");
        },
        route: vi.fn(),
      }),
    ).resolves.toEqual({ status: "failed", code: "ROUTE_B_HOST_START_FAILED" });

    const close = vi.fn(async () => undefined);
    const route = vi.fn(async () => {
      throw new Error("CODEX_CHATGPT_TURN_TIMEOUT");
    });
    await expect(
      runRouteBHostCheck(input, { launch: async () => ({ close }), route }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "CODEX_CHATGPT_TURN_TIMEOUT",
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // A fake Codex App Server on stdio. It applies the bounded profile it is
  // launched with, except that `violation` keeps one built-in tool enabled
  // in the execution process, and it records every method that process
  // received.
  async function fakeHost(
    root: string,
    violation: "none" | "builtin-tool-enabled",
  ): Promise<Readonly<{ executablePath: string; received: string }>> {
    const executablePath = path.join(root, "codex-fixture.cjs");
    const received = path.join(root, "received.log");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const violation = ${JSON.stringify(violation)};
const args = process.argv.slice(2);
const execution = args.includes("mcp_servers.qmd.enabled=false");
const disabled = new Set(args.flatMap((value, index) => value === "--disable" ? [args[index + 1]] : []));
const enabled = new Set(args.flatMap((value, index) => value === "--enable" ? [args[index + 1]] : []));
let ready = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (execution) fs.appendFileSync(${JSON.stringify(received)}, message.method + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex-fixture/1" } }) + "\\n");
  } else if (message.method === "initialized") {
    ready = true;
  } else if (message.method === "config/read") {
    const features = Object.fromEntries([
      ...[...disabled].map((name) => [name, false]),
      ...[...enabled].map((name) => [name, true])
    ]);
    if (execution && violation === "builtin-tool-enabled") features.shell_tool = true;
    process.stdout.write(JSON.stringify({ id: message.id, result: { config: {
      web_search: args.includes('web_search="disabled"') ? "disabled" : null,
      features,
      mcp_servers: { qmd: { command: "qmd", enabled: !execution } }
    } } }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { ready, args } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );
    return { executablePath, received };
  }

  it("HR-008 verifies the bounded profile on the actual launcher: a host keeping a built-in tool is refused before any model request, a compliant host is admitted ready", async () => {
    const runtime = await runtimeRoot();
    const hostile = await fakeHost(runtime, "builtin-tool-enabled");
    const route = vi.fn(async () => ({
      threadId: "thread-check",
      turnId: "turn-check",
      deltaCount: 1,
      observedCharacters: 5,
    }));
    await expect(
      runRouteBHostCheck(
        {
          executablePath: hostile.executablePath,
          runtimeRoot: runtime,
          homePath: runtime,
          tempPath: os.tmpdir(),
          clientVersion: "0.1.0-preview.0",
          endpoint,
        },
        { launch: launchCodexAppServer, route },
      ),
    ).resolves.toEqual({ status: "failed", code: "ROUTE_B_HOST_START_FAILED" });
    expect(route).not.toHaveBeenCalled();
    // The execution process was never told it is ready and never asked to
    // start a thread.
    expect(
      (await fs.readFile(hostile.received, "utf8")).split("\n").filter(Boolean),
    ).toEqual(["initialize", "config/read"]);

    const compliantRoot = path.join(runtime, "compliant");
    await fs.mkdir(compliantRoot, { recursive: true });
    const compliant = await fakeHost(compliantRoot, "none");
    const observed: unknown[] = [];
    const routeReady = vi.fn(
      async (client: Awaited<ReturnType<typeof launchCodexAppServer>>) => {
        observed.push(await client.request("model/list", {}));
        return {
          threadId: "thread-check",
          turnId: "turn-check",
          deltaCount: 1,
          observedCharacters: 5,
        };
      },
    );
    await expect(
      runRouteBHostCheck(
        {
          executablePath: compliant.executablePath,
          runtimeRoot: compliantRoot,
          homePath: compliantRoot,
          tempPath: os.tmpdir(),
          clientVersion: "0.1.0-preview.0",
          endpoint,
        },
        { launch: launchCodexAppServer, route: routeReady },
      ),
    ).resolves.toEqual({
      status: "completed",
      deltaCount: 1,
      observedCharacters: 5,
    });
    expect(observed).toEqual([
      expect.objectContaining({
        ready: true,
        args: expect.arrayContaining([
          "--disable",
          "multi_agent",
          "shell_tool",
          "mcp_servers.qmd.enabled=false",
          'web_search="disabled"',
        ]),
      }),
    ]);
  });
});

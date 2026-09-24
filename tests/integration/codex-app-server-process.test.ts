import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchCodexAppServer } from "../../src/apps/desktop/codex-app-server-process";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Codex App Server process", () => {
  it("launches the selected executable with a minimal environment and initializes stdio", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-process-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture.cjs");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex-fixture/1" } }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: "gpt-6-astra" }], codexHome: process.env.CODEX_HOME, inheritedApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY") } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );

    const client = await launchCodexAppServer({
      executablePath,
      cwd: root,
      homePath: root,
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      codexHomePath: path.join(root, "codex-home"),
    });
    await expect(client.request("model/list", {})).resolves.toEqual({
      data: [{ id: "gpt-6-astra" }],
      codexHome: path.join(root, "codex-home"),
      inheritedApiKey: false,
    });
    await client.close();
  });

  it("does not invent a Codex home when the preserved Preview caller omits it", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-home-required-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture.cjs");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}\nconst readline=require("node:readline");const lines=readline.createInterface({input:process.stdin});lines.on("line",line=>{const message=JSON.parse(line);if(message.method==="initialize")process.stdout.write(JSON.stringify({id:message.id,result:{}})+"\\n");else if(message.method==="model/list")process.stdout.write(JSON.stringify({id:message.id,result:{hasCodexHome:Object.hasOwn(process.env,"CODEX_HOME")}})+"\\n")});\n`,
      { mode: 0o700 },
    );
    const client = await launchCodexAppServer({
      executablePath,
      cwd: root,
      homePath: root,
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
    });
    await expect(client.request("model/list", {})).resolves.toEqual({
      hasCodexHome: false,
    });
    await client.close();
  });

  it("isolates the Next provider with process-local config and a private token", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-provider-process-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture.cjs");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex-fixture/1" } }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      data: [{ id: "farol-next/mind" }],
      args: process.argv.slice(2),
      providerTokenPresent: process.env.FAROL_NEXT_PROVIDER_TOKEN === "private-route-token",
      inheritedApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY")
    } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );

    const client = await launchCodexAppServer({
      executablePath,
      cwd: root,
      homePath: root,
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      codexHomePath: path.join(root, "codex-home"),
      providerRoute: {
        baseUrl: "http://127.0.0.1:43123/v1",
        token: "private-route-token",
      },
    });
    const observed = (await client.request("model/list", {})) as {
      args: string[];
      providerTokenPresent: boolean;
      inheritedApiKey: boolean;
    };
    expect(observed.providerTokenPresent).toBe(true);
    expect(observed.inheritedApiKey).toBe(false);
    expect(observed.args).toEqual([
      "app-server",
      "--stdio",
      "-c",
      'model_provider="farol"',
      "-c",
      'model_providers.farol={ name = "Farol", base_url = "http://127.0.0.1:43123/v1", wire_api = "responses", env_key = "FAROL_NEXT_PROVIDER_TOKEN", requires_openai_auth = false, request_max_retries = 0, stream_max_retries = 0, stream_idle_timeout_ms = 120000 }',
    ]);
    await client.close();
  });

  it("attests a native Agent process with built-in tools and ambient MCP disabled before readiness", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-agent-process-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture.cjs");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const readline = require("node:readline");
const args = process.argv.slice(2);
const disabled = new Set(args.flatMap((value, index) => value === "--disable" ? [args[index + 1]] : []));
const enabled = new Set(args.flatMap((value, index) => value === "--enable" ? [args[index + 1]] : []));
const qmdDisabled = args.includes("mcp_servers.qmd.enabled=false");
let ready = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex-fixture/1" } }) + "\\n");
  } else if (message.method === "initialized") {
    ready = true;
  } else if (message.method === "config/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { config: {
      web_search: args.includes('web_search="disabled"') ? "disabled" : null,
      features: Object.fromEntries([
        ...[...disabled].map((name) => [name, false]),
        ...[...enabled].map((name) => [name, true])
      ]),
      mcp_servers: { qmd: { command: "qmd", enabled: !qmdDisabled } }
    } } }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      args,
      ready,
      qmdDisabled
    } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );

    const client = await launchCodexAppServer({
      executablePath,
      cwd: root,
      homePath: root,
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      codexHomePath: path.join(root, "codex-home"),
      toolProfile: "native-agent",
    });
    const observed = (await client.request("model/list", {})) as {
      args: string[];
      ready: boolean;
      qmdDisabled: boolean;
    };
    expect(observed.ready).toBe(true);
    expect(observed.qmdDisabled).toBe(true);
    expect(observed.args).toContain("mcp_servers.qmd.enabled=false");
    expect(observed.args).toContain("--strict-config");
    expect(observed.args).toContain(
      "tools.experimental_request_user_input={ enabled = false }",
    );
    expect(observed.args).toContain("skills=[]");
    expect(observed.args).toContain("shell_tool");
    expect(observed.args).toContain("apps");
    expect(observed.args).toContain("browser_use");
    expect(observed.args).toContain("computer_use");
    expect(observed.args).toContain("plugins");
    expect(observed.args).toContain("multi_agent");
    expect(observed.args).toContain("skip_host_skill_discovery");
    await client.close();
  });

  it("AUTH-08 fails closed before readiness when the host does not apply the requested profile", async () => {
    for (const violation of [
      "mcp-still-enabled",
      "unadvertised-mcp",
      "builtin-tool-enabled",
      "web-search-enabled",
    ] as const) {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-codex-agent-violation-"),
      );
      roots.push(root);
      const executablePath = path.join(root, "codex-fixture.cjs");
      const received = path.join(root, "received.log");
      await fs.writeFile(
        executablePath,
        `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const violation = ${JSON.stringify(violation)};
const args = process.argv.slice(2);
// Discovery runs without the bounded profile; execution carries it.
const execution = args.includes("mcp_servers.qmd.enabled=false");
const disabled = new Set(args.flatMap((value, index) => value === "--disable" ? [args[index + 1]] : []));
const enabled = new Set(args.flatMap((value, index) => value === "--enable" ? [args[index + 1]] : []));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (execution) fs.appendFileSync(${JSON.stringify(received)}, message.method + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "config/read") {
    const features = Object.fromEntries([
      ...[...disabled].map((name) => [name, false]),
      ...[...enabled].map((name) => [name, true])
    ]);
    if (execution && violation === "builtin-tool-enabled") features.shell_tool = true;
    const servers = { qmd: { command: "qmd", enabled: !execution || violation === "mcp-still-enabled" } };
    if (execution && violation === "unadvertised-mcp") servers.extra = { command: "extra", enabled: true };
    process.stdout.write(JSON.stringify({ id: message.id, result: { config: {
      web_search: execution && violation !== "web-search-enabled" ? "disabled" : null,
      features,
      mcp_servers: servers
    } } }) + "\\n");
  }
});
`,
        { mode: 0o700 },
      );

      await expect(
        launchCodexAppServer({
          executablePath,
          cwd: root,
          homePath: root,
          tempPath: os.tmpdir(),
          clientVersion: "0.1.0-preview.0",
          codexHomePath: path.join(root, "codex-home"),
          toolProfile: "native-agent",
        }),
        violation,
      ).rejects.toThrow("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
      // The execution process was never told it is ready for work.
      expect(
        (await fs.readFile(received, "utf8")).split("\n").filter(Boolean),
        violation,
      ).toEqual(["initialize", "config/read"]);
    }
  });

  it("fails closed before readiness when an ambient MCP name cannot be disabled safely", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-agent-denied-process-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture.cjs");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "config/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { config: {
      mcp_servers: { "unsafe.name": { command: "fixture" } }
    } } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );

    await expect(
      launchCodexAppServer({
        executablePath,
        cwd: root,
        homePath: root,
        tempPath: os.tmpdir(),
        clientVersion: "0.1.0-preview.0",
        codexHomePath: path.join(root, "codex-home"),
        toolProfile: "native-agent",
      }),
    ).rejects.toThrow("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  });
});

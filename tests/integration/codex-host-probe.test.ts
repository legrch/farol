import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeCodexHost,
  type CodexProbeRunner,
} from "../../src/apps/desktop/codex-host-probe";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  executablePath: string;
  executableSha256: string;
  scratchRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-codex-probe-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const lib = path.join(root, "lib");
  await fs.mkdir(bin);
  await fs.mkdir(lib);
  const target = path.join(lib, "codex.js");
  const bytes = "#!/usr/bin/env node\n";
  await fs.writeFile(target, bytes, { mode: 0o755 });
  const executablePath = path.join(bin, "codex");
  await fs.symlink(target, executablePath);
  return {
    root,
    executablePath,
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
    scratchRoot: path.join(root, "scratch"),
  };
}

async function writeCompatibleSchema(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "v2"), { recursive: true });
  const files: Record<string, unknown> = {
    "v2/ThreadStartParams.json": {
      properties: {
        dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
      },
    },
    "DynamicToolCallParams.json": {
      required: ["threadId", "turnId", "callId", "tool", "arguments"],
    },
    "ServerRequest.json": {
      oneOf: [{ properties: { method: { enum: ["item/tool/call"] } } }],
    },
    "ClientRequest.json": {
      oneOf: [{ properties: { method: { enum: ["thread/compact/start"] } } }],
    },
    "v2/ThreadListParams.json": {
      properties: { parentThreadId: {}, ancestorThreadId: {} },
    },
    "v2/ThreadReadResponse.json": {
      definitions: {
        Thread: { properties: { parentThreadId: {} } },
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
  };
  await Promise.all(
    Object.entries(files).map(([relativePath, value]) =>
      fs.writeFile(
        path.join(root, relativePath),
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      ),
    ),
  );
}

describe("Codex host probe", () => {
  it("refuses discovery byte drift before starting the executable", async () => {
    const selected = await fixture();
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
          expectedDiscovery: {
            canonicalPath: await fs.realpath(selected.executablePath),
            sha256: "f".repeat(64),
          },
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("proves one selected executable against a generated bounded schema", async () => {
    const selected = await fixture();
    const canonicalPath = await fs.realpath(selected.executablePath);
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      expect(command.executablePath).toBe(canonicalPath);
      expect(command.environment.PATH?.split(":")[0]).toBe(
        path.dirname(canonicalPath),
      );
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      expect(command.arguments.slice(0, 4)).toEqual([
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
      ]);
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      return { stdout: "", stderr: "" };
    });

    const result = await probeCodexHost(
      {
        executablePath: selected.executablePath,
        scratchRoot: selected.scratchRoot,
      },
      { run: runner },
    );

    expect(result).toMatchObject({
      executablePath: canonicalPath,
      executableSha256: selected.executableSha256,
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      capabilities: {
        dynamicTools: true,
        correlatedToolCalls: true,
        descendantObservation: true,
        collabObservation: true,
        compaction: true,
      },
    });
    expect(runner).toHaveBeenCalledTimes(2);
    await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
  });

  it("refuses a writable selected executable before starting it", async () => {
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.chmod(target, 0o777);
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_EXECUTABLE_UNSAFE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts an executable between the old 128 MiB cap and the new 512 MiB cap", async () => {
    // Real Codex binaries run 210-224 MiB; the old 128 MiB ceiling refused
    // every genuine install. Truncate creates a sparse file instantly —
    // reading it back still exercises the real chunked hash loop.
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.truncate(target, 200 * 1024 * 1024);
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      return { stdout: "", stderr: "" };
    });

    const result = await probeCodexHost(
      {
        executablePath: selected.executablePath,
        scratchRoot: selected.scratchRoot,
      },
      { run: runner },
    );

    expect(result.version).toBe("0.153.4");
    expect(runner).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("refuses an executable over the 512 MiB cap before starting it", async () => {
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.truncate(target, 512 * 1024 * 1024 + 1);
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_EXECUTABLE_UNSAFE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps an incompatible generated contract without retaining schema files", async () => {
    const selected = await fixture();
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      await fs.writeFile(
        path.join(schemaRoot, "v2/ThreadStartParams.json"),
        '{"properties":{}}\n',
        { mode: 0o600 },
      );
      return { stdout: "", stderr: "" };
    });

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_INCOMPATIBLE");
    await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
  });
});

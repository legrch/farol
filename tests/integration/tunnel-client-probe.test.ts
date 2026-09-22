import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeTunnelClient,
  type TunnelClientProbeRunner,
} from "../../src/apps/desktop/tunnel-client-probe";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-tunnel-probe-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const lib = path.join(root, "lib");
  await fs.mkdir(bin);
  await fs.mkdir(lib);
  const target = path.join(lib, "tunnel-client");
  const bytes = "#!/bin/sh\nexit 0\n";
  await fs.writeFile(target, bytes, { mode: 0o755 });
  const selected = path.join(bin, "tunnel-client");
  await fs.symlink(target, selected);
  return {
    root,
    selected,
    target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const help: Readonly<Record<string, string>> = {
  init: [
    "--profile",
    "--profile-dir",
    "--tunnel-id",
    "--control-plane-api-key-ref",
    "--health-listen-addr",
    "--mcp-command",
  ].join("\n"),
  doctor: ["--profile", "--profile-dir", "--json", "--explain"].join("\n"),
  run: [
    "--profile",
    "--profile-dir",
    "--health.listen-addr",
    "--health.url-file",
    "--pid.file",
  ].join("\n"),
};

describe("tunnel-client probe", () => {
  it("refuses discovery byte drift before starting the executable", async () => {
    const selected = await fixture();
    const runner = vi.fn<TunnelClientProbeRunner>();

    await expect(
      probeTunnelClient(
        {
          executablePath: selected.selected,
          expectedDiscovery: {
            canonicalPath: await fs.realpath(selected.target),
            sha256: "f".repeat(64),
          },
        },
        { run: runner },
      ),
    ).rejects.toThrow("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("executes the synthetic reviewed CLI through the production runner", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-tunnel-probe-real-"),
    );
    roots.push(root);
    const source = await fs.readFile(
      new URL("../e2e/tunnel-client.fixture.cjs", import.meta.url),
      "utf8",
    );
    // This test must also pass when TMPDIR is writer-local and therefore
    // beneath the package's `type: module` scope. The fixture itself is
    // reviewed CommonJS, just like the E2E executable that consumes it.
    const executablePath = path.join(root, "tunnel-client.cjs");
    await fs.writeFile(executablePath, `#!${process.execPath}\n${source}`, {
      mode: 0o700,
    });

    await expect(probeTunnelClient({ executablePath })).resolves.toMatchObject({
      executablePath: await fs.realpath(executablePath),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
    });
  });

  it("accepts the reviewed client output and probes the flag-bearing doctor help", async () => {
    const selected = await fixture();
    const runner = vi.fn<TunnelClientProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return {
          // Exact output from the reviewed Homebrew 0.0.14 wrapper. It is
          // semver-first (no "tunnel-client version" prefix) but still
          // carries the matching git-sha annotation.
          stdout:
            "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b (git sha: 0f870e50a973fa820d4c409000059e181e8d242b)\n",
          stderr: "",
        };
      }
      if (
        command.arguments[0] === "help" &&
        command.arguments[1] === "doctor"
      ) {
        return {
          stdout: "Run diagnostics for a tunnel profile.\n",
          stderr: "",
        };
      }
      const surface =
        command.arguments[0] === "doctor" && command.arguments[1] === "--help"
          ? "doctor"
          : command.arguments[1];
      if (surface !== "init" && surface !== "doctor" && surface !== "run") {
        throw new Error("unexpected surface");
      }
      return { stdout: help[surface] ?? "", stderr: "" };
    });

    const result = await probeTunnelClient(
      { executablePath: selected.selected },
      { run: runner },
    );

    expect(result).toEqual({
      executablePath: await fs.realpath(selected.target),
      executableSha256: selected.sha256,
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls.map(([command]) => command.arguments)).toEqual([
      ["--version"],
      ["help", "init"],
      ["doctor", "--help"],
      ["help", "run"],
    ]);
  });

  it("keeps the explicit labeled compatibility version format", async () => {
    const selected = await fixture();
    const runner = vi.fn<TunnelClientProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return {
          stdout:
            "tunnel-client version 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b (git sha: 0f870e50a973fa820d4c409000059e181e8d242b)\n",
          stderr: "",
        };
      }
      const surface =
        command.arguments[0] === "doctor" ? "doctor" : command.arguments[1];
      if (surface !== "init" && surface !== "doctor" && surface !== "run") {
        throw new Error("unexpected surface");
      }
      return { stdout: help[surface] ?? "", stderr: "" };
    });

    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run: runner }),
    ).resolves.toMatchObject({
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
    });
  });

  it.each([
    "0.0.14+build trailing junk\n",
    "prefix 0.0.14+build\n",
    "0.0.14+build\nunexpected\n",
    "0.0.14+build (git sha: other)\n",
    "tunnel-client version 0.0.14+build (git sha: other)\n",
  ])("rejects malformed or extra version output: %j", async (stdout) => {
    const selected = await fixture();
    const runner = vi.fn<TunnelClientProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run: runner }),
    ).rejects.toThrow("TUNNEL_CLIENT_INCOMPATIBLE");
  });

  it("refuses a writable or incompatible executable", async () => {
    const selected = await fixture();
    await fs.chmod(selected.target, 0o777);
    const runner = vi.fn<TunnelClientProbeRunner>();
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run: runner }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(runner).not.toHaveBeenCalled();

    await fs.chmod(selected.target, 0o755);
    const incompatible = vi.fn<TunnelClientProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "tunnel-client version 0.0.14\n", stderr: "" };
      }
      return { stdout: "--profile\n", stderr: "" };
    });
    await expect(
      probeTunnelClient(
        { executablePath: selected.selected },
        { run: incompatible },
      ),
    ).rejects.toThrow("TUNNEL_CLIENT_INCOMPATIBLE");
  });
});

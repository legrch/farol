import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeTunnelClient,
  verifySelectedTunnelClient,
  type TunnelClientProbeRunner,
} from "../../src/apps/desktop/tunnel-client-probe";

vi.mock("node:child_process", { spy: true });

const roots: string[] = [];

type DescriptorRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

function spyOnRead(handle: Awaited<ReturnType<typeof fs.open>>) {
  return vi.spyOn(handle as { read: DescriptorRead }, "read");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
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

// Disposable files and descriptor fault injection only: these cases never run a CLI.
describe("selected tunnel-client verification", () => {
  function forbidExecution() {
    return vi.mocked(execFile).mockImplementation(() => {
      throw new Error("verification must not execute a process");
    });
  }

  async function savedSelection() {
    const selected = await fixture();
    return {
      ...selected,
      executablePath: await fs.realpath(selected.target),
      executableSha256: selected.sha256,
    };
  }

  it("accepts the saved canonical path and exact SHA without executing", async () => {
    const selected = await savedSelection();
    const execute = forbidExecution();
    await expect(verifySelectedTunnelClient(selected)).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects changed bytes without executing", async () => {
    const selected = await savedSelection();
    const execute = forbidExecution();
    await fs.writeFile(selected.target, "#!/bin/sh\nexit 1\n");
    await expect(verifySelectedTunnelClient(selected)).rejects.toThrow(
      "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an alias even when it resolves to the saved bytes", async () => {
    const selected = await savedSelection();
    const execute = forbidExecution();
    await expect(
      verifySelectedTunnelClient({
        ...selected,
        executablePath: selected.selected,
      }),
    ).rejects.toThrow("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a saved path replaced with a symlink to identical bytes", async () => {
    const selected = await savedSelection();
    const execute = forbidExecution();
    const replacement = path.join(selected.root, "replacement");
    await fs.copyFile(selected.target, replacement);
    await fs.unlink(selected.target);
    await fs.symlink(replacement, selected.target);
    await expect(verifySelectedTunnelClient(selected)).rejects.toThrow(
      "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["", "f".repeat(63), "F".repeat(64), "g".repeat(64)])(
    "rejects malformed saved SHA %j before opening a file",
    async (executableSha256) => {
      const selected = await savedSelection();
      const execute = forbidExecution();
      const open = vi.spyOn(fs, "open");
      await expect(
        verifySelectedTunnelClient({ ...selected, executableSha256 }),
      ).rejects.toThrow("TUNNEL_CLIENT_SELECTION_INVALID");
      expect(open).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    "relative",
    "nul",
    "missing",
    "directory",
    "writable",
    "not-executable",
    "empty",
    "oversized",
  ])("rejects an invalid or unsafe saved selection: %s", async (fault) => {
    const selected = await savedSelection();
    const execute = forbidExecution();
    let executablePath = selected.executablePath;
    if (fault === "relative") executablePath = "relative/tunnel-client";
    if (fault === "nul") executablePath += "\0";
    if (fault === "missing") await fs.unlink(selected.target);
    if (fault === "directory") {
      await fs.unlink(selected.target);
      await fs.mkdir(selected.target);
    }
    if (fault === "writable") await fs.chmod(selected.target, 0o777);
    if (fault === "not-executable") await fs.chmod(selected.target, 0o600);
    if (fault === "empty") await fs.truncate(selected.target, 0);
    if (fault === "oversized") {
      // Sparse disposable file: enforce the size ceiling without allocating 128 MiB.
      await fs.truncate(selected.target, 128 * 1_024 * 1_024 + 1);
    }
    await expect(
      verifySelectedTunnelClient({ ...selected, executablePath }),
    ).rejects.toThrow(
      fault === "relative" || fault === "nul"
        ? "TUNNEL_CLIENT_SELECTION_INVALID"
        : "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

// Exercise the shared reader through the existing probe API, with a mocked runner.
describe("tunnel-client pin reader", () => {
  function runner() {
    return vi.fn<TunnelClientProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "1.0.0", stderr: "" };
      }
      const surface =
        command.arguments[0] === "doctor" ? "doctor" : command.arguments[1];
      return { stdout: help[surface ?? ""] ?? "", stderr: "" };
    });
  }

  it("opens without following links or blocking on a raced special node", async () => {
    const selected = await fixture();
    const open = fs.open.bind(fs);
    const run = runner();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const opening = vi
      .spyOn(fs, "open")
      .mockImplementationOnce(async (file, flags) => {
        handle = await open(file, flags);
        const info = await handle.stat({ bigint: true });
        // Model a FIFO replacement between inspection and open; no real FIFO.
        vi.spyOn(handle, "stat").mockResolvedValue({
          ...info,
          isFile: () => false,
        });
        return handle;
      });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    const flags = opening.mock.calls[0]?.[1];
    expect(typeof flags).toBe("number");
    expect(Number(flags) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(Number(flags) & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    expect(handle?.fd).toBe(-1);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses growth and bounds every descriptor read to the initial size", async () => {
    const selected = await fixture();
    const size = (await fs.stat(selected.target)).size;
    const open = fs.open.bind(fs);
    const run = runner();
    const reads: number[] = [];
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags) => {
      const handle = await open(file, flags);
      const read = handle.read.bind(handle);
      let first = true;
      spyOnRead(handle).mockImplementation(
        async (buffer, offset, length, position) => {
          reads.push(length);
          if (first) {
            first = false;
            await fs.appendFile(selected.target, "grew during verification");
          }
          return read(buffer, offset, length, position);
        },
      );
      return handle;
    });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(reads).toEqual([size]);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses truncation while reading", async () => {
    const selected = await fixture();
    const open = fs.open.bind(fs);
    const run = runner();
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags) => {
      const handle = await open(file, flags);
      const read = handle.read.bind(handle);
      spyOnRead(handle).mockImplementationOnce(
        async (buffer, offset, length, position) => {
          await fs.truncate(selected.target, 0);
          return read(buffer, offset, length, position);
        },
      );
      return handle;
    });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses replacement by identical bytes while the descriptor is being read", async () => {
    const selected = await fixture();
    const open = fs.open.bind(fs);
    const run = runner();
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags) => {
      const handle = await open(file, flags);
      const read = handle.read.bind(handle);
      spyOnRead(handle).mockImplementationOnce(
        async (buffer, offset, length, position) => {
          const replacement = path.join(selected.root, "replacement");
          await fs.copyFile(selected.target, replacement);
          await fs.rename(replacement, selected.target);
          return read(buffer, offset, length, position);
        },
      );
      return handle;
    });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an inode replacement between path inspection and open", async () => {
    const selected = await fixture();
    const open = fs.open.bind(fs);
    const run = runner();
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags) => {
      const replacement = path.join(selected.root, "replacement");
      await fs.copyFile(selected.target, replacement);
      await fs.rename(replacement, selected.target);
      return open(file, flags);
    });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies a descriptor read failure and closes the handle", async () => {
    const selected = await fixture();
    const open = fs.open.bind(fs);
    const run = runner();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags) => {
      handle = await open(file, flags);
      spyOnRead(handle).mockRejectedValueOnce(
        new Error("synthetic read failure"),
      );
      return handle;
    });
    await expect(
      probeTunnelClient({ executablePath: selected.selected }, { run }),
    ).rejects.toThrow("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    expect(handle?.fd).toBe(-1);
    expect(run).not.toHaveBeenCalled();
  });
});

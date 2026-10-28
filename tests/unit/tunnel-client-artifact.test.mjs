import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { syntheticTunnelArchive } from "../fixtures/tunnel-archive-fixture.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic identity only: these tests qualify bounded copying and refusal,
// not the upstream executable, its licenses or native execution.
vi.mock("../../apps/desktop/tunnel-client-contract.ts", async () => {
  const { createHash } = await import("node:crypto");
  const { syntheticTunnelArchive } =
    await import("../fixtures/tunnel-archive-fixture.mjs");
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const binary = Buffer.alloc(1024);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  return {
    TUNNEL_CLIENT: Object.freeze({
      version: "fixture",
      archiveURL: "https://fixture.invalid/upstream.zip",
      archiveSHA256: sha256(syntheticTunnelArchive()),
      entry: "tunnel-client",
      size: binary.length,
      sha256: sha256(binary),
    }),
    TUNNEL_CLIENT_NOTICES: [
      {
        source: "LICENSE",
        entry: "tunnel-client-LICENSE.txt",
        sha256: sha256("fixture license\n"),
      },
      {
        source: "NOTICE",
        entry: "tunnel-client-NOTICE.txt",
        sha256: sha256("fixture notice\n"),
      },
    ],
  };
});

import { TUNNEL_CLIENT } from "../../apps/desktop/tunnel-client-contract.ts";
import {
  embedTunnelClient,
  provisionTunnelClientInput,
  prepareTunnelClientInput,
  tunnelClientInputDirectory,
  verifyBundledTunnelClient,
} from "../../tooling/tunnel-client-artifact.mjs";

let root;
let source;
let binary;
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-tunnel-input-")),
  );
  source = path.join(root, "upstream");
  await fs.mkdir(source);
  binary = Buffer.alloc(TUNNEL_CLIENT.size);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  await fs.writeFile(path.join(source, "tunnel-client"), binary);
  await fs.writeFile(path.join(source, "LICENSE"), "fixture license\n");
  await fs.writeFile(path.join(source, "NOTICE"), "fixture notice\n");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("bundled Tunnel Client input", () => {
  it("does not run the input CLI when the package verifier is bundled", () => {
    const verifier = path.join(root, "update-package.mjs");
    buildSync({
      entryPoints: ["tooling/verify-package-standalone.mjs"],
      outfile: verifier,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const result = spawnSync(process.execPath, [verifier], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PACKAGE_ARGUMENTS_INVALID");
    expect(result.stderr).not.toContain("TUNNEL_CLIENT_INPUT_SOURCE_REQUIRED");

    const cli = spawnSync(
      process.execPath,
      ["tooling/prepare-tunnel-client.mjs", "--invalid"],
      { encoding: "utf8" },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("TUNNEL_CLIENT_INPUT_SOURCE_REQUIRED");
  });

  it("copies reviewed bytes with private modes and preserves source", async () => {
    const output = await prepareTunnelClientInput(root, source);
    expect(output).toBe(tunnelClientInputDirectory(root));
    expect(await fs.readFile(path.join(output, "tunnel-client"))).toEqual(
      binary,
    );
    expect(
      (await fs.stat(path.join(output, "tunnel-client"))).mode & 0o777,
    ).toBe(0o500);
    expect(
      (await fs.stat(path.join(output, "tunnel-client-LICENSE.txt"))).mode &
        0o777,
    ).toBe(0o400);
    expect(await fs.readFile(path.join(source, "tunnel-client"))).toEqual(
      binary,
    );
    await expect(verifyBundledTunnelClient(output)).resolves.toBeUndefined();
    expect(await fs.readdir(path.join(root, "_output"))).toEqual([
      "tunnel-client",
    ]);
  });

  it.each(["binary", "license", "wrapper", "oversize"])(
    "refuses %s corruption before publishing any input",
    async (kind) => {
      if (kind === "license")
        await fs.writeFile(path.join(source, "LICENSE"), "different license");
      else if (kind === "wrapper")
        await fs.writeFile(
          path.join(source, "tunnel-client"),
          "#!/bin/sh\nexit 0\n",
        );
      else if (kind === "oversize")
        await fs.appendFile(path.join(source, "tunnel-client"), "extra");
      else {
        binary[100] = 1;
        await fs.writeFile(path.join(source, "tunnel-client"), binary);
      }
      await expect(prepareTunnelClientInput(root, source)).rejects.toThrow(
        "BUNDLED_TUNNEL_CLIENT_INVALID",
      );
      expect(await fs.readdir(path.join(root, "_output"))).toEqual([]);
    },
  );

  it.each(["symlink", "hardlink"])(
    "refuses %s source without modifying it",
    async (kind) => {
      const from = path.join(source, "tunnel-client");
      const original = path.join(source, "original");
      await fs.rename(from, original);
      if (kind === "symlink") await fs.symlink(original, from);
      else await fs.link(original, from);
      await expect(prepareTunnelClientInput(root, source)).rejects.toThrow();
      expect(await fs.readFile(original)).toEqual(binary);
      expect(await fs.readdir(path.join(root, "_output"))).toEqual([]);
    },
  );

  it("reuses a verified cache without executing or rereading an external source", async () => {
    const output = await prepareTunnelClientInput(root, source);
    await fs.rm(source, { recursive: true });
    expect(await prepareTunnelClientInput(root, source)).toBe(output);
    await expect(verifyBundledTunnelClient(output)).resolves.toBeUndefined();
  });

  it("does not repair or overwrite a tampered cache from the source", async () => {
    const output = await prepareTunnelClientInput(root, source);
    const file = path.join(output, "tunnel-client");
    await fs.chmod(file, 0o700);
    await fs.writeFile(file, "tampered");
    await expect(prepareTunnelClientInput(root, source)).rejects.toThrow(
      "BUNDLED_TUNNEL_CLIENT_INVALID",
    );
    expect(await fs.readFile(file, "utf8")).toBe("tampered");
  });

  it("refuses a writable executable even when its digest matches", async () => {
    const output = await prepareTunnelClientInput(root, source);
    await fs.chmod(path.join(output, "tunnel-client"), 0o770);
    await expect(verifyBundledTunnelClient(output)).rejects.toThrow(
      "BUNDLED_TUNNEL_CLIENT_INVALID",
    );
  });

  it("refuses a redirected cache directory", async () => {
    const output = await prepareTunnelClientInput(root, source);
    const moved = path.join(root, "redirected");
    await fs.rename(output, moved);
    await fs.symlink(moved, output);
    await expect(prepareTunnelClientInput(root, source)).rejects.toThrow(
      "BUNDLED_TUNNEL_CLIENT_INVALID",
    );
  });

  it("embeds the pinned binary and notices without clobbering existing files", async () => {
    await prepareTunnelClientInput(root, source);
    const build = path.join(root, "build");
    await fs.mkdir(build);
    expect(await embedTunnelClient(build, root)).toEqual({
      kind: "dependency",
      path: "vendor/tunnel-client-vfixture-darwin-arm64",
      sha256: TUNNEL_CLIENT.sha256,
    });
    await expect(verifyBundledTunnelClient(build)).resolves.toBeUndefined();
    await expect(embedTunnelClient(build, root)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(path.join(build, "tunnel-client"))).toEqual(
      binary,
    );
  });
});

describe("explicit pinned archive preparation (synthetic HTTP and ZIP)", () => {
  it("reads only selected entries after archive authentication and cleans scratch", async () => {
    const fetchImpl = vi.fn(async () => new Response(syntheticTunnelArchive()));
    const result = await provisionTunnelClientInput(root, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(TUNNEL_CLIENT.archiveURL);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(verifyBundledTunnelClient(result)).resolves.toBeUndefined();
    expect((await fs.readdir(result)).sort()).toEqual(
      [
        "tunnel-client",
        "tunnel-client-LICENSE.txt",
        "tunnel-client-NOTICE.txt",
      ].sort(),
    );
    expect(await fs.readdir(path.join(root, "_output/tmp"))).toEqual([]);
  });
  it("refuses redirected output before making a foreign scratch directory", async () => {
    const foreign = path.join(root, "foreign");
    await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(root, "_output"));
    const fetchImpl = vi.fn(async () => new Response(syntheticTunnelArchive()));
    await expect(provisionTunnelClientInput(root, fetchImpl)).rejects.toThrow(
      "TUNNEL_CLIENT_DOWNLOAD_UNAVAILABLE",
    );
    expect(await fs.readdir(foreign)).toEqual([]);
  });
  it("reuses verified input without another network request", async () => {
    await prepareTunnelClientInput(root, source);
    const fetchImpl = vi.fn();
    await provisionTunnelClientInput(root, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses a corrupt existing input without fetching or overwriting", async () => {
    const input = await prepareTunnelClientInput(root, source);
    const target = path.join(input, "tunnel-client");
    await fs.chmod(target, 0o600);
    await fs.writeFile(target, "changed");
    const fetchImpl = vi.fn();
    await expect(provisionTunnelClientInput(root, fetchImpl)).rejects.toThrow(
      "BUNDLED_TUNNEL_CLIENT_INVALID",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("changed");
  });
  it.each(["transport", "http", "digest", "declared-size", "encoding"])(
    "refuses %s without retries or a published input",
    async (kind) => {
      const fetchImpl = vi.fn(async () => {
        if (kind === "transport") throw new Error("private transport detail");
        if (kind === "http") return new Response(null, { status: 403 });
        if (kind === "digest") return new Response("wrong archive");
        if (kind === "encoding")
          return new Response(syntheticTunnelArchive(), {
            headers: { "content-encoding": "gzip" },
          });
        return new Response(syntheticTunnelArchive(), {
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        });
      });
      await expect(provisionTunnelClientInput(root, fetchImpl)).rejects.toThrow(
        /^TUNNEL_CLIENT_DOWNLOAD_UNAVAILABLE$/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(
        fs.lstat(tunnelClientInputDirectory(root)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

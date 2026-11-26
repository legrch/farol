import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRoots,
  healthUrlFile,
  pidFile,
  profileRoot,
  readHealthBaseUrl,
  removeRuntimeFile,
  runtimeRoot,
  stateRoot,
} from "./layout";

// The runtime layout over a disposable directory: private modes, no symlinks,
// single-link regular files. No connector, tunnel or provider runs.

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "farol-layout-"));
  root = path.join(base, "connector");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const mode = async (target: string) => (await fs.stat(target)).mode & 0o777;

describe("paths", () => {
  it("derives every path from the one root", () => {
    expect(profileRoot("/r")).toBe("/r/profiles");
    expect(stateRoot("/r")).toBe("/r/state");
    expect(runtimeRoot("/r")).toBe("/r/runtime");
    expect(healthUrlFile("/r")).toBe("/r/runtime/health.url");
    expect(pidFile("/r")).toBe("/r/runtime/tunnel-client.pid");
  });
});

describe("ensureRoots", () => {
  it("creates the root and the three directories privately", async () => {
    await ensureRoots(root);
    for (const directory of [
      root,
      profileRoot(root),
      stateRoot(root),
      runtimeRoot(root),
    ])
      expect(await mode(directory)).toBe(0o700);
  });

  it("is repeatable and tightens a loose directory", async () => {
    await ensureRoots(root);
    await fs.chmod(stateRoot(root), 0o755);
    await ensureRoots(root);
    expect(await mode(stateRoot(root))).toBe(0o700);
  });

  it("refuses a symlink in place of a directory", async () => {
    await ensureRoots(root);
    await fs.rm(runtimeRoot(root), { recursive: true });
    await fs.mkdir(path.join(base, "elsewhere"));
    await fs.symlink(path.join(base, "elsewhere"), runtimeRoot(root));
    await expect(ensureRoots(root)).rejects.toThrow("CONNECTOR_RUNTIME_UNSAFE");
  });

  it("refuses a regular file in place of a directory", async () => {
    await ensureRoots(root);
    await fs.rm(profileRoot(root), { recursive: true });
    await fs.writeFile(profileRoot(root), "x");
    await expect(ensureRoots(root)).rejects.toThrow();
  });
});

describe("removeRuntimeFile", () => {
  beforeEach(() => ensureRoots(root));

  it("removes an owned single-link file", async () => {
    await fs.writeFile(pidFile(root), "1");
    await removeRuntimeFile(pidFile(root));
    await expect(fs.lstat(pidFile(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("treats an absent file as removed", async () => {
    await expect(removeRuntimeFile(pidFile(root))).resolves.toBeUndefined();
  });

  it("refuses a symlink and leaves its target", async () => {
    const target = path.join(base, "target");
    await fs.writeFile(target, "x");
    await fs.symlink(target, pidFile(root));
    await expect(removeRuntimeFile(pidFile(root))).rejects.toThrow(
      "CONNECTOR_RUNTIME_UNSAFE",
    );
    expect(await fs.readFile(target, "utf8")).toBe("x");
  });

  it("refuses a hard-linked file", async () => {
    const other = path.join(base, "other");
    await fs.writeFile(other, "x");
    await fs.link(other, pidFile(root));
    await expect(removeRuntimeFile(pidFile(root))).rejects.toThrow(
      "CONNECTOR_RUNTIME_UNSAFE",
    );
  });

  it("refuses a directory", async () => {
    await fs.mkdir(pidFile(root));
    await expect(removeRuntimeFile(pidFile(root))).rejects.toThrow(
      "CONNECTOR_RUNTIME_UNSAFE",
    );
  });
});

describe("readHealthBaseUrl", () => {
  beforeEach(() => ensureRoots(root));
  const write = (text: string, fileMode = 0o600) =>
    fs.writeFile(healthUrlFile(root), text, { mode: fileMode });

  it("reads the loopback origin and drops the trailing newline", async () => {
    await write("http://127.0.0.1:43123/\n");
    expect(await readHealthBaseUrl(healthUrlFile(root))).toBe(
      "http://127.0.0.1:43123",
    );
  });

  it("is absent before the tunnel wrote it", async () => {
    expect(await readHealthBaseUrl(healthUrlFile(root))).toBeNull();
  });

  it("tightens a loose mode once the url is accepted", async () => {
    await write("http://127.0.0.1:43123/");
    await fs.chmod(healthUrlFile(root), 0o644);
    await readHealthBaseUrl(healthUrlFile(root));
    expect(await mode(healthUrlFile(root))).toBe(0o600);
  });

  it.each([
    ["a non-loopback host", "http://localhost:43123/"],
    ["https", "https://127.0.0.1:43123/"],
    ["credentials", "http://u:p@127.0.0.1:43123/"],
    ["a path", "http://127.0.0.1:43123/readyz"],
    ["a query", "http://127.0.0.1:43123/?a=1"],
    ["a fragment", "http://127.0.0.1:43123/#a"],
    ["no port", "http://127.0.0.1/"],
    ["port zero", "http://127.0.0.1:0/"],
    ["not a url", "not a url"],
  ])("returns null for %s", async (_name, text) => {
    await write(text);
    expect(await readHealthBaseUrl(healthUrlFile(root))).toBeNull();
  });

  it.each([
    ["an empty file", ""],
    ["an oversized file", "x".repeat(257)],
  ])("refuses %s as unsafe", async (_name, text) => {
    await write(text);
    await expect(readHealthBaseUrl(healthUrlFile(root))).rejects.toThrow(
      "CONNECTOR_RUNTIME_UNSAFE",
    );
  });

  it("refuses a symlink", async () => {
    const target = path.join(base, "target");
    await fs.writeFile(target, "http://127.0.0.1:43123/");
    await fs.symlink(target, healthUrlFile(root));
    await expect(readHealthBaseUrl(healthUrlFile(root))).rejects.toThrow(
      "CONNECTOR_RUNTIME_UNSAFE",
    );
  });
});

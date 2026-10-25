import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  CORE_RESOURCE_ENTRIES,
  declareCoreResources,
} from "../../tooling/core-resources.mjs";
import { verifyCoreResources } from "../../apps/desktop/bridge/core-resources.ts";

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-resources-fixture-")),
  );
  roots.push(root);
  const identity = createBuildIdentity({
    version: "0.2.0-owner.beta.11",
    buildVersion: "25",
    updateChannel: "github-owner-beta",
    builtAt: "2026-10-12T00:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    sourceDirty: false,
  });
  // No program or product output: synthetic bytes independently declared by
  // the actual producer and consumed by the actual runtime verifier.
  const binary = Buffer.alloc(128, 1);
  const core = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: identity.buildId,
      sourceSHA: identity.sourceCommit,
      sourceTreeDigest: identity.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: {
      path: "farol-backend",
      size: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
    },
  };
  for (const name of CORE_RESOURCE_ENTRIES)
    await fs.writeFile(
      path.join(root, name),
      name === "farol-backend" ? binary : `synthetic resource ${name}`,
      { mode: 0o600 },
    );
  const declared = await declareCoreResources(root, core, identity);
  return { root, identity, core, declared };
}
const verify = (f, declared = f.declared) =>
  verifyCoreResources(f.root, declared, f.core, performance.now() + 2000);
const refused = { state: "refused", code: "core_resources_unqualified" };
const expired = { state: "refused", code: "core_resources_deadline_expired" };

describe("compiled core resource closure", () => {
  it("reports only content-free work counters without changing the original budget", async () => {
    const f = await fixture();
    const observations = [];
    const deadline = performance.now() + 2000;
    await verifyCoreResources(f.root, f.declared, f.core, deadline, (value) =>
      observations.push(value),
    );
    expect(observations.map((v) => v.event)).toEqual(["begin", "end"]);
    const final = observations.at(-1);
    expect(final).toMatchObject({
      stage: "core-resources",
      result: "passed",
      deadlineMs: deadline,
      files: f.declared.files.length,
      bytes: f.declared.files.reduce((n, v) => n + v.size, 0),
    });
    expect(final.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(final.recheckMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(observations)).not.toContain(f.root);
    expect(JSON.stringify(observations)).not.toContain("preload.cjs");
    expect(Object.isFrozen(final)).toBe(true);
  });
  it("does not let a failing metrics sink hide an integrity refusal", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "preload.cjs"), "changed");
    const sink = vi.fn(() => {
      throw Error("private diagnostic sink failure");
    });
    await expect(
      verifyCoreResources(
        f.root,
        f.declared,
        f.core,
        performance.now() + 2000,
        sink,
      ),
    ).rejects.toMatchObject(refused);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.at(-1)[0].result).toBe("refused");
  });
  it("verifies the producer's complete dependency set without a self-hash cycle", async () => {
    const f = await fixture();
    expect(f.declared.files.map((file) => file.path)).toEqual(
      CORE_RESOURCE_ENTRIES,
    );
    expect(CORE_RESOURCE_ENTRIES).not.toContain("main.cjs");
    expect(CORE_RESOURCE_ENTRIES).not.toContain("build-manifest.json");
    expect(Object.isFrozen(f.declared.files)).toBe(true);
    await expect(verify(f)).resolves.toBeUndefined();
  });
  it.each([
    "preload.cjs",
    "shell.js",
    "runtime.cjs",
    "farol-backend",
    "core-artifact.json",
    "resource-manifest.json",
  ])("refuses changed %s bytes", async (name) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, name), "changed");
    await expect(verify(f)).rejects.toMatchObject(refused);
  });
  it("refuses a changed backend during producer assembly", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.root, "farol-backend"),
      Buffer.alloc(128, 2),
    );
    await expect(
      declareCoreResources(f.root, f.core, f.identity),
    ).rejects.toThrow("CORE_RESOURCE_BACKEND_CHANGED");
  });
  it.each(["symlink", "hardlink", "shared-write", "missing"])(
    "refuses a %s dependency",
    async (mode) => {
      const f = await fixture();
      const target = path.join(f.root, "preload.cjs");
      if (mode === "shared-write") await fs.chmod(target, 0o666);
      if (mode === "missing") await fs.unlink(target);
      if (mode === "hardlink")
        await fs.link(target, path.join(f.root, "alias"));
      if (mode === "symlink") {
        await fs.rename(target, path.join(f.root, "aliased"));
        await fs.symlink("aliased", target);
      }
      await expect(verify(f)).rejects.toMatchObject(refused);
    },
  );
  it("rejects crossed metadata before touching disk", async () => {
    const f = await fixture();
    const read = vi.spyOn(fs, "open");
    for (const change of [
      (v) => {
        v.core.build.buildId = "other";
      },
      (v) => {
        v.files.reverse();
      },
      (v) => {
        v.files[0].path = "../outside";
      },
      (v) => {
        v.files[0].path = "main.cjs";
      },
      (v) => {
        v.files[0].size = Infinity;
      },
      (v) => {
        v.files[0].sha256 = "unknown";
      },
      (v) => {
        v.files.push(v.files[0]);
      },
      (v) => {
        v.extra = true;
      },
    ]) {
      const changed = structuredClone(f.declared);
      change(changed);
      await expect(verify(f, changed)).rejects.toMatchObject(refused);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects accessor data without evaluating it", async () => {
    const f = await fixture();
    const getter = vi.fn(() => f.declared.files[0]);
    const declared = structuredClone(f.declared);
    Object.defineProperty(declared.files, "0", {
      get: getter,
      enumerable: true,
    });
    await expect(verify(f, declared)).rejects.toMatchObject(refused);
    expect(getter).not.toHaveBeenCalled();
  });
  it("checks the original deadline before file IO", async () => {
    const f = await fixture();
    const open = vi.spyOn(fs, "open");
    await expect(
      verifyCoreResources(f.root, f.declared, f.core, performance.now() - 1),
    ).rejects.toMatchObject(expired);
    expect(open).not.toHaveBeenCalled();
  });
  it("reports a budget spent while hashing apart from changed bytes", async () => {
    const f = await fixture();
    const original = fs.open.bind(fs);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      vi.mocked(performance.now).mockReturnValue(now + 101);
      return original(file, flags, mode);
    });
    await expect(
      verifyCoreResources(f.root, f.declared, f.core, now + 100),
    ).rejects.toMatchObject(expired);
  });
  it("detects replacement of an earlier dependency before final publication", async () => {
    const f = await fixture();
    const original = fs.open.bind(fs);
    const first = path.join(f.root, f.declared.files[0].path);
    const last = path.join(f.root, f.declared.files.at(-1).path);
    let changed = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (file === last && !changed) {
        changed = true;
        await fs.writeFile(first, "changed after hash");
      }
      return original(file, flags, mode);
    });
    await expect(verify(f)).rejects.toMatchObject(refused);
    expect(changed).toBe(true);
  });
});

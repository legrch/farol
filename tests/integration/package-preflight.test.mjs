import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";

const tooling = path.resolve(import.meta.dirname, "../../tooling");

// Actual CLI and production imports; metadata-only fixture, no build, native
// executable, vendor runtime or live package acceptance.
it("refuses a core-less 0.2 candidate before changing the retained package", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-package-preflight-")),
  );
  try {
    const fixtureTooling = path.join(root, "tooling");
    const builtRoot = path.join(root, "_output/build/app");
    const packageRoot = path.join(root, "_output/package");
    await fs.mkdir(fixtureTooling);
    await fs.mkdir(builtRoot, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    // Complete static .mjs import closure for package.mjs, copied unchanged.
    for (const name of [
      "package.mjs",
      "package-platform.mjs",
      "go-core-artifact.mjs",
      "release-identity.mjs",
      "artifact-digest.mjs",
      "build-contract.mjs",
      "build-identity-contract.mjs",
      "brand-contract.mjs",
      "font-contract.mjs",
      "runtime-contract.mjs",
      "source-identity.mjs",
      "package-layout.mjs",
    ])
      await fs.copyFile(
        path.join(tooling, name),
        path.join(fixtureTooling, name),
      );

    const digestDirectory = path.join(root, "src/pkg/artifact-tree-digest");
    await fs.mkdir(digestDirectory, { recursive: true });
    await fs.copyFile(
      path.join(tooling, "../src/pkg/artifact-tree-digest/digest.ts"),
      path.join(digestDirectory, "digest.ts"),
    );

    const document = {
      version: "0.2.0-owner.beta.3",
      farolRelease: {
        buildVersion: "17",
        updateChannel: "github-owner-beta",
      },
    };
    const identity = createBuildIdentity({
      version: document.version,
      ...document.farolRelease,
      builtAt: "2026-10-07T12:00:00.000Z",
      sourceCommit: "a".repeat(40),
      sourceTreeDigest: "b".repeat(64),
      sourceDirty: false,
    });
    const manifest = {
      schema: 3,
      product: identity.product,
      bundleId: identity.bundleId,
      version: identity.version,
      buildId: identity.buildId,
      builtAt: identity.builtAt,
      sourceMode: "head-exact",
      sourceCommit: identity.sourceCommit,
      sourceTreeDigest: identity.sourceTreeDigest,
      dirty: false,
      inputExact: true,
      inputLedgerSha256: "c".repeat(64),
      sourceInputCount: 1,
      dependencyInputCount: 1,
      entries: BUILD_ENTRIES,
      entrySha256: Object.fromEntries(
        BUILD_ENTRIES.map((entry) => [entry, "d".repeat(64)]),
      ),
    };
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(document),
    );
    await fs.writeFile(
      path.join(builtRoot, "build-manifest.json"),
      JSON.stringify(manifest),
    );
    const sentinel = Buffer.from("retained package evidence\0\xff", "latin1");
    const sentinelPath = path.join(packageRoot, "sentinel");
    await fs.writeFile(sentinelPath, sentinel);
    const before = await fs.lstat(packageRoot, { bigint: true });

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureTooling, "package.mjs")],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir() },
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PACKAGE_GO_CORE_REQUIRED");
    expect(await fs.readdir(packageRoot, { recursive: true })).toEqual([
      "sentinel",
    ]);
    expect(await fs.readFile(sentinelPath)).toEqual(sentinel);
    const after = await fs.lstat(packageRoot, { bigint: true });
    for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"])
      expect(after[key], key).toBe(before[key]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

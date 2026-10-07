import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyClosedRecoveryDevBuild } from "../../tooling/recover-closed-computer.mjs";
import {
  BUILD_ENTRIES,
  snapshotBuildEntries,
} from "../../tooling/build-contract.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  GO_CORE_ENTRIES,
  embedBuiltCore,
} from "../../tooling/go-core-artifact.mjs";
import { EXPECTED_RESOURCE_MANIFEST } from "../../tooling/resource-contract.mjs";

// Synthetic native-shaped bytes are never executed. No owner profile, process,
// credential, recovery effect or package is read/created by these checks.
const roots = [];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-dev-recovery-build-"),
  );
  roots.push(root);
  const directory = path.join(root, "_output/build/app");
  await fs.mkdir(directory, { recursive: true });
  for (const entry of BUILD_ENTRIES)
    await fs.writeFile(path.join(directory, entry), "synthetic build entry\n");
  const identity = createBuildIdentity({
    version: EXPECTED_RESOURCE_MANIFEST.product.version,
    builtAt: "2026-10-07T09:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    sourceDirty: false,
  });
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  const binary = path.join(root, "synthetic-unexecuted-core");
  await fs.writeFile(binary, bytes, { mode: 0o500 });
  const core = await embedBuiltCore(
    directory,
    {
      path: binary,
      buildId: identity.buildId,
      sourceCommit: identity.sourceCommit,
      sourceTreeDigest: identity.sourceTreeDigest,
      inputExact: true,
      entry: "./cmd/farol",
      goVersion: "go1.26.2",
      goos: "darwin",
      goarch: "arm64",
      cgoEnabled: false,
      trimpath: true,
      buildvcs: false,
      moduleMode: "readonly",
      size: bytes.length,
      sha256: sha(bytes),
    },
    identity,
  );
  await fs.writeFile(
    path.join(directory, "build-identity.json"),
    JSON.stringify(identity),
  );
  await fs.writeFile(
    path.join(directory, "resource-manifest.json"),
    JSON.stringify(EXPECTED_RESOURCE_MANIFEST),
  );
  const ledger = JSON.stringify([
    {
      path: "node_modules/synthetic/input",
      kind: "dependency",
      sha256: "c".repeat(64),
    },
    {
      path: "src/synthetic-input.ts",
      kind: "source",
      exact: true,
      sha256: "d".repeat(64),
    },
  ]);
  await fs.writeFile(path.join(directory, "input-manifest.json"), ledger);
  const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
  const manifest = {
    ...identity,
    schema: 4,
    core,
    sourceMode: "head-exact",
    inputExact: true,
    dirty: false,
    sourceInputCount: 1,
    dependencyInputCount: 1,
    inputLedgerSha256: sha(ledger),
    entries,
    entrySha256: await snapshotBuildEntries(directory, entries),
  };
  const save = () =>
    fs.writeFile(
      path.join(directory, "build-manifest.json"),
      JSON.stringify(manifest),
    );
  await save();
  return {
    root,
    directory,
    identity,
    manifest,
    save,
    current: {
      dirty: false,
      commit: identity.sourceCommit,
      treeDigest: identity.sourceTreeDigest,
    },
  };
}

describe("ordinary Dev closed maintenance build admission", () => {
  it("authenticates the fixed current Go build without requiring an installation package", async () => {
    const f = await fixture();
    expect(await verifyClosedRecoveryDevBuild(f.root, f.current)).toEqual(
      f.identity,
    );
    await expect(
      fs.stat(path.join(f.root, "_output/package")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["commit", "treeDigest", "dirty"])(
    "refuses crossed current source %s",
    async (key) => {
      const f = await fixture();
      await expect(
        verifyClosedRecoveryDevBuild(f.root, {
          ...f.current,
          [key]:
            key === "dirty" ? true : "e".repeat(key === "commit" ? 40 : 64),
        }),
      ).rejects.toThrow("CANDIDATE_SOURCE_NOT_EXACT");
    },
  );
  it.each(["schema", "inputExact", "dirty", "sourceMode"])(
    "refuses an unqualified build %s",
    async (key) => {
      const f = await fixture();
      f.manifest[key] = {
        schema: 3,
        inputExact: false,
        dirty: true,
        sourceMode: "working-tree",
      }[key];
      await f.save();
      await expect(
        verifyClosedRecoveryDevBuild(f.root, f.current),
      ).rejects.toThrow("CLOSED_COMPUTER_RECOVERY_BUILD_INVALID");
    },
  );
  it.each(["main.cjs", "farol-backend", "input-manifest.json"])(
    "refuses changed %s before any maintenance effect",
    async (entry) => {
      const f = await fixture();
      await fs.chmod(path.join(f.directory, entry), 0o600);
      await fs.appendFile(path.join(f.directory, entry), "tampered");
      await expect(
        verifyClosedRecoveryDevBuild(f.root, f.current),
      ).rejects.toThrow(/BUILD_ENTRY_DIGEST_MISMATCH/);
    },
  );
  it("refuses missing core and an identity that crosses the outer manifest", async () => {
    const f = await fixture();
    f.manifest.buildId = "e".repeat(64);
    await f.save();
    await expect(
      verifyClosedRecoveryDevBuild(f.root, f.current),
    ).rejects.toThrow("CLOSED_COMPUTER_RECOVERY_BUILD_INVALID");
    f.manifest.buildId = f.identity.buildId;
    f.manifest.core = undefined;
    await f.save();
    await expect(
      verifyClosedRecoveryDevBuild(f.root, f.current),
    ).rejects.toThrow("GO_CORE_ARTIFACT_INVALID");
  });
});

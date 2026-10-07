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
  const built = {
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
  };
  const core = await embedBuiltCore(directory, built, identity);
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
    built,
    manifest,
    save,
    current: {
      dirty: false,
      commit: identity.sourceCommit,
      treeDigest: identity.sourceTreeDigest,
    },
  };
}

// Controlled producer ports prove the ordering/comparison contract only. The
// production default always invokes buildGoBackend with authenticated inputs.
function verifyFixture(f, current = f.current, extra = {}) {
  return verifyClosedRecoveryDevBuild(f.root, current, {
    readInputs: async () => ({ toolchain: {}, moduleInputs: [] }),
    rebuildGo: async () => f.built,
    ...extra,
  });
}

describe("ordinary Dev closed maintenance build admission", () => {
  it("binds an independently reproduced core without requiring an installation package", async () => {
    const f = await fixture();
    expect(await verifyFixture(f)).toEqual(f.identity);
    await expect(
      fs.stat(path.join(f.root, "_output/package")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["commit", "treeDigest", "dirty"])(
    "refuses crossed current source %s",
    async (key) => {
      const f = await fixture();
      await expect(
        verifyFixture(f, {
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
      await expect(verifyFixture(f)).rejects.toThrow(
        "CLOSED_COMPUTER_RECOVERY_BUILD_INVALID",
      );
    },
  );
  it.each(["main.cjs", "farol-backend", "input-manifest.json"])(
    "refuses changed %s before any maintenance effect",
    async (entry) => {
      const f = await fixture();
      await fs.chmod(path.join(f.directory, entry), 0o600);
      await fs.appendFile(path.join(f.directory, entry), "tampered");
      await expect(verifyFixture(f)).rejects.toThrow(
        /BUILD_ENTRY_DIGEST_MISMATCH/,
      );
    },
  );
  it("refuses missing core and an identity that crosses the outer manifest", async () => {
    const f = await fixture();
    f.manifest.buildId = "e".repeat(64);
    await f.save();
    await expect(verifyFixture(f)).rejects.toThrow(
      "CLOSED_COMPUTER_RECOVERY_BUILD_INVALID",
    );
    f.manifest.buildId = f.identity.buildId;
    f.manifest.core = undefined;
    await f.save();
    await expect(verifyFixture(f)).rejects.toThrow("GO_CORE_ARTIFACT_INVALID");
  });

  it("does not admit self-asserted metadata when approved producer inputs are absent", async () => {
    const f = await fixture();
    // Real default, no fake producer or SDK, no native core execution.
    await expect(
      verifyClosedRecoveryDevBuild(f.root, f.current),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the fixed declaration and original exact identity in the independent producer", async () => {
    const f = await fixture();
    const inputs = { toolchain: { pin: "controlled" }, moduleInputs: [] };
    const seen = [];
    await verifyFixture(f, f.current, {
      readInputs: async (args) => {
        seen.push(args);
        return inputs;
      },
      rebuildGo: async (request) => {
        seen.push(request);
        return f.built;
      },
    });
    expect(seen).toEqual([
      [`--go-inputs=${path.join(f.root, "_output/go-build-inputs.json")}`],
      {
        repositoryRoot: f.root,
        buildIdentity: f.identity,
        toolchain: inputs.toolchain,
        platform: f.manifest.core.build.platform,
        moduleInputs: inputs.moduleInputs,
      },
    ]);
  });

  it.each([
    { sha256: "e".repeat(64) },
    { size: 129 },
    { goVersion: "go1.26.1" },
    { sourceCommit: "e".repeat(40) },
  ])("refuses an independent producer mismatch %j", async (changed) => {
    const f = await fixture();
    await expect(
      verifyFixture(f, f.current, {
        rebuildGo: async () => ({ ...f.built, ...changed }),
      }),
    ).rejects.toThrow("GO_CORE_ARTIFACT_INVALID");
  });

  it("refuses a host change during reproduction", async () => {
    const f = await fixture();
    await expect(
      verifyFixture(f, f.current, {
        rebuildGo: async () => {
          await fs.appendFile(path.join(f.directory, "main.cjs"), "changed");
          return f.built;
        },
      }),
    ).rejects.toThrow("BUILD_ENTRY_DIGEST_MISMATCH");
  });

  it("keeps missing inputs and an unknown producer fail-closed without a fallback", async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      verifyFixture(f, f.current, {
        readInputs: async () => null,
        rebuildGo: async () => {
          calls += 1;
        },
      }),
    ).rejects.toThrow("CLOSED_COMPUTER_RECOVERY_GO_INPUTS_REQUIRED");
    const unknown = new Error("OUTCOME_UNKNOWN");
    await expect(
      verifyFixture(f, f.current, {
        rebuildGo: async () => {
          calls += 1;
          throw unknown;
        },
      }),
    ).rejects.toBe(unknown);
    expect(calls).toBe(1);
  });
});

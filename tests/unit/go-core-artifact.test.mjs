import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  declarationFromBuiltCore,
  embedBuiltCore,
  verifyGoCoreArtifact,
} from "../../tooling/go-core-artifact.mjs";
import { readGoBuildInputs } from "../../tooling/go-build-inputs.mjs";
import { packageLayout } from "../../tooling/package-layout.mjs";

// Synthetic native-shaped bytes, never executed. These cases prove package
// correlation/tamper rejection, not Go provenance or a production build.
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-core-package-"));
  roots.push(root);
  const output = path.join(root, "output");
  await fs.mkdir(output);
  const binary = path.join(root, "synthetic");
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  await fs.writeFile(binary, bytes, { mode: 0o500 });
  const identity = createBuildIdentity({
    version: "0.1.9-owner.beta.1",
    buildVersion: "11",
    updateChannel: "github-owner-beta",
    builtAt: "2026-10-03T12:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    sourceDirty: false,
  });
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
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { root, output, built, identity };
}
describe("Go-enabled build/package composition", () => {
  it("embeds the direct builder result under the same outer identity", async () => {
    const f = await fixture();
    const declaration = await embedBuiltCore(f.output, f.built, f.identity);
    expect(
      await verifyGoCoreArtifact(f.output, declaration, f.identity),
    ).toEqual(declaration);
    expect(declaration.binary.path).toBe("farol-backend");
    expect(JSON.stringify(declaration)).not.toContain(f.root);
  });
  it.each(["buildId", "sourceCommit", "sourceTreeDigest"])(
    "rejects crossed builder %s",
    async (key) => {
      const f = await fixture();
      expect(() =>
        declarationFromBuiltCore(
          { ...f.built, [key]: "c".repeat(key === "sourceCommit" ? 40 : 64) },
          f.identity,
        ),
      ).toThrow("GO_CORE_ARTIFACT_INVALID");
    },
  );
  it("rejects dirty source and a test-only entry", async () => {
    const f = await fixture();
    expect(() =>
      declarationFromBuiltCore({ ...f.built, entry: "./cmd/k1" }, f.identity),
    ).toThrow();
    const dirty = createBuildIdentity({ ...f.identity, sourceDirty: true });
    expect(() => declarationFromBuiltCore(f.built, dirty)).toThrow();
  });
  it("detects changed binary bytes after copying", async () => {
    const f = await fixture();
    const d = await embedBuiltCore(f.output, f.built, f.identity);
    const file = path.join(f.output, "farol-backend");
    await fs.chmod(file, 0o700);
    await fs.appendFile(file, "changed");
    await expect(verifyGoCoreArtifact(f.output, d, f.identity)).rejects.toThrow(
      "GO_CORE_ARTIFACT_INVALID",
    );
  });
  it("detects changed declaration even when the binary stayed unchanged", async () => {
    const f = await fixture();
    const d = await embedBuiltCore(f.output, f.built, f.identity);
    await fs.writeFile(
      path.join(f.output, "core-artifact.json"),
      JSON.stringify({ ...d, binary: { ...d.binary, sha256: "e".repeat(64) } }),
    );
    await expect(verifyGoCoreArtifact(f.output, d, f.identity)).rejects.toThrow(
      "GO_CORE_ARTIFACT_INVALID",
    );
  });
  it.each(["symlink", "hardlink", "oversized"])(
    "rejects %s artifact metadata before accepting its claim",
    async (kind) => {
      const f = await fixture();
      const d = await embedBuiltCore(f.output, f.built, f.identity);
      const file = path.join(f.output, "core-artifact.json");
      const other = path.join(f.root, "metadata.json");
      if (kind === "oversized") {
        await fs.writeFile(file, " ".repeat(8193));
      } else {
        await fs.rename(file, other);
        if (kind === "symlink") await fs.symlink(other, file);
        else await fs.link(other, file);
      }
      await expect(
        verifyGoCoreArtifact(f.output, d, f.identity),
      ).rejects.toThrow();
    },
  );
  it("does not overwrite an existing embedded backend", async () => {
    const f = await fixture();
    await embedBuiltCore(f.output, f.built, f.identity);
    await expect(
      embedBuiltCore(f.output, f.built, f.identity),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("rejects a redirected native binary", async () => {
    const f = await fixture();
    const linked = path.join(f.root, "link");
    await fs.symlink(f.built.path, linked);
    await expect(
      embedBuiltCore(f.output, { ...f.built, path: linked }, f.identity),
    ).rejects.toThrow();
  });
  it("keeps legacy generations explicit and marks Go package generation separately", () => {
    expect(packageLayout(5).branded).toBe(false);
    expect(packageLayout(6).branded).toBe(true);
    expect(packageLayout(7).core).toBe(true);
    expect(() => packageLayout(8)).toThrow();
  });
  it("requires an explicit bounded recipe and refuses unrelated options", async () => {
    expect(await readGoBuildInputs([])).toBeNull();
    await expect(readGoBuildInputs(["--go-inputs=relative"])).rejects.toThrow();
    await expect(readGoBuildInputs(["--unknown"])).rejects.toThrow();
    const f = await fixture();
    const file = path.join(f.root, "recipe.json");
    const recipe = {
      schema: "farol-go-build-inputs/1",
      toolchain: { root: "/explicit/sdk", treeSha256: "a".repeat(64) },
      moduleInputs: [],
    };
    await fs.writeFile(file, JSON.stringify(recipe));
    expect(await readGoBuildInputs([`--go-inputs=${file}`])).toEqual(recipe);
    await fs.writeFile(
      file,
      JSON.stringify({ ...recipe, binary: "/existing/prebuilt" }),
    );
    await expect(readGoBuildInputs([`--go-inputs=${file}`])).rejects.toThrow(
      "GO_INPUTS_INVALID",
    );
  });
});

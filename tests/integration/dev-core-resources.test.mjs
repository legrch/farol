import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopCoreArtifactRoot } from "../../apps/desktop/dev-core-layout.ts";
import { prepareDevCoreResources } from "../../tooling/dev-core-resources.mjs";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { GO_CORE_ENTRIES } from "../../tooling/go-core-artifact.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";

vi.mock("../../tooling/source-identity.mjs", () => ({
  sourceIdentity: () => ({
    commit: "b".repeat(40),
    treeDigest: "c".repeat(64),
    dirty: false,
    reasons: [],
  }),
}));
vi.mock("../../tooling/runtime-contract.mjs", () => ({
  observeEmbeddedRuntime: vi.fn(async () => ({
    extractedTreeDigest: "d".repeat(64),
  })),
  assertEmbeddedRuntime: vi.fn(),
}));
vi.mock("../../tooling/build-contract.mjs", async (original) => ({
  ...(await original()),
  verifyInputManifest: vi.fn(async () => {}),
}));
vi.mock("../../tooling/go-core-artifact.mjs", async (original) => ({
  ...(await original()),
  verifyGoCoreArtifact: vi.fn(async () => {}),
}));

// Real disposable filesystem, entry SHA verification and layout selection.
// Go input and vendor qualification are doubles; native proof is separate.
describe("admitted source Dev resources", () => {
  let root, source, destination;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-core-")),
    );
    source = path.join(root, "_output/build/app");
    destination = desktopCoreArtifactRoot(source, "dev");
    await fs.mkdir(source, { recursive: true, mode: 0o700 });
    const vendor = path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS",
    );
    await fs.mkdir(vendor, { recursive: true });
    await fs.writeFile(path.join(vendor, "Electron"), "fixture vendor", {
      mode: 0o755,
    });
    const identity = createBuildIdentity({
      version: "1.0.0",
      builtAt: "2026-10-24T00:00:00.000Z",
      sourceCommit: "b".repeat(40),
      sourceTreeDigest: "c".repeat(64),
      sourceDirty: false,
    });
    const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
    const entrySha256 = {};
    for (const name of entries) {
      const bytes = Buffer.from(
        name === "build-identity.json"
          ? JSON.stringify(identity)
          : `fixture ${name}`,
      );
      await fs.writeFile(path.join(source, name), bytes, {
        mode: name === "farol-backend" ? 0o755 : 0o600,
      });
      entrySha256[name] = createHash("sha256").update(bytes).digest("hex");
    }
    await fs.writeFile(
      path.join(source, "build-manifest.json"),
      JSON.stringify({
        schema: 4,
        dirty: false,
        inputExact: true,
        sourceMode: "head-exact",
        buildId: identity.buildId,
        entries,
        entrySha256,
        core: {},
      }),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("copies only declared bytes, preserves backend execute mode, and reuses the same resource identity", async () => {
    await fs.writeFile(path.join(source, "unrelated.txt"), "must not copy");
    expect(await prepareDevCoreResources(root)).toBe(destination);
    expect(
      (await fs.stat(path.join(destination, "farol-backend"))).mode & 0o111,
    ).not.toBe(0);
    await expect(
      fs.lstat(path.join(destination, "unrelated.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const first = await fs.stat(path.resolve(destination, "../../.."));
    expect(await prepareDevCoreResources(root)).toBe(destination);
    expect((await fs.stat(path.resolve(destination, "../../.."))).ino).toBe(
      first.ino,
    );
  });
  it("refuses changed built backend bytes before publishing resources", async () => {
    await fs.appendFile(path.join(source, "farol-backend"), "changed");
    await expect(prepareDevCoreResources(root)).rejects.toThrow();
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("replaces an intact earlier build only after verifying the new declared bytes", async () => {
    await prepareDevCoreResources(root);
    const bundle = path.resolve(destination, "../../..");
    const before = await fs.stat(bundle);
    const identity = createBuildIdentity({
      version: "1.0.0",
      builtAt: "2026-10-24T01:00:00.000Z",
      sourceCommit: "b".repeat(40),
      sourceTreeDigest: "c".repeat(64),
      sourceDirty: false,
    });
    const bytes = Buffer.from(JSON.stringify(identity));
    await fs.writeFile(path.join(source, "build-identity.json"), bytes);
    const file = path.join(source, "build-manifest.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.buildId = identity.buildId;
    manifest.entrySha256["build-identity.json"] = createHash("sha256")
      .update(bytes)
      .digest("hex");
    await fs.writeFile(file, JSON.stringify(manifest));
    expect(await prepareDevCoreResources(root)).toBe(destination);
    expect((await fs.stat(bundle)).ino).not.toBe(before.ino);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(destination, "build-identity.json"),
          "utf8",
        ),
      ).buildId,
    ).toBe(identity.buildId);
  });
  it("does not follow a substituted receipt link", async () => {
    await prepareDevCoreResources(root);
    const receipt = path.join(root, "_output/dev-core-resources.json");
    await fs.unlink(receipt);
    const canary = path.join(root, "canary.json");
    await fs.writeFile(canary, "private fixture canary");
    await fs.symlink(canary, receipt);
    await expect(prepareDevCoreResources(root)).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await fs.readFile(canary, "utf8")).toBe("private fixture canary");
  });
  it("preserves changed cached resources rather than repairing them", async () => {
    await prepareDevCoreResources(root);
    await fs.appendFile(path.join(destination, "farol-backend"), "changed");
    await expect(prepareDevCoreResources(root)).rejects.toThrow(
      "DEV_CORE_RESOURCES_CHANGED",
    );
    expect(
      await fs.readFile(path.join(destination, "farol-backend"), "utf8"),
    ).toContain("changed");
  });
  it("refuses an unowned existing resource tree and a symlink alias", async () => {
    const bundle = path.resolve(destination, "../../..");
    await fs.mkdir(bundle);
    await fs.writeFile(path.join(bundle, "preserve"), "unowned");
    await expect(prepareDevCoreResources(root)).rejects.toThrow(
      "DEV_CORE_RESOURCES_CHANGED",
    );
    expect(await fs.readFile(path.join(bundle, "preserve"), "utf8")).toBe(
      "unowned",
    );
    const alias = path.join(root, "alias");
    await fs.symlink(root, alias);
    await expect(prepareDevCoreResources(alias)).rejects.toThrow(
      "DEV_CORE_DIRECTORY_UNSAFE",
    );
  });
});

it("selects the fixed Dev layout without changing packaged or preview roots", () => {
  expect(desktopCoreArtifactRoot("/repo/_output/build/app", "dev")).toBe(
    "/repo/_output/dev-core/Contents/Resources/app",
  );
  expect(desktopCoreArtifactRoot("/app/Contents/Resources/app", "dev")).toBe(
    "/app/Contents/Resources/app",
  );
  expect(desktopCoreArtifactRoot("/repo/_output/build/app", "preview")).toBe(
    "/repo/_output/build/app",
  );
  expect(() => desktopCoreArtifactRoot("/other/root", "dev")).toThrow(
    "DEV_CORE_LAYOUT_INVALID",
  );
  expect(() => desktopCoreArtifactRoot("relative", "dev")).toThrow(
    "DEV_CORE_LAYOUT_INVALID",
  );
});

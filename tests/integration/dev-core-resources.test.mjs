import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopCoreArtifactRoot,
  desktopDevShellImageMatches,
} from "../../apps/desktop/dev-core-layout.ts";
import {
  prepareDevCoreResources,
  readPreparedDevCore,
} from "../../tooling/dev-core-resources.mjs";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { GO_CORE_ENTRIES } from "../../tooling/go-core-artifact.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";

vi.mock("../../tooling/dev-runtime.mjs", () => ({
  DEV_CORE_EXECUTABLE_SUFFIX:
    "/_output/dev-core/Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron",
  prepareDevRuntime: vi.fn(async (_root, parent) => {
    const file = path.join(parent, "Farol Dev.app/Contents/MacOS/Electron");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture signed runtime", { mode: 0o755 });
    return file;
  }),
  verifyDevSignature: vi.fn(),
}));

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
// Go input, vendor qualification and Dev signing are doubles; native proof is separate.
describe("admitted source Dev resources", () => {
  let root, source, destination;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-core-")),
    );
    source = path.join(root, "_output/build/app");
    destination = path.join(root, "_output/dev-core/Contents/Resources/app");
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
  async function advanceBuild(hour) {
    const identity = createBuildIdentity({
      version: "1.0.0",
      builtAt: `2026-10-24T0${hour}:00:00.000Z`,
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
    return identity;
  }
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("qualifies a sealed current image without republishing or replacing it", async () => {
    await prepareDevCoreResources(root);
    const receipt = path.join(root, "_output/dev-core-resources.json");
    const before = {
      bytes: await fs.readFile(receipt),
      stat: await fs.stat(receipt),
    };
    const bundleBefore = await fs.stat(path.join(root, "_output/dev-core"));
    expect(await readPreparedDevCore(root)).toMatchObject({
      sourceCommit: "b".repeat(40),
      executable: path.join(
        root,
        "_output/dev-core/Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron",
      ),
    });
    expect(await fs.readFile(receipt)).toEqual(before.bytes);
    expect((await fs.stat(receipt)).mtimeMs).toBe(before.stat.mtimeMs);
    expect((await fs.stat(path.join(root, "_output/dev-core"))).ino).toBe(
      bundleBefore.ino,
    );
  });
  it("leaves the image alone when current sources cannot qualify it", async () => {
    await prepareDevCoreResources(root);
    const module = await import("../../tooling/source-identity.mjs");
    const original = module.sourceIdentity(root);
    const source = vi
      .spyOn(module, "sourceIdentity")
      .mockReturnValueOnce({ ...original, dirty: true });
    const receipt = path.join(root, "_output/dev-core-resources.json");
    const bytes = await fs.readFile(receipt);
    try {
      await expect(readPreparedDevCore(root)).rejects.toThrow(
        "DEV_RUNNING_SOURCE_UNCONFIRMED",
      );
      expect(await fs.readFile(receipt)).toEqual(bytes);
    } finally {
      source.mockRestore();
    }
  });
  it("refuses a changed image instead of repairing it for reopen", async () => {
    await prepareDevCoreResources(root);
    const file = path.join(destination, "main.cjs");
    await fs.writeFile(file, "changed fixture bytes");
    await expect(readPreparedDevCore(root)).rejects.toThrow(
      "DEV_RUNNING_IMAGE_UNCONFIRMED",
    );
    expect(await fs.readFile(file, "utf8")).toBe("changed fixture bytes");
  });
  it("refuses an unsettled image receipt without completing publication", async () => {
    await prepareDevCoreResources(root);
    const file = path.join(root, "_output/dev-core-resources.json");
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    const bytes = JSON.stringify({ ...receipt, schema: 3 });
    await fs.writeFile(file, bytes);
    await expect(readPreparedDevCore(root)).rejects.toThrow(
      "DEV_RUNNING_IMAGE_UNCONFIRMED",
    );
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
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
  it("retains retired images without recursive deletion during publication or reuse", async () => {
    await prepareDevCoreResources(root);
    await advanceBuild(1);
    const original = fs.rm.bind(fs);
    const cleanup = vi
      .spyOn(fs, "rm")
      .mockImplementation(async (target, options) => {
        expect(path.basename(target).startsWith(".dev-core-retired-")).toBe(
          false,
        );
        return original(target, options);
      });
    try {
      expect(await prepareDevCoreResources(root)).toBe(destination);
      expect(await prepareDevCoreResources(root)).toBe(destination);
      const retired = (await fs.readdir(path.join(root, "_output"))).filter(
        (name) => name.startsWith(".dev-core-retired-"),
      );
      expect(retired).toHaveLength(1);
      expect(
        await fs.readFile(
          path.join(
            root,
            "_output",
            retired[0],
            "Contents/Resources/app/main.cjs",
          ),
          "utf8",
        ),
      ).toBe("fixture main.cjs");
    } finally {
      cleanup.mockRestore();
    }
  });

  it("recovers interruption after atomic retirement but before publishing the new image", async () => {
    await prepareDevCoreResources(root);
    await advanceBuild(1);
    const bundle = path.resolve(destination, "../../..");
    const original = fs.rename.bind(fs);
    let retired;
    const move = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await original(from, to);
      if (from === bundle) {
        retired = to;
        throw new Error("controlled interrupted rename");
      }
    });
    try {
      await expect(prepareDevCoreResources(root)).rejects.toThrow(
        "controlled interrupted rename",
      );
    } finally {
      move.mockRestore();
    }
    await expect(fs.lstat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await prepareDevCoreResources(root)).toBe(destination);
    expect((await fs.lstat(retired)).isDirectory()).toBe(true);
  });

  it("does not clean a retired directory whose recorded identity changed", async () => {
    await prepareDevCoreResources(root);
    const file = path.join(root, "_output/dev-core-resources.json");
    const previous = JSON.parse(await fs.readFile(file, "utf8"));
    const name = ".dev-core-retired-11111111-1111-4111-8111-111111111111";
    const foreign = path.join(root, "_output", name);
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, "retained.txt"), "retain");
    const info = await fs.stat(foreign);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...previous,
        schema: 3,
        previousTreeDigest: previous.treeDigest,
        retired: {
          name,
          device: String(info.dev),
          inode: String(info.ino + 1),
        },
      }),
    );
    await expect(prepareDevCoreResources(root)).rejects.toThrow(
      "DEV_CORE_RETIRED_CHANGED",
    );
    expect(await fs.readFile(path.join(foreign, "retained.txt"), "utf8")).toBe(
      "retain",
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
  it.each(["old-image-present", "old-image-removed"])(
    "recovers a recorded interrupted replacement: %s",
    async (point) => {
      await prepareDevCoreResources(root);
      const file = path.join(root, "_output/dev-core-resources.json");
      const previous = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(
        file,
        JSON.stringify({
          ...previous,
          schema: 2,
          buildId: "f".repeat(64),
          treeDigest: "e".repeat(64),
          previousTreeDigest: previous.treeDigest,
        }),
      );
      if (point === "old-image-removed")
        await fs.rm(path.resolve(destination, "../../.."), { recursive: true });
      const current = await advanceBuild(2);
      expect(await prepareDevCoreResources(root)).toBe(destination);
      const settled = JSON.parse(await fs.readFile(file, "utf8"));
      expect(settled.schema).toBe(1);
      expect(settled.buildId).toBe(current.buildId);
      expect(settled.previousTreeDigest).toBeUndefined();
    },
  );
  it("recovers a published new image with a pending receipt even after the next build", async () => {
    await prepareDevCoreResources(root);
    const file = path.join(root, "_output/dev-core-resources.json");
    const previous = JSON.parse(await fs.readFile(file, "utf8"));
    await advanceBuild(1);
    await prepareDevCoreResources(root);
    const published = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(
      file,
      JSON.stringify({
        ...published,
        schema: 2,
        previousTreeDigest: previous.treeDigest,
      }),
    );
    const current = await advanceBuild(2);
    expect(await prepareDevCoreResources(root)).toBe(destination);
    expect(JSON.parse(await fs.readFile(file, "utf8")).buildId).toBe(
      current.buildId,
    );
  });
  it("does not repair unrecorded disappearance or edited pending resources", async () => {
    await prepareDevCoreResources(root);
    const file = path.join(root, "_output/dev-core-resources.json");
    const previous = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(
      file,
      JSON.stringify({
        ...previous,
        schema: 2,
        previousTreeDigest: "e".repeat(64),
      }),
    );
    await fs.appendFile(path.join(destination, "farol-backend"), "unexpected");
    await expect(prepareDevCoreResources(root)).rejects.toThrow(
      "DEV_CORE_RESOURCES_CHANGED",
    );
    await fs.rm(path.resolve(destination, "../../.."), { recursive: true });
    await fs.writeFile(file, JSON.stringify(previous));
    await expect(prepareDevCoreResources(root)).rejects.toThrow(
      "DEV_CORE_RESOURCES_MISSING",
    );
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

it("keeps actual runtime roots and qualifies only the matching protected Dev image", () => {
  expect(desktopCoreArtifactRoot("/repo/_output/build/app", "dev")).toBe(
    "/repo/_output/build/app",
  );
  expect(desktopCoreArtifactRoot("/app/Contents/Resources/app", "dev")).toBe(
    "/app/Contents/Resources/app",
  );
  expect(desktopCoreArtifactRoot("/repo/_output/build/app", "preview")).toBe(
    "/repo/_output/build/app",
  );
  const resources = "/repo/_output/dev-core/Contents/Resources/app";
  const executable =
    "/repo/_output/dev-core/Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron";
  expect(desktopDevShellImageMatches(resources, executable)).toBe(true);
  for (const [root, host] of [
    ["/repo/_output/build/app", executable],
    [
      resources,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ],
    ["/other/_output/dev-core/Contents/Resources/app", executable],
    ["relative", executable],
  ])
    expect(desktopDevShellImageMatches(root, host)).toBe(false);
  expect(() => desktopCoreArtifactRoot("relative", "dev")).toThrow(
    "DEV_CORE_LAYOUT_INVALID",
  );
});

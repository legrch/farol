import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  devInfoPlist,
  devExecutables,
  prepareDevRuntime,
} from "../../tooling/dev-runtime.mjs";
import { launchPreview } from "../../tooling/dev.mjs";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { observeEmbeddedRuntime } from "../../tooling/runtime-contract.mjs";

vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  spawnSync: vi.fn(),
}));
vi.mock("../../tooling/runtime-contract.mjs", async (original) => ({
  ...(await original()),
  assertEmbeddedRuntime: vi.fn(),
  observeEmbeddedRuntime: vi.fn(),
}));

// Plist transformation only. Actual Dock/Cmd-Tab naming requires native proof.
const vendor = `<?xml version="1.0"?><plist><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleVersion</key><string>44.4.2</string></dict></plist>`;

describe("Dev-only macOS bundle presentation", () => {
  it("changes only the four explicit presentation fields", () => {
    const result = devInfoPlist(vendor);
    expect(result.match(/<string>Farol Dev<\/string>/gu)).toHaveLength(2);
    expect(result).toContain("<string>local.farol.dev</string>");
    expect(result).toContain("<string>farol-dev.icns</string>");
    expect(result).toContain(
      "<key>CFBundleExecutable</key><string>Electron</string>",
    );
    expect(result).toContain(
      "<key>CFBundleVersion</key><string>44.4.2</string>",
    );
    expect(vendor).toContain("<string>com.github.Electron</string>");
  });
  it.each([
    vendor.replace("com.github.Electron", "local.farol.owner.preview"),
    vendor.replace("<key>CFBundleName</key>", "<key>unexpected</key>"),
    vendor + "<key>CFBundleName</key><string>Electron</string>",
  ])(
    "refuses unexpected input instead of editing a foreign identity",
    (plist) => {
      expect(() => devInfoPlist(plist)).toThrow("DEV_RUNTIME_PLIST_INVALID");
    },
  );
  it("limits restart compatibility to three exact checkout executables", () => {
    expect(devExecutables("/fixture/farol")).toEqual([
      "/fixture/farol/_output/dev-core/Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron",
      "/fixture/farol/_output/dev-runtime/Farol Dev.app/Contents/MacOS/Electron",
      "/fixture/farol/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ]);
  });
});

// Disposable filesystem and mocked vendor attestation/system tool only.
// Native codesign and Electron execution require the separate live check.
describe("Dev bundle signing before launch", () => {
  let root;
  let source;
  let destination;
  beforeEach(async () => {
    vi.resetAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-signing-"));
    source = path.join(root, "node_modules/electron/dist/Electron.app");
    destination = path.join(root, "_output/dev-runtime/Farol Dev.app");
    await fs.mkdir(path.join(source, "Contents/Resources"), {
      recursive: true,
    });
    await fs.writeFile(path.join(source, "Contents/Info.plist"), vendor);
    const resources = path.join(root, "resources/brand/sunrise-dock");
    await fs.mkdir(resources, { recursive: true });
    await fs.copyFile(
      new URL(
        "../../resources/brand/sunrise-dock/farol-sunrise-dev.icns",
        import.meta.url,
      ),
      path.join(resources, "farol-sunrise-dev.icns"),
    );
    observeEmbeddedRuntime.mockImplementation(async (app) => ({
      extractedTreeDigest: await treeDigest(app),
    }));
    spawnSync.mockReturnValue({
      status: 0,
      stderr: "Identifier=local.farol.dev\n",
    });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("signs the edited copy, strictly verifies, then inspects its identifier", async () => {
    expect(await prepareDevRuntime(root)).toBe(
      path.join(destination, "Contents/MacOS/Electron"),
    );
    const calls = spawnSync.mock.calls;
    expect(calls).toHaveLength(3);
    const app = calls[0][1].at(-1);
    expect(app).toMatch(/\/\.prepare-[^/]+\/Farol Dev\.app$/u);
    expect(calls.map(([command, args]) => [command, args])).toEqual([
      [
        "/usr/bin/codesign",
        ["--force", "--deep", "--sign", "-", "--timestamp=none", app],
      ],
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", app]],
      ["/usr/bin/codesign", ["--display", "--verbose=4", app]],
    ]);
    expect(
      await fs.readFile(path.join(destination, "Contents/Info.plist"), "utf8"),
    ).toBe(devInfoPlist(vendor));
    expect(
      await fs.readFile(path.join(source, "Contents/Info.plist"), "utf8"),
    ).toBe(vendor);
  });

  it.each([
    "signing",
    "signature verification",
    "signature inspection",
    "identifier",
  ])(
    "blocks launch on %s failure without publishing the copy",
    async (failure) => {
      const success = { status: 0, stderr: "Identifier=local.farol.dev\n" };
      if (failure !== "signing") spawnSync.mockReturnValueOnce(success);
      if (["signature inspection", "identifier"].includes(failure))
        spawnSync.mockReturnValueOnce(success);
      spawnSync.mockReturnValueOnce(
        failure === "identifier"
          ? { status: 0, stderr: "Identifier=com.github.Electron\n" }
          : { status: 1, stderr: "fixture failure" },
      );
      const launch = vi.fn();
      await expect(
        launchPreview(
          root,
          launch,
          false,
          false,
          undefined,
          {},
          prepareDevRuntime,
        ),
      ).rejects.toThrow(/Farol Dev .*No launch was attempted/u);
      expect(launch).not.toHaveBeenCalled();
      await expect(fs.access(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(path.dirname(destination))).toEqual([]);
    },
  );

  it("reuses unchanged bytes while verifying the signature again", async () => {
    const executable = await prepareDevRuntime(root);
    const before = await fs.stat(destination);
    spawnSync.mockClear();
    expect(await prepareDevRuntime(root)).toBe(executable);
    expect((await fs.stat(destination)).ino).toBe(before.ino);
    expect(
      spawnSync.mock.calls.map(([command, args]) => [command, args]),
    ).toEqual([
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]],
      ["/usr/bin/codesign", ["--display", "--verbose=4", destination]],
    ]);
    spawnSync.mockReturnValueOnce({ status: 1 });
    const launch = vi.fn();
    await expect(
      launchPreview(
        root,
        launch,
        false,
        false,
        undefined,
        {},
        prepareDevRuntime,
      ),
    ).rejects.toThrow("signature verification failed");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rebuilds when vendor bytes change and never falls back after signing fails", async () => {
    await prepareDevRuntime(root);
    const before = await fs.stat(destination);
    await fs.writeFile(
      path.join(source, "Contents/Resources/vendor-change"),
      "changed",
    );
    spawnSync.mockClear();
    await prepareDevRuntime(root);
    expect((await fs.stat(destination)).ino).not.toBe(before.ino);
    expect(spawnSync.mock.calls[0][1].slice(0, -1)).toEqual([
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
    ]);
    await fs.writeFile(
      path.join(source, "Contents/Resources/vendor-change"),
      "changed again",
    );
    spawnSync.mockReturnValueOnce({
      error: new Error("fixture unavailable"),
      status: null,
    });
    const launch = vi.fn();
    await expect(
      launchPreview(
        root,
        launch,
        false,
        false,
        undefined,
        {},
        prepareDevRuntime,
      ),
    ).rejects.toThrow("signing failed");
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses modified cached output or unapproved Dev resources", async () => {
    await prepareDevRuntime(root);
    await fs.writeFile(
      path.join(destination, "Contents/Resources/injected"),
      "changed",
    );
    await expect(prepareDevRuntime(root)).rejects.toThrow(
      "Farol Dev bundle changed",
    );
    await fs.writeFile(
      path.join(root, "resources/brand/sunrise-dock/farol-sunrise-dev.icns"),
      "unapproved",
    );
    await expect(prepareDevRuntime(root)).rejects.toThrow(
      "DEV_RUNTIME_ICON_INVALID",
    );
  });
});

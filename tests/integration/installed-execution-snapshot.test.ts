import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureInstalledExecutionSnapshot } from "../../src/apps/desktop/installed-execution-snapshot";
import { treeDigest } from "../../src/pkg/artifact-tree-digest/digest";

// Real disposable filesystem and a tiny shell canary, not an installed Electron
// image, another account, a production profile or native update acceptance.
let root: string;
let app: string;
let parent: string;
let executable: string;
let digest: string;
let copy: ReturnType<
  typeof vi.fn<(source: string, destination: string) => Promise<void>>
>;
const capture = () =>
  captureInstalledExecutionSnapshot({
    sourceApp: app,
    sourceExecutable: executable,
    privateParent: parent,
    expectedDigest: digest,
    copyApp: copy,
    physicalFiles: fs,
  });
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-execution-image-")),
  );
  app = path.join(root, "public/Farol.app");
  parent = path.join(root, "private");
  executable = path.join(app, "Contents/MacOS/runtime");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(path.join(app, "Contents/Resources/app"), { recursive: true });
  await fs.mkdir(parent, { mode: 0o700 });
  await fs.writeFile(
    executable,
    '#!/bin/sh\ncat "$(dirname "$0")/../Resources/app/payload"\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(app, "Contents/Resources/app/payload"),
    "accepted",
  );
  digest = await treeDigest(app);
  copy = vi.fn((source: string, destination: string) =>
    fs.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    }),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("authenticated private installed execution image", () => {
  it("executes accepted private bytes even after the public script changes", async () => {
    const image = await capture();
    expect(image.digest).toBe(digest);
    expect(image.executable).toContain(parent + "/installed-execution/");
    await fs.writeFile(
      path.join(app, "Contents/Resources/app/payload"),
      "substituted",
    );
    await image.recheck();
    const { stdout } = await promisify(execFile)(image.executable, [], {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(stdout).toBe("accepted");
  });
  it("reuses only a fully authenticated private image", async () => {
    const first = await capture();
    const second = await capture();
    expect(second.executable).toBe(first.executable);
    expect(copy).toHaveBeenCalledTimes(1);
    await second.recheck();
  });
  it.each(["Contents/MacOS/runtime", "Contents/Resources/app/payload"])(
    "rejects changed public %s before copying or executing it",
    async (file) => {
      await fs.appendFile(path.join(app, file), "hostile");
      await expect(capture()).rejects.toThrow(
        "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
      );
      expect(copy).not.toHaveBeenCalled();
    },
  );
  it("rejects displacement during capture and retains the failed capture", async () => {
    copy.mockImplementationOnce(async (source: string, destination: string) => {
      await fs.cp(source, destination, { recursive: true });
      await fs.rename(source, source + ".displaced");
      await fs.cp(source + ".displaced", source, { recursive: true });
    });
    await expect(capture()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    expect(
      (await fs.readdir(path.join(parent, "installed-execution"))).some(
        (name) => name.startsWith(".capture-"),
      ),
    ).toBe(true);
  });
  it("rejects copying different bytes even when the source stays unchanged", async () => {
    copy.mockImplementationOnce(async (source: string, destination: string) => {
      await fs.cp(source, destination, { recursive: true });
      await fs.writeFile(
        path.join(destination, "Contents/Resources/app/payload"),
        "hostile",
      );
    });
    await expect(capture()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
  });
  it("rejects a modified private image and never overwrites it", async () => {
    const image = await capture();
    await fs.writeFile(path.join(image.directory, "payload"), "hostile");
    await expect(image.recheck()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    await expect(capture()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    expect(copy).toHaveBeenCalledTimes(1);
  });
  it("refuses a replaced source root before executing the captured image", async () => {
    const image = await capture();
    await fs.rename(app, app + ".displaced");
    await fs.cp(app + ".displaced", app, { recursive: true });
    await expect(image.recheck()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
  });
  it("refuses a missing or aliased executable before creating a cache", async () => {
    await fs.rename(executable, executable + ".real");
    await expect(capture()).rejects.toMatchObject({ code: "ENOENT" });
    await fs.symlink("runtime.real", executable);
    await expect(capture()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    expect(copy).not.toHaveBeenCalled();
  });
  it("refuses an existing incomplete cache rather than adopting or deleting it", async () => {
    await fs.mkdir(path.join(parent, "installed-execution", digest), {
      recursive: true,
      mode: 0o700,
    });
    await expect(capture()).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
  });
  it("rejects a source alias, an outside executable and a public private-parent", async () => {
    const alias = path.join(root, "alias.app");
    await fs.symlink(app, alias);
    await expect(
      captureInstalledExecutionSnapshot({
        sourceApp: alias,
        sourceExecutable: executable,
        privateParent: parent,
        expectedDigest: digest,
        copyApp: copy,
      }),
    ).rejects.toThrow("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    await expect(
      captureInstalledExecutionSnapshot({
        sourceApp: app,
        sourceExecutable: path.join(root, "outside"),
        privateParent: parent,
        expectedDigest: digest,
        copyApp: copy,
      }),
    ).rejects.toThrow("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    await fs.chmod(parent, 0o755);
    await expect(capture()).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    expect(copy).not.toHaveBeenCalled();
  });
});

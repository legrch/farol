import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as launchSnapshot from "../../tooling/launch-snapshot.mjs";
import {
  createLaunchSnapshot,
  removeLaunchSnapshot,
} from "../../tooling/launch-snapshot.mjs";

// macOS LaunchServices registers a bundle, and each nested helper bundle, the
// first time a process runs out of it, and keeps the record after the
// directory is deleted. The launch snapshot must therefore unregister the exact
// bundle paths it created, and nothing else, before it removes the directory.

const owned = [];

afterEach(async () => {
  for (const directory of owned.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixtureSnapshot() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-launch-registration-")),
  );
  owned.push(root);
  const sourceApp = path.join(root, "Farol.app");
  const runtime = path.join(
    sourceApp,
    "Contents/Frameworks/Electron Runtime.app",
  );
  const helper = path.join(runtime, "Contents/Frameworks/Electron Helper.app");
  await fs.mkdir(path.join(helper, "Contents/MacOS"), { recursive: true });
  await fs.mkdir(path.join(sourceApp, "Contents/Resources/app"), {
    recursive: true,
  });
  const temporaryRoot = path.join(root, "tmp");
  await fs.mkdir(temporaryRoot);
  const snapshot = await createLaunchSnapshot({
    sourceApp,
    artifactBytes: Buffer.from("{}\n"),
    artifactSha256: "e".repeat(64),
    temporaryRoot,
  });
  return { root, snapshot, temporaryRoot };
}

describe("launch snapshot LaunchServices cleanup", () => {
  it("unregisters every exact bundle path, deepest first, before deleting the directory", async () => {
    const { snapshot } = await fixtureSnapshot();
    const calls = [];
    const outcome = await removeLaunchSnapshot(snapshot, {
      lsregister: process.execPath,
      unregister: async (_tool, bundlePath) => {
        // The bundle must still be on disk when it is unregistered.
        await fs.access(bundlePath);
        calls.push(bundlePath);
        return true;
      },
    });
    const outer = snapshot.appPath;
    const runtime = path.join(
      outer,
      "Contents/Frameworks/Electron Runtime.app",
    );
    const helper = path.join(
      runtime,
      "Contents/Frameworks/Electron Helper.app",
    );
    expect(calls).toEqual([helper, runtime, outer]);
    expect(outcome).toEqual({
      unregistered: [helper, runtime, outer],
      failed: [],
      refused: [],
    });
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never unregisters a path outside the snapshot, nor follows a symlink out of it", async () => {
    const { root, snapshot, temporaryRoot } = await fixtureSnapshot();
    const outside = path.join(root, "Outside.app");
    await fs.mkdir(path.join(outside, "Inner.app"), { recursive: true });
    const sibling = path.join(temporaryRoot, "other-app.app");
    await fs.mkdir(sibling);
    await fs.symlink(outside, path.join(snapshot.root, "Link.app"));
    const calls = [];
    await removeLaunchSnapshot(snapshot, {
      lsregister: process.execPath,
      unregister: async (_tool, bundlePath) => {
        calls.push(bundlePath);
        return true;
      },
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const bundlePath of calls) {
      expect(bundlePath.startsWith(`${snapshot.root}${path.sep}`)).toBe(true);
      expect(bundlePath).not.toContain("Outside.app");
      expect(bundlePath).not.toContain("Link.app");
    }
    await expect(fs.stat(sibling)).resolves.toBeDefined();
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it("exposes no unregister entry point that skips the ownership validation", () => {
    expect(launchSnapshot.unregisterLaunchSnapshot).toBeUndefined();
    expect(Object.keys(launchSnapshot).sort()).toEqual(
      [
        "createLaunchSnapshot",
        "ownerLaunchArguments",
        "ownerLaunchEnvironment",
        "removeLaunchSnapshot",
      ].sort(),
    );
  });

  it("unregisters only canonical paths, even when the temporary root is reached through a symlink", async () => {
    const { root, snapshot } = await fixtureSnapshot();
    const alias = path.join(root, "alias");
    await fs.symlink(snapshot.temporaryRoot, alias);
    const viaAlias = {
      ...snapshot,
      root: path.join(alias, path.basename(snapshot.root)),
      temporaryRoot: alias,
    };
    viaAlias.appPath = path.join(viaAlias.root, "Farol.app");
    viaAlias.artifactFile = path.join(viaAlias.root, "artifact.json");
    const calls = [];
    await removeLaunchSnapshot(viaAlias, {
      lsregister: process.execPath,
      unregister: async (_tool, bundlePath) => {
        calls.push(bundlePath);
        return true;
      },
    });
    expect(calls.length).toBe(3);
    for (const bundlePath of calls) {
      expect(bundlePath.startsWith(`${snapshot.root}${path.sep}`)).toBe(true);
      expect(bundlePath).not.toContain(`${path.sep}alias${path.sep}`);
    }
  });

  it("refuses a snapshot root that is itself a symlink, and unregisters nothing", async () => {
    const { root, snapshot, temporaryRoot } = await fixtureSnapshot();
    const victim = path.join(root, "Victim");
    await fs.mkdir(path.join(victim, "Real.app"), { recursive: true });
    const link = path.join(
      temporaryRoot,
      `farol-next-launch-${"e".repeat(12)}-link`,
    );
    await fs.symlink(victim, link);
    let called = false;
    await expect(
      removeLaunchSnapshot(
        {
          ...snapshot,
          root: link,
          appPath: path.join(link, "Farol.app"),
          artifactFile: path.join(link, "artifact.json"),
        },
        {
          lsregister: process.execPath,
          unregister: async () => {
            called = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    expect(called).toBe(false);
    await expect(fs.stat(path.join(victim, "Real.app"))).resolves.toBeDefined();
  });

  it("refuses a descriptor whose root is not directly under its temporary root", async () => {
    const { root, snapshot } = await fixtureSnapshot();
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    const moved = path.join(elsewhere, path.basename(snapshot.root));
    await fs.cp(snapshot.root, moved, { recursive: true });
    let called = false;
    await expect(
      removeLaunchSnapshot(
        {
          ...snapshot,
          root: moved,
          appPath: path.join(moved, "Farol.app"),
          artifactFile: path.join(moved, "artifact.json"),
        },
        {
          lsregister: process.execPath,
          unregister: async () => {
            called = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    expect(called).toBe(false);
    await expect(fs.stat(moved)).resolves.toBeDefined();
  });

  it("reports a failed unregister but still removes the snapshot", async () => {
    const { snapshot } = await fixtureSnapshot();
    const outcome = await removeLaunchSnapshot(snapshot, {
      lsregister: process.execPath,
      unregister: async () => false,
    });
    expect(outcome.unregistered).toEqual([]);
    expect(outcome.failed).toContain(snapshot.appPath);
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    [
      "a bundle it has no record of",
      'echo "failed to scan: -10814" >&2; exit 1',
      true,
    ],
    ["any other failure", 'echo "boom" >&2; exit 2', false],
    ["success", "exit 0", true],
  ])("the real runner treats %s correctly", async (_name, body, ok) => {
    const { root, snapshot } = await fixtureSnapshot();
    const tool = path.join(root, "fake-lsregister");
    await fs.writeFile(tool, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const outcome = await removeLaunchSnapshot(snapshot, { lsregister: tool });
    expect(outcome[ok ? "unregistered" : "failed"]).toContain(snapshot.appPath);
    expect(outcome[ok ? "failed" : "unregistered"]).toEqual([]);
  });

  it("skips quietly where lsregister does not exist", async () => {
    const { snapshot } = await fixtureSnapshot();
    const outcome = await removeLaunchSnapshot(snapshot, {
      lsregister: path.join(os.tmpdir(), "no-such-lsregister"),
      unregister: async () => {
        throw new Error("must not run");
      },
    });
    expect(outcome).toEqual({ unregistered: [], failed: [], refused: [] });
  });

  it("does not unregister when the descriptor is not an owned snapshot", async () => {
    const { root } = await fixtureSnapshot();
    const unrelated = path.join(root, `farol-next-launch-${"f".repeat(12)}-x`);
    await fs.mkdir(path.join(unrelated, "Farol.app"), { recursive: true });
    let called = false;
    await expect(
      removeLaunchSnapshot(
        {
          appPath: path.join(unrelated, "Farol.app"),
          artifactFile: path.join(unrelated, "artifact.json"),
          artifactSha256: "a".repeat(64),
          prefix: `farol-next-launch-${"f".repeat(12)}-`,
          root: unrelated,
          temporaryRoot: root,
        },
        {
          lsregister: process.execPath,
          unregister: async () => {
            called = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    expect(called).toBe(false);
  });
});

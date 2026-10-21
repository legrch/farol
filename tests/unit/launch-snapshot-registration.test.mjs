import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      errors: [],
      removed: true,
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
        "finishLaunchSnapshot",
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
    // A descriptor issued by createLaunchSnapshot, with the root reached via the alias.
    const viaAlias = await createLaunchSnapshot({
      sourceApp: path.join(root, "Farol.app"),
      artifactBytes: Buffer.from("{}\n"),
      artifactSha256: "1".repeat(64),
      temporaryRoot: alias,
    });
    expect(viaAlias.root.startsWith(`${alias}${path.sep}`)).toBe(true);
    const realRoot = await fs.realpath(viaAlias.root);
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
      expect(bundlePath.startsWith(`${realRoot}${path.sep}`)).toBe(true);
      expect(bundlePath).not.toContain(`${path.sep}alias${path.sep}`);
    }
  });

  describe("only a descriptor this process issued is unregistered", () => {
    const forgedFor = async (root, temporaryRoot) => {
      // Every field a shape check looks at, for a directory the caller chose.
      const sha = "7".repeat(64);
      const prefix = `farol-next-launch-${sha.slice(0, 12)}-`;
      const victimRoot = path.join(temporaryRoot, `${prefix}forged`);
      const bundle = path.join(victimRoot, "Farol.app");
      await fs.mkdir(path.join(bundle, "Contents/Frameworks/Other.app"), {
        recursive: true,
      });
      return {
        appPath: bundle,
        artifactFile: path.join(victimRoot, "artifact.json"),
        artifactSha256: sha,
        prefix,
        root: victimRoot,
        temporaryRoot,
      };
    };

    it("makes no lsregister call for a forged descriptor and reports it refused", async () => {
      const { root, temporaryRoot } = await fixtureSnapshot();
      const forged = await forgedFor(root, temporaryRoot);
      const calls = [];
      const outcome = await removeLaunchSnapshot(forged, {
        lsregister: process.execPath,
        unregister: async (_tool, bundlePath) => {
          calls.push(bundlePath);
          return true;
        },
      });
      expect(calls).toEqual([]);
      expect(outcome.unregistered).toEqual([]);
      expect(outcome.failed).toEqual([]);
      expect(outcome.refused).toEqual([
        "descriptor not issued by this process",
      ]);
      // Deletion keeps its validated behaviour for a shape-valid descriptor.
      expect(outcome.removed).toBe(true);
      await expect(fs.stat(forged.root)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("treats a copy of an issued descriptor as not issued", async () => {
      const { snapshot } = await fixtureSnapshot();
      const calls = [];
      const outcome = await removeLaunchSnapshot(
        { ...snapshot },
        {
          lsregister: process.execPath,
          unregister: async (_tool, bundlePath) => {
            calls.push(bundlePath);
            return true;
          },
        },
      );
      expect(calls).toEqual([]);
      expect(outcome.refused).toEqual([
        "descriptor not issued by this process",
      ]);
    });

    it("still unregisters the exact descriptor createLaunchSnapshot returned", async () => {
      const { snapshot } = await fixtureSnapshot();
      const calls = [];
      const outcome = await removeLaunchSnapshot(snapshot, {
        lsregister: process.execPath,
        unregister: async (_tool, bundlePath) => {
          calls.push(bundlePath);
          return true;
        },
      });
      expect(calls).toHaveLength(3);
      expect(outcome.unregistered).toHaveLength(3);
      expect(outcome.refused).toEqual([]);
    });
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

  // Fixture bytes measured 2026-10-21 on macOS 27.0.1 (26A434) with the real
  // `lsregister -u` on a never-registered bundle: exit 1, empty stdout, stderr
  // exactly `failed to scan <path>: -10814\n from spotlight` (no trailing newline).
  const MEASURED = `printf 'failed to scan %s: -10814\\n from spotlight' "$2" >&2; exit 1`;
  it.each([
    ["the measured not-registered message (exit 1)", MEASURED, true],
    ["success", "exit 0", true],
    [
      "the near miss `failed to scan: -10814` (exit 1)",
      'echo "failed to scan: -10814" >&2; exit 1',
      false,
    ],
    [
      "the measured message with another exit status",
      MEASURED.replace("exit 1", "exit 2"),
      false,
    ],
    [
      "the measured message plus stdout output",
      `echo extra; ${MEASURED}`,
      false,
    ],
    [
      "the measured message plus a trailing line",
      `printf 'failed to scan %s: -10814\\n from spotlight\\nmore' "$2" >&2; exit 1`,
      false,
    ],
    [
      "another verb with -10814",
      `printf 'failed to register %s: -10814\\n from spotlight' "$2" >&2; exit 1`,
      false,
    ],
    [
      "the measured message naming another path",
      `printf 'failed to scan /elsewhere/X.app: -10814\\n from spotlight' >&2; exit 1`,
      false,
    ],
    ["any other failure", 'echo "boom" >&2; exit 2', false],
  ])("the real runner treats %s correctly", async (_name, body, ok) => {
    const { root, snapshot } = await fixtureSnapshot();
    const tool = path.join(root, "fake-lsregister");
    await fs.writeFile(tool, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const outcome = await removeLaunchSnapshot(snapshot, { lsregister: tool });
    expect(outcome[ok ? "unregistered" : "failed"]).toContain(snapshot.appPath);
    expect(outcome[ok ? "failed" : "unregistered"]).toEqual([]);
    if (!ok) {
      // A failure keeps its raw message, next to the path.
      expect(outcome.errors).toHaveLength(3);
      expect(outcome.errors.join("\n")).toContain(`${snapshot.appPath}: exit `);
    } else {
      expect(outcome.errors).toEqual([]);
    }
  });

  it("removes the snapshot and reports the error when a directory cannot be read mid-walk", async () => {
    const { snapshot } = await fixtureSnapshot();
    const runtime = path.join(
      snapshot.appPath,
      "Contents/Frameworks/Electron Runtime.app",
    );
    const original = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, "readdir")
      .mockImplementation((target, ...rest) =>
        target === runtime
          ? Promise.reject(
              Object.assign(new Error("denied"), { code: "EACCES" }),
            )
          : original(target, ...rest),
      );
    try {
      const calls = [];
      const outcome = await removeLaunchSnapshot(snapshot, {
        lsregister: process.execPath,
        unregister: async (_tool, bundlePath) => {
          calls.push(bundlePath);
          return true;
        },
      });
      expect(outcome.errors).toEqual([`${runtime}: EACCES`]);
      // What could be enumerated is still unregistered, and the walk goes on.
      expect(calls).toEqual([runtime, snapshot.appPath]);
    } finally {
      spy.mockRestore();
    }
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the snapshot and reports the error when the unregister step throws", async () => {
    const { snapshot } = await fixtureSnapshot();
    const outcome = await removeLaunchSnapshot(snapshot, {
      lsregister: process.execPath,
      unregister: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(outcome.errors.length).toBe(3);
    expect(outcome.errors[0]).toContain("spawn failed");
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ignores a directory that vanishes mid-walk without reporting an error", async () => {
    const { snapshot } = await fixtureSnapshot();
    const runtime = path.join(
      snapshot.appPath,
      "Contents/Frameworks/Electron Runtime.app",
    );
    const original = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, "readdir")
      .mockImplementation((target, ...rest) =>
        target === runtime
          ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
          : original(target, ...rest),
      );
    try {
      const outcome = await removeLaunchSnapshot(snapshot, {
        lsregister: process.execPath,
        unregister: async () => true,
      });
      expect(outcome.errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe("every found bundle is accounted for in exactly one bucket", () => {
    const fakeTool = async (root, body) => {
      const tool = path.join(root, "fake-lsregister");
      await fs.writeFile(tool, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return tool;
    };
    const cases = [
      {
        name: "success",
        options: () => ({
          lsregister: process.execPath,
          unregister: async () => true,
        }),
        expected: { unregistered: 3 },
      },
      {
        name: "measured not-registered message from the real runner",
        options: async (root) => ({
          lsregister: await fakeTool(root, MEASURED),
        }),
        expected: { unregistered: 3 },
      },
      {
        name: "non-zero exit from the real runner",
        options: async (root) => ({
          lsregister: await fakeTool(root, "echo boom >&2; exit 2"),
        }),
        expected: { failed: 3, errors: 3 },
      },
      {
        name: "near miss `failed to scan: -10814` from the real runner",
        options: async (root) => ({
          lsregister: await fakeTool(
            root,
            'echo "failed to scan: -10814" >&2; exit 1',
          ),
        }),
        expected: { failed: 3, errors: 3 },
      },
      {
        name: "thrown runner",
        options: () => ({
          lsregister: process.execPath,
          unregister: async () => {
            throw new Error("spawn failed");
          },
        }),
        expected: { failed: 3, errors: 3 },
      },
      {
        name: "refused path",
        options: () => ({
          lsregister: process.execPath,
          unregister: async () => true,
        }),
        refuseRuntime: true,
        expected: { unregistered: 2, refused: 1 },
      },
      {
        name: "missing lsregister",
        options: (root) => ({
          lsregister: path.join(root, "no-such-lsregister"),
          unregister: async () => {
            throw new Error("must not run");
          },
        }),
        expected: {
          failed: 3,
          errors: 1,
          errorMatches: "no-such-lsregister: ENOENT",
        },
      },
      {
        name: "failing final delete",
        options: () => ({
          lsregister: process.execPath,
          unregister: async () => true,
        }),
        failRemove: true,
        expected: {
          unregistered: 3,
          errors: 1,
          errorMatches: "remove ",
          kept: true,
        },
      },
      {
        name: "readdir failure mid-walk",
        options: () => ({
          lsregister: process.execPath,
          unregister: async () => true,
        }),
        failRuntimeRead: true,
        // The helper below the unreadable directory is never found.
        found: ["runtime", "outer"],
        expected: { unregistered: 2, errors: 1 },
      },
    ];
    it.each(cases)("$name", async (scenario) => {
      const { root, snapshot } = await fixtureSnapshot();
      const outer = snapshot.appPath;
      const runtime = path.join(
        outer,
        "Contents/Frameworks/Electron Runtime.app",
      );
      const helper = path.join(
        runtime,
        "Contents/Frameworks/Electron Helper.app",
      );
      const byName = { outer, runtime, helper };
      const found = (scenario.found ?? ["helper", "runtime", "outer"]).map(
        (name) => byName[name],
      );
      const spies = [];
      if (scenario.refuseRuntime) {
        const original = fs.realpath.bind(fs);
        spies.push(
          vi
            .spyOn(fs, "realpath")
            .mockImplementation((target, ...rest) =>
              target === runtime
                ? Promise.resolve(`${runtime}-moved`)
                : original(target, ...rest),
            ),
        );
      }
      if (scenario.failRuntimeRead) {
        const original = fs.readdir.bind(fs);
        spies.push(
          vi
            .spyOn(fs, "readdir")
            .mockImplementation((target, ...rest) =>
              target === runtime
                ? Promise.reject(
                    Object.assign(new Error("denied"), { code: "EACCES" }),
                  )
                : original(target, ...rest),
            ),
        );
      }
      if (scenario.failRemove) {
        const original = fs.rm.bind(fs);
        spies.push(
          vi
            .spyOn(fs, "rm")
            .mockImplementation((target, ...rest) =>
              target === snapshot.root
                ? Promise.reject(
                    Object.assign(new Error("busy"), { code: "EBUSY" }),
                  )
                : original(target, ...rest),
            ),
        );
      }
      let outcome;
      try {
        // Once validation has passed, nothing may throw.
        outcome = await removeLaunchSnapshot(
          snapshot,
          await scenario.options(root),
        );
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const buckets = [
        ...outcome.unregistered,
        ...outcome.failed,
        ...outcome.refused,
      ];
      // The found set equals the union of the buckets, with no path in two.
      expect(new Set(buckets).size).toBe(buckets.length);
      expect([...buckets].sort()).toEqual([...found].sort());
      const want = scenario.expected;
      expect(outcome.unregistered.length).toBe(want.unregistered ?? 0);
      expect(outcome.failed.length).toBe(want.failed ?? 0);
      expect(outcome.refused.length).toBe(want.refused ?? 0);
      expect(outcome.errors.length).toBe(want.errors ?? 0);
      if (want.errorMatches)
        expect(outcome.errors[0]).toContain(want.errorMatches);
      expect(outcome.removed).toBe(!want.kept);
      if (want.kept) {
        await expect(fs.stat(snapshot.root)).resolves.toBeDefined();
      } else {
        await expect(fs.stat(snapshot.root)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  });

  describe("the launcher's cleanup step never changes the launch outcome", () => {
    it("reports a failed delete on stderr, does not throw and leaves the exit status alone", async () => {
      const { snapshot } = await fixtureSnapshot();
      const original = fs.rm.bind(fs);
      const spy = vi
        .spyOn(fs, "rm")
        .mockImplementation((target, ...rest) =>
          target === snapshot.root
            ? Promise.reject(
                Object.assign(new Error("busy"), { code: "EBUSY" }),
              )
            : original(target, ...rest),
        );
      const written = [];
      const exitCode = process.exitCode;
      try {
        await expect(
          launchSnapshot.finishLaunchSnapshot(snapshot, {
            write: (text) => written.push(text),
          }),
        ).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(process.exitCode).toBe(exitCode);
      expect(written.join("")).toContain(`remove ${snapshot.root}: EBUSY`);
      expect(written.join("")).toContain("snapshot directory not removed");
    });

    it("reports a refused descriptor instead of throwing, and deletes nothing", async () => {
      const { root } = await fixtureSnapshot();
      const written = [];
      await expect(
        launchSnapshot.finishLaunchSnapshot(
          { root },
          { write: (text) => written.push(text) },
        ),
      ).resolves.toBeUndefined();
      expect(written.join("")).toContain("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
      await expect(fs.stat(root)).resolves.toBeDefined();
    });

    it("stays silent after a clean removal", async () => {
      const { snapshot } = await fixtureSnapshot();
      const written = [];
      await launchSnapshot.finishLaunchSnapshot(snapshot, {
        remove: (descriptor) =>
          removeLaunchSnapshot(descriptor, {
            lsregister: process.execPath,
            unregister: async () => true,
          }),
        write: (text) => written.push(text),
      });
      expect(written).toEqual([]);
    });

    it("run-preview runs cleanup only through that step, in its finally", async () => {
      const source = await fs.readFile(
        path.join(process.cwd(), "tooling/run-preview.mjs"),
        "utf8",
      );
      expect(source).toContain("await finishLaunchSnapshot(snapshot)");
      expect(source).not.toContain("removeLaunchSnapshot");
      const finallyAt = source.lastIndexOf("} finally {");
      expect(source.indexOf("finishLaunchSnapshot(snapshot)")).toBeGreaterThan(
        finallyAt,
      );
    });
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

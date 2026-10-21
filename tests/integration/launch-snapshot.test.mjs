import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchSnapshot,
  ownerLaunchEnvironment,
  ownerLaunchArguments,
  removeLaunchSnapshot,
} from "../../tooling/launch-snapshot.mjs";

const ownedSnapshots = [];

afterEach(async () => {
  await Promise.all(
    ownedSnapshots.splice(0).map(async (snapshot) => {
      await removeLaunchSnapshot(snapshot);
    }),
  );
});

describe("isolated owner launch snapshot", () => {
  it("copies the candidate and freezes the manifest outside the mutable package", async () => {
    const sourceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-launch-source-"),
    );
    try {
      const sourceApp = path.join(sourceRoot, "Farol.app");
      await fs.mkdir(path.join(sourceApp, "Contents"), { recursive: true });
      const sourceFile = path.join(sourceApp, "Contents", "payload.txt");
      await fs.writeFile(sourceFile, "verified bytes\n");
      const artifactBytes = Buffer.from('{"schema":3}\n');

      const snapshot = await createLaunchSnapshot({
        sourceApp,
        artifactBytes,
        artifactSha256: "a".repeat(64),
      });
      ownedSnapshots.push(snapshot);
      await fs.writeFile(sourceFile, "replacement bytes\n");

      expect(snapshot.appPath).not.toBe(sourceApp);
      expect(path.basename(snapshot.appPath)).toBe("Farol.app");
      expect(await fs.readFile(snapshot.artifactFile)).toEqual(artifactBytes);
      expect(
        await fs.readFile(
          path.join(snapshot.appPath, "Contents", "payload.txt"),
          "utf8",
        ),
      ).toBe("verified bytes\n");
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("passes only the owner identity and deterministic process environment", () => {
    expect(
      ownerLaunchEnvironment({
        HOME: "/Users/owner",
        LANG: "pt_PT.UTF-8",
        LC_ALL: "C",
        PATH: "/tmp/poisoned-bin",
        TMPDIR: "/private/tmp/owner/",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        ELECTRON_RUN_AS_NODE: "1",
        FAROL_OWNER_LAUNCH: "1",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
      }),
    ).toEqual({
      HOME: "/Users/owner",
      LANG: "pt_PT.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/private/tmp/owner/",
    });
  });

  it("passes only an exact saved-chat owner opt-in, never a malformed value", () => {
    expect(
      ownerLaunchEnvironment({ FAROL_SAVED_CHAT_PREVIEW: "1" }),
    ).toHaveProperty("FAROL_SAVED_CHAT_PREVIEW", "1");
    for (const value of ["0", "true", "1\nFAROL_E2E=1"]) {
      expect(
        ownerLaunchEnvironment({ FAROL_SAVED_CHAT_PREVIEW: value }),
      ).not.toHaveProperty("FAROL_SAVED_CHAT_PREVIEW");
    }
  });

  it("refuses cleanup descriptors that do not name an owned snapshot", async () => {
    const unrelated = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-launch-unrelated-"),
    );
    try {
      await expect(
        removeLaunchSnapshot({
          appPath: path.join(unrelated, "Farol.app"),
          artifactFile: path.join(unrelated, "artifact.json"),
          artifactSha256: "b".repeat(64),
          prefix: `farol-launch-${"b".repeat(12)}-`,
          root: unrelated,
          temporaryRoot: path.dirname(unrelated),
        }),
      ).rejects.toThrow("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
      await expect(fs.stat(unrelated)).resolves.toBeDefined();
    } finally {
      await fs.rm(unrelated, { recursive: true, force: true });
    }
  });
});

describe("owner launch presentation arguments", () => {
  it.each([
    [[], []],
    [["--demo"], ["--demo"]],
    [["--hidden"], ["--preview-window-mode=hidden", "--owner-background-only"]],
    [
      ["--demo", "--hidden"],
      ["--demo", "--preview-window-mode=hidden", "--owner-background-only"],
    ],
    [
      ["--hidden", "--demo"],
      ["--preview-window-mode=hidden", "--owner-background-only", "--demo"],
    ],
  ])("maps only the explicit presentation flags %j", (input, expected) => {
    expect(ownerLaunchArguments(input)).toEqual(expected);
  });

  it.each([
    ["--hidden", "--hidden"],
    ["--demo", "--demo"],
    ["--demo", "--hidden", "--demo"],
    ["--preview-window-mode=hidden"],
    ["--preview-window-mode=secondary-visible"],
    ["--allow-primary-display"],
    ["--owner-background-only"],
    ["--user-data-dir=/tmp/other-profile"],
    ["--remote-debugging-port=9222"],
    ["--hidden", "--user-data-dir=/tmp/other-profile"],
    ["--hidden\0--demo"],
  ])(
    "refuses extra, repeated and profile-changing arguments %j",
    (...input) => {
      expect(() => ownerLaunchArguments(input)).toThrow(
        "task run accepts only '--demo' and '--hidden', each at most once",
      );
    },
  );
});

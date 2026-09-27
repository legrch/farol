import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchSnapshot,
  ownerLaunchEnvironment,
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
      path.join(os.tmpdir(), "farol-next-launch-source-"),
    );
    try {
      const sourceApp = path.join(sourceRoot, "Farol Next Preview.app");
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
      expect(path.basename(snapshot.appPath)).toBe("Farol Next Preview.app");
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
        FAROL_NEXT_OWNER_LAUNCH: "1",
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
      ownerLaunchEnvironment({ FAROL_NEXT_SAVED_CHAT_PREVIEW: "1" }),
    ).toHaveProperty("FAROL_NEXT_SAVED_CHAT_PREVIEW", "1");
    for (const value of ["0", "true", "1\nFAROL_NEXT_E2E=1"]) {
      expect(
        ownerLaunchEnvironment({ FAROL_NEXT_SAVED_CHAT_PREVIEW: value }),
      ).not.toHaveProperty("FAROL_NEXT_SAVED_CHAT_PREVIEW");
    }
  });

  it("refuses cleanup descriptors that do not name an owned snapshot", async () => {
    const unrelated = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-launch-unrelated-"),
    );
    try {
      await expect(
        removeLaunchSnapshot({
          appPath: path.join(unrelated, "Farol Next Preview.app"),
          artifactFile: path.join(unrelated, "artifact.json"),
          artifactSha256: "b".repeat(64),
          prefix: `farol-next-launch-${"b".repeat(12)}-`,
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

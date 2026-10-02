import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopIdentity } from "../../src/apps/desktop/desktop-environment";
import {
  DEV_DATA_DIRECTORY_NAME,
  LEGACY_DEV_DATA_DIRECTORY_NAME,
  resolveDevDataDirectoryName,
  resolvePhysicalDevDataDirectoryName,
  type ProfileDirectoryIdentity,
} from "../../src/apps/desktop/dev-profile-directory";

const roots: string[] = [];
const directory: ProfileDirectoryIdentity = {
  device: "1",
  inode: "101",
  directory: true,
  symbolicLink: false,
};
const appData = "/private/tmp/Owner's Mac/Application Support";

function resolveEntries(
  legacy: ProfileDirectoryIdentity | null,
  preferred: ProfileDirectoryIdentity | null,
): string {
  return resolveDevDataDirectoryName(appData, (candidate) => {
    if (candidate === path.join(appData, LEGACY_DEV_DATA_DIRECTORY_NAME))
      return legacy;
    expect(candidate).toBe(path.join(appData, DEV_DATA_DIRECTORY_NAME));
    return preferred;
  });
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DEV profile spelling compatibility", () => {
  it("selects Farol Dev for a genuinely new installation", () => {
    expect(resolveEntries(null, null)).toBe("Farol Dev");
  });

  it("retains a new-spelling profile on a case-sensitive volume", () => {
    expect(resolveEntries(null, directory)).toBe("Farol Dev");
  });

  it("retains the old profile path without deriving it from the display name", () => {
    expect(resolveEntries(directory, null)).toBe("Farol DEV");
    const identity = desktopIdentity("dev", appData, "Farol DEV");
    expect(identity.displayName).toBe("Farol Dev");
    expect(identity.applicationName).toBe("Farol Dev");
    expect(identity.userData).toBe(path.join(appData, "Farol DEV"));
    expect(identity.sessionData).toBe(identity.userData);
    expect(identity.codexHome).toBe(
      path.join(identity.userData, "farol-next-private", "codex-home"),
    );
  });

  it("recognizes case-insensitive aliases by device AND inode", () => {
    expect(resolveEntries(directory, { ...directory })).toBe("Farol Dev");
  });

  it.each([
    { ...directory, inode: "202" },
    { ...directory, device: "2" },
  ])(
    "refuses distinct existing profiles rather than choosing or merging",
    (other) => {
      expect(() => resolveEntries(directory, other)).toThrow(
        "DEV_PROFILE_DIRECTORY_AMBIGUOUS",
      );
    },
  );

  it.each([
    { ...directory, directory: false },
    { ...directory, symbolicLink: true },
  ])("rejects unsafe directory entries", (unsafe) => {
    expect(() => resolveEntries(unsafe, null)).toThrow(
      "DEV_PROFILE_DIRECTORY_UNSAFE",
    );
    expect(() => resolveEntries(null, unsafe)).toThrow(
      "DEV_PROFILE_DIRECTORY_UNSAFE",
    );
  });

  it("does not treat an unreadable path as a new installation", () => {
    expect(() =>
      resolveDevDataDirectoryName(appData, () => {
        throw new Error("DEV_PROFILE_DIRECTORY_UNREADABLE");
      }),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNREADABLE");
  });

  it.each(["relative", "/private/tmp/invalid\0path"])(
    "rejects an invalid appData root before inspecting (%s)",
    (root) => {
      let probes = 0;
      expect(() =>
        resolveDevDataDirectoryName(root, () => {
          probes += 1;
          return null;
        }),
      ).toThrow("DESKTOP_APP_DATA_INVALID");
      expect(probes).toBe(0);
    },
  );

  it("keeps the profile selector closed even at an untyped call boundary", () => {
    expect(() =>
      desktopIdentity("dev", appData, "../other" as "Farol Dev"),
    ).toThrow("DEV_PROFILE_DIRECTORY_INVALID");
    expect(desktopIdentity("preview", appData, "Farol DEV").userData).toBe(
      path.join(appData, "Farol Next Preview"),
    );
  });

  it("reads only directory metadata and does not create, move, or reset a profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-name-"));
    roots.push(root);
    expect(resolveDevDataDirectoryName(root)).toBe("Farol Dev");
    expect(await fs.readdir(root)).toEqual([]);
    const legacy = path.join(root, "Farol DEV");
    await fs.mkdir(legacy, { mode: 0o700 });
    await fs.writeFile(
      path.join(legacy, "synthetic-settings.txt"),
      "keep-this-fixture",
      { mode: 0o600 },
    );
    const before = await fs.lstat(legacy);
    const resolved = path.join(root, resolveDevDataDirectoryName(root));
    expect(await fs.readdir(root)).toEqual(["Farol DEV"]);
    const after = await fs.lstat(resolved);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(
      await fs.readFile(path.join(legacy, "synthetic-settings.txt"), "utf8"),
    ).toBe("keep-this-fixture");
  });

  it("refuses a real symlink instead of following it into another profile", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-name-link-"),
    );
    roots.push(root);
    const target = path.join(root, "unrelated");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(root, "Farol Dev"));
    expect(() => resolveDevDataDirectoryName(root)).toThrow(
      "DEV_PROFILE_DIRECTORY_UNSAFE",
    );
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("supplies the physical profile path before Desktop locks and MCP admission", async () => {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-physical-profile-"),
    );
    const root = await fs.realpath(temporary);
    roots.push(root);
    const legacy = path.join(root, LEGACY_DEV_DATA_DIRECTORY_NAME);
    await fs.mkdir(legacy, { mode: 0o700 });
    const before = await fs.lstat(legacy);
    const identity = desktopIdentity(
      "dev",
      root,
      resolvePhysicalDevDataDirectoryName(root),
    );
    expect(await fs.realpath(identity.userData)).toBe(identity.userData);
    expect(identity.sessionData).toBe(identity.userData);
    const after = await fs.lstat(identity.userData);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await fs.readdir(root)).toEqual([LEGACY_DEV_DATA_DIRECTORY_NAME]);
  });

  it("keeps a genuinely new profile fixed without canonicalizing an absent entry", () => {
    expect(
      resolvePhysicalDevDataDirectoryName(
        appData,
        () => null,
        () => {
          throw new Error("MUST_NOT_CANONICALIZE_MISSING_PROFILE");
        },
      ),
    ).toBe(DEV_DATA_DIRECTORY_NAME);
  });

  it.each([DEV_DATA_DIRECTORY_NAME, LEGACY_DEV_DATA_DIRECTORY_NAME])(
    "selects the physical same-inode alias %s without changing edition or partitions",
    (physicalName) => {
      const name = resolvePhysicalDevDataDirectoryName(
        appData,
        () => ({ ...directory }),
        () => path.join(appData, physicalName),
      );
      const identity = desktopIdentity("dev", appData, name);
      expect(identity.userData).toBe(path.join(appData, physicalName));
      expect(identity.applicationId).toBe("local.farol.dev");
      expect(identity.chatGptPartition).toBe("persist:farol-dev-chatgpt");
      expect(identity.displayEdition).toBe("Development");
    },
  );

  it.each([
    path.join(appData, "Farol Next Preview"),
    path.join(appData, "Farol Dev Acceptance", DEV_DATA_DIRECTORY_NAME),
    path.join(appData, DEV_DATA_DIRECTORY_NAME, "child"),
    path.join(path.dirname(appData), DEV_DATA_DIRECTORY_NAME),
  ])(
    "refuses a canonical path outside the two fixed Dev entries (%s)",
    (physical) => {
      expect(() =>
        resolvePhysicalDevDataDirectoryName(
          appData,
          () => directory,
          () => physical,
        ),
      ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
    },
  );

  it("refuses a profile replaced between directory inspection and canonicalization", () => {
    let inspections = 0;
    expect(() =>
      resolvePhysicalDevDataDirectoryName(
        appData,
        () => (++inspections > 2 ? { ...directory, inode: "202" } : directory),
        (selected) => selected,
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
  });

  it("retains an unreadable canonical path as a refusal", () => {
    expect(() =>
      resolvePhysicalDevDataDirectoryName(
        appData,
        () => directory,
        () => {
          throw Object.assign(new Error("synthetic denied metadata"), {
            code: "EPERM",
          });
        },
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNREADABLE");
  });

  it("keeps distinct and unsafe profiles refused before canonicalization", () => {
    const canonicalize = () => {
      throw new Error("MUST_NOT_CANONICALIZE_UNSAFE_PROFILE");
    };
    expect(() =>
      resolvePhysicalDevDataDirectoryName(
        appData,
        (candidate) =>
          candidate.endsWith("Farol DEV")
            ? directory
            : { ...directory, inode: "202" },
        canonicalize,
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_AMBIGUOUS");
    expect(() =>
      resolvePhysicalDevDataDirectoryName(
        appData,
        () => ({ ...directory, symbolicLink: true }),
        canonicalize,
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
  });
});

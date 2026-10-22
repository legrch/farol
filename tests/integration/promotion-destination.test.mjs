import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPromotionDestination,
  assertSharedApplicationsParent,
  preparePromotionParent,
  trustedOwnerHome,
} from "../../tooling/promotion-destination.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Farol promotion destination", () => {
  it("ignores an ordinary Legacy directory supplied as HOME", async () => {
    const container = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-owner-home-"),
    );
    roots.push(container);
    const accountHome = path.join(container, "owner-home");
    const legacyHome = path.join(accountHome, ".farol");
    await fs.mkdir(accountHome, { mode: 0o700 });
    await fs.mkdir(legacyHome, { mode: 0o700 });
    const originalHome = process.env.HOME;
    process.env.HOME = legacyHome;
    try {
      const effectiveUid = process.geteuid?.() ?? 501;
      const trusted = trustedOwnerHome(
        { homedir: accountHome, uid: effectiveUid },
        effectiveUid,
      );
      expect(trusted).toBe(accountHome);
      expect(() =>
        assertPromotionDestination({
          home: trusted,
          source: "/checkout/_output/package/Farol.app",
          destination: path.join(legacyHome, "Applications/Farol.app"),
        }),
      ).toThrow("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("defaults first installation to the shared canonical slot", () => {
    expect(
      assertPromotionDestination({
        home: "/Users/owner",
        source: "/candidate/Farol.app",
      }),
    ).toEqual({
      destination: "/Applications/Farol.app",
      parent: "/Applications",
      receipt: "/Applications/Farol.app.receipt.json",
    });
  });

  it.each([
    [0, 80, 0o775, true],
    [0, 0, 0o755, true],
    [501, 80, 0o775, false],
    [0, 80, 0o777, false],
    [0, 20, 0o775, false],
  ])(
    "shared parent owner=%s group=%s mode=%s admitted=%s (pure metadata)",
    (uid, gid, mode, admitted) => {
      const info = {
        uid,
        gid,
        mode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
      if (admitted)
        expect(() =>
          assertSharedApplicationsParent(info, "/Applications"),
        ).not.toThrow();
      else
        expect(() =>
          assertSharedApplicationsParent(info, "/Applications"),
        ).toThrow("PROMOTION_PARENT_TYPE_INVALID");
      expect(() =>
        assertSharedApplicationsParent(info, "/displaced/Applications"),
      ).toThrow();
      expect(() =>
        assertSharedApplicationsParent(
          { ...info, isSymbolicLink: () => true },
          "/Applications",
        ),
      ).toThrow();
    },
  );

  it("admits the legacy fixed app directly below the owner's Applications", () => {
    const home = "/Users/owner";
    const source = "/checkout/_output/package/Farol.app";
    expect(
      assertPromotionDestination({
        home,
        source,
        destination: "/Users/owner/Applications/Farol.app",
      }),
    ).toEqual({
      destination: "/Users/owner/Applications/Farol.app",
      parent: "/Users/owner/Applications",
      receipt: "/Users/owner/Applications/Farol.app.receipt.json",
    });
  });

  it.each([
    "/Users/owner/.farol/Farol.app",
    "/Users/owner/Applications/Legacy.app/Contents/Farol.app",
    "/Users/owner/Applications/nested/Farol.app",
    "/tmp/Farol.app",
    "/Applications/../Applications/Farol.app",
    "/Applications/Farol.app/",
    "Applications/Farol.app",
  ])(
    "rejects a destination outside the direct Next-only slot: %s",
    (destination) => {
      expect(() =>
        assertPromotionDestination({
          home: "/Users/owner",
          source: "/checkout/_output/package/Farol.app",
          destination,
        }),
      ).toThrow("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
    },
  );

  it("rejects a symlinked Applications parent before copying", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-promotion-home-"),
    );
    roots.push(home);
    const legacy = path.join(home, ".farol");
    await fs.mkdir(legacy);
    await fs.symlink(legacy, path.join(home, "Applications"));
    await expect(
      preparePromotionParent(home, path.join(home, "Applications")),
    ).rejects.toThrow("PROMOTION_PARENT_TYPE_INVALID");
  });

  it("rejects a symlinked home before creating Applications", async () => {
    const container = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-promotion-container-"),
    );
    roots.push(container);
    const actualHome = path.join(container, "actual-home");
    const linkedHome = path.join(container, "linked-home");
    await fs.mkdir(actualHome, { mode: 0o700 });
    await fs.symlink(actualHome, linkedHome);
    await expect(
      preparePromotionParent(linkedHome, path.join(linkedHome, "Applications")),
    ).rejects.toThrow("PROMOTION_HOME_TYPE_INVALID");
    await expect(
      fs.lstat(path.join(actualHome, "Applications")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a writable home before creating Applications", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-promotion-writable-home-"),
    );
    roots.push(home);
    await fs.chmod(home, 0o777);
    await expect(
      preparePromotionParent(home, path.join(home, "Applications")),
    ).rejects.toThrow("PROMOTION_HOME_TYPE_INVALID");
    await expect(
      fs.lstat(path.join(home, "Applications")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

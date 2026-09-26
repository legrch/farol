import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPromotionDestination,
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

describe("Farol Next promotion destination", () => {
  it("ignores an ordinary Legacy directory supplied as HOME", async () => {
    const container = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-owner-home-"),
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
          source: "/checkout/dist/package/Farol Next Preview.app",
          destination: path.join(
            legacyHome,
            "Applications/Farol Next Preview.app",
          ),
        }),
      ).toThrow("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("admits only the fixed app directly below the owner's Applications", () => {
    const home = "/Users/owner";
    const source = "/checkout/dist/package/Farol Next Preview.app";
    expect(
      assertPromotionDestination({
        home,
        source,
        destination: "/Users/owner/Applications/Farol Next Preview.app",
      }),
    ).toEqual({
      destination: "/Users/owner/Applications/Farol Next Preview.app",
      parent: "/Users/owner/Applications",
      receipt: "/Users/owner/Applications/Farol Next Preview.app.receipt.json",
    });
  });

  it.each([
    "/Users/owner/.farol/Farol Next Preview.app",
    "/Users/owner/Applications/Legacy.app/Contents/Farol Next Preview.app",
    "/Users/owner/Applications/nested/Farol Next Preview.app",
    "/tmp/Farol Next Preview.app",
  ])(
    "rejects a destination outside the direct Next-only slot: %s",
    (destination) => {
      expect(() =>
        assertPromotionDestination({
          home: "/Users/owner",
          source: "/checkout/dist/package/Farol Next Preview.app",
          destination,
        }),
      ).toThrow("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
    },
  );

  it("rejects a symlinked Applications parent before copying", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-promotion-home-"),
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
      path.join(os.tmpdir(), "farol-next-promotion-container-"),
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
      path.join(os.tmpdir(), "farol-next-promotion-writable-home-"),
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

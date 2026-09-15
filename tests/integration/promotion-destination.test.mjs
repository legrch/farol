import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPromotionDestination,
  preparePromotionParent,
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
  it("admits only the fixed app directly below the owner's Applications", () => {
    const home = "/Users/owner";
    const source = "/checkout/vnext/dist/package/Farol Next Preview.app";
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
          source: "/checkout/vnext/dist/package/Farol Next Preview.app",
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

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
});

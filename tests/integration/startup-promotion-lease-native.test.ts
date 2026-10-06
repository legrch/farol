// Real disposable macOS lease/file semantics. No app, bundle, provider or owner
// profile is exercised; packaged startup/relaunch remains a higher boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../src/apps/desktop/promotion-lease";
import { withStartupPromotionLease } from "../../src/apps/desktop/startup-promotion-lease";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function root(): Promise<string> {
  const result = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-startup-lease-"),
  );
  roots.push(result);
  return result;
}
async function expectPromotionExcluded(userData: string): Promise<void> {
  const competing = await acquirePromotionLease(
    userData,
    "updater",
    "promotion",
  );
  try {
    expect(competing).toBeNull();
  } finally {
    if (competing) await releasePromotionLease(competing);
  }
}

describe("startup and updater use the same native exclusion", () => {
  it("refuses startup while promotion owns the lease without touching the original marker", async () => {
    const userData = await root();
    const promotion = await acquirePromotionLease(
      userData,
      "updater",
      "promotion",
    );
    expect(promotion).not.toBeNull();
    const marker = path.join(userData, "farol-next-state", "running.json");
    const bytes = "original synthetic unconfirmed marker\n";
    await fs.writeFile(marker, bytes, { mode: 0o600 });
    const original = await fs.lstat(marker);
    let readinessCalls = 0;
    let publicationCalls = 0;
    try {
      await expect(
        withStartupPromotionLease(userData, "candidate", async () => {
          readinessCalls += 1;
          publicationCalls += 1;
          await fs.writeFile(marker, "replaced\n");
        }),
      ).rejects.toThrow("STARTUP_PROMOTION_BUSY");
      expect(readinessCalls).toBe(0);
      expect(publicationCalls).toBe(0);
      expect(await fs.readFile(marker, "utf8")).toBe(bytes);
      const retained = await fs.lstat(marker);
      expect([retained.dev, retained.ino]).toEqual([
        original.dev,
        original.ino,
      ]);
    } finally {
      await releasePromotionLease(promotion!);
    }
  });

  it("holds exclusion across readiness and publication, then releases before ordinary admission", async () => {
    const userData = await root();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const marker = path.join(userData, "farol-next-state", "running.json");
    const startup = withStartupPromotionLease(
      userData,
      "candidate",
      async (verify) => {
        enter();
        await readiness;
        expect(await verify()).toBe(true);
        await fs.writeFile(marker, "current synthetic runtime obligation\n", {
          mode: 0o600,
        });
        await expectPromotionExcluded(userData);
        return true;
      },
    );
    // Always settle this exact startup before disposing its roots, even if an
    // owning assertion fails. No orphan callback or lease may survive teardown.
    try {
      await Promise.race([
        entered,
        startup.then(() => {
          throw new Error("STARTUP_SECTION_NOT_ENTERED");
        }),
      ]);
      await expectPromotionExcluded(userData);
    } finally {
      ready();
      expect(await startup).toBe(true);
    }
    const admission = await acquirePromotionLease(
      userData,
      "settings",
      "admission",
    );
    expect(admission).not.toBeNull();
    try {
      expect(await fs.readFile(marker, "utf8")).toBe(
        "current synthetic runtime obligation\n",
      );
    } finally {
      await releasePromotionLease(admission!);
    }
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activationObligations } from "../../tooling/promotion-obligations.mjs";

afterEach(() => vi.restoreAllMocks());

it.each(["fifo", "symlink", "regular"])(
  "legacy %s presence blocks promotion without opening the node",
  async (kind) => {
    const old = "/fixture/preview/farol-next-state/product-settings.json";
    const open = vi.spyOn(fs, "open").mockImplementation(async (file) => {
      if (file === old) throw new Error("LEGACY_MUST_NOT_BE_OPENED");
      throw Object.assign(new Error("absent fixture state"), {
        code: "ENOENT",
      });
    });
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (file) => {
      expect(file).toBe(old);
      return {
        isFIFO: () => kind === "fifo",
        isSymbolicLink: () => kind === "symlink",
      };
    });
    const result = await activationObligations("/fixture/preview");
    expect(result.drained).toBe(false);
    expect(result.unreadable).toContain("legacy-config:CONFIG_RENAME_REQUIRED");
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(
      open.mock.calls.every(
        ([file]) => path.basename(file) !== "product-settings.json",
      ),
    ).toBe(true);
  },
);

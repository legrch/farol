import { describe, expect, it } from "vitest";
import {
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
} from "./settings.ts";

describe("settings document schemas", () => {
  it("is strict about general settings", () => {
    const general = {
      openAtLaunch: "home",
      sidebarDefault: "full",
      activityDetail: "summary",
    };
    expect(ProductGeneralSettingsSchema.safeParse(general).success).toBe(true);
    expect(
      ProductGeneralSettingsSchema.safeParse({ ...general, extra: 1 }).success,
    ).toBe(false);
  });

  it("keeps the snapshot error codes and refuses unknown ones", () => {
    for (const error of [
      "SETTINGS_CORRUPT",
      "CONFIG_RENAME_REQUIRED",
      "SETTINGS_UNSAFE",
      "SETTINGS_READ_FAILED",
    ])
      expect(
        ProductConfigurationSnapshotSchema.safeParse({ status: "error", error })
          .success,
      ).toBe(true);
    expect(
      ProductConfigurationSnapshotSchema.safeParse({
        status: "error",
        error: "OTHER",
      }).success,
    ).toBe(false);
  });
});

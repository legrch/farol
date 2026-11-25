import { describe, expect, it, vi } from "vitest";
import { cleanupAttachmentStaging } from "./staging";

describe("attachment staging startup cleanup", () => {
  it("answers ready after one successful cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    await expect(cleanupAttachmentStaging(cleanup)).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("answers not ready, once, when the cleanup rejects or throws", async () => {
    const rejected = vi.fn(async () => {
      throw new Error("ATTACHMENT_STAGING_UNSAFE");
    });
    await expect(cleanupAttachmentStaging(rejected)).resolves.toBe(false);
    expect(rejected).toHaveBeenCalledTimes(1);
    await expect(
      cleanupAttachmentStaging(() => {
        throw new Error("sync");
      }),
    ).resolves.toBe(false);
  });
});

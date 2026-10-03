import { describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// In-memory storage and bridge doubles prove ordering only. No actual Go
// publication, native persistence or owner approval is established here.
async function fixture() {
  let stored: ProductSettings | null = null;
  let sequence = 0;
  const events: string[] = [];
  const store = new ProductSettingsStore({ root: "/unused/synthetic" });
  const save = vi.spyOn(store, "save").mockImplementation(async (value) => {
    events.push("save");
    stored = structuredClone(value);
  });
  const load = vi.spyOn(store, "load").mockImplementation(async () => {
    events.push("readback");
    return structuredClone(stored);
  });
  const publish = vi.fn(async (_settings: ProductSettings) => {
    events.push("publish");
  });
  const withdraw = vi.fn(async () => {
    events.push("withdraw");
    return { publish };
  });
  const service = new ProductConfigurationService(store, {
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    homeDirectory: "/synthetic/home",
    withdrawComputerAuthority: withdraw,
  });
  await service.initialize();
  expect(service.snapshot().status).toBe("ready");
  events.length = 0;
  save.mockClear();
  load.mockClear();
  return { service, save, load, publish, withdraw, events };
}
const workspace = {
  root: "/synthetic/work",
  label: "Work",
  rootIdentity: { device: "1", inode: "2" },
};

describe("settings to Go publication ordering", () => {
  it("withdraws before save and publishes only its exact readback", async () => {
    const f = await fixture();
    const result = await f.service.addReadonlyWorkspace(workspace);
    expect(result.ok).toBe(true);
    expect(f.events).toEqual(["withdraw", "save", "readback", "publish"]);
    expect(result.snapshot.status).toBe("ready");
    if (result.snapshot.status !== "ready") throw new Error("fixture");
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(result.snapshot.settings);
  });
  it("does not publish a failed or mismatched settings readback", async () => {
    const f = await fixture();
    f.load.mockResolvedValueOnce(null);
    expect((await f.service.addReadonlyWorkspace(workspace)).ok).toBe(false);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not write when the withdrawal is unconfirmed", async () => {
    const f = await fixture();
    f.withdraw.mockRejectedValueOnce(new Error("unknown withdrawal"));
    expect((await f.service.addReadonlyWorkspace(workspace)).ok).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("reports a publication failure once without replaying save or publication", async () => {
    const f = await fixture();
    f.publish.mockRejectedValueOnce(new Error("publication unknown"));
    expect((await f.service.addReadonlyWorkspace(workspace)).ok).toBe(false);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not withdraw for a no-op Computer projection", async () => {
    const f = await fixture();
    await f.service.addReadonlyWorkspace(workspace);
    f.withdraw.mockClear();
    f.publish.mockClear();
    expect((await f.service.addReadonlyWorkspace(workspace)).ok).toBe(true);
    expect(f.withdraw).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not replace a bound Computer publication owner", async () => {
    const f = await fixture();
    expect(() =>
      f.service.attachComputerAuthority(async () => ({
        publish: async () => {},
      })),
    ).toThrow("COMPUTER_AUTHORITY_ALREADY_BOUND");
    expect((await f.service.addReadonlyWorkspace(workspace)).ok).toBe(true);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
  });
  it("does not call the bridge for invalid settings", async () => {
    const f = await fixture();
    expect(
      (await f.service.addReadonlyWorkspace({ root: "relative" })).ok,
    ).toBe(false);
    expect(f.withdraw).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});

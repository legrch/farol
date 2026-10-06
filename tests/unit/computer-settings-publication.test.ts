import { describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import {
  ProductConfigurationCommandSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";

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
  it("keeps missing file policy legacy and rejects unknown caller choices", async () => {
    const f = await fixture();
    const before = f.service.snapshot();
    if (before.status !== "ready") throw new Error("fixture");
    expect(before.settings.computer.filePolicy ?? "").toBe("");
    expect(
      ownerSettingsComputerApproval(before.settings, 0),
    ).not.toHaveProperty("filePolicy");
    expect(
      ProductSettingsSchema.safeParse({
        ...before.settings,
        computer: { ...before.settings.computer, filePolicy: "full-access" },
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.update-file-policy",
        filePolicy: "full-access",
      }).success,
    ).toBe(false);
    expect((await f.service.updateComputerFilePolicy("full-access")).ok).toBe(
      false,
    );
    expect((await f.service.updateComputerFilePolicy("")).ok).toBe(true);
    expect(f.service.snapshot()).toEqual(before);
    expect(f.events).toEqual([]);
  });
  it("publishes an explicit file-policy generation through the existing owner without clearing grants or credentials", async () => {
    const f = await fixture();
    await f.service.addReadonlyWorkspace(workspace);
    const before = f.service.snapshot();
    if (before.status !== "ready") throw new Error("fixture");
    f.events.length = 0;
    const result =
      await f.service.updateComputerFilePolicy("approved-roots-v1");
    expect(result.ok).toBe(true);
    if (result.snapshot.status !== "ready") throw new Error("fixture");
    const next = result.snapshot.settings;
    expect(f.events).toEqual(["withdraw", "save", "readback", "publish"]);
    expect(next.computer.generation).toBe(
      before.settings.computer.generation + 1,
    );
    expect(next.computer.workspaces).toEqual(
      before.settings.computer.workspaces,
    );
    expect(next.computer.commands).toBe(before.settings.computer.commands);
    expect(next.connectors.secureMcp.credential).toBe(
      before.settings.connectors.secureMcp.credential,
    );
    expect(next.connectors.secureMcp.tunnelId).toBe(
      before.settings.connectors.secureMcp.tunnelId,
    );
    expect(next.setup.computer.verified).toBeNull();
    expect(next.setup.computer.reachable).toBe("unknown");
    expect(ownerSettingsComputerApproval(next, 0).filePolicy).toBe(
      "approved-roots-v1",
    );
    f.events.length = 0;
    expect(
      (await f.service.updateComputerFilePolicy("approved-roots-v1")).ok,
    ).toBe(true);
    expect(f.events).toEqual([]);
  });
  it("does not publish or repeat a file-policy transition after failed durable readback", async () => {
    const f = await fixture();
    f.load.mockResolvedValueOnce(null);
    expect(
      (await f.service.updateComputerFilePolicy("approved-roots-v1")).ok,
    ).toBe(false);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("coalesces concurrent identical file-policy choices under the existing settings queue", async () => {
    const f = await fixture();
    const result = await Promise.all([
      f.service.updateComputerFilePolicy("approved-roots-v1"),
      f.service.updateComputerFilePolicy("approved-roots-v1"),
    ]);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupRecoverySession } from "../../apps/desktop/recovery/session";
import type { StartupRecoveryComputer } from "../../apps/desktop/recovery/core-host";
import {
  RecoveryStateSchema,
  RecoveryReadResultSchema,
} from "../../apps/desktop/renderer/recovery/contract";
import { BridgeError } from "../../apps/desktop/bridge/client";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Original configuration/authority contracts with explicit storage/child doubles.
// No filesystem, native process, Electron, provider or predecessor is exercised.
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  let settings: ProductSettings | null = null,
    sequence = 0;
  const store = new ProductSettingsStore({ root: "/synthetic/recovery" });
  vi.spyOn(store, "load").mockImplementation(async () =>
    structuredClone(settings),
  );
  vi.spyOn(store, "save").mockImplementation(async (value) => {
    settings = structuredClone(value);
  });
  const service = new ProductConfigurationService(store, {
    homeDirectory: "/synthetic/home",
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  await service.initialize();
  const added = await service.addReadonlyWorkspace({
    root: "/synthetic/work",
    label: "Work",
    rootIdentity: { device: "1", inode: "2" },
  });
  if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
  const saved = added.snapshot.settings,
    workspaceId = saved.computer.workspaces[0]!.workspaceId;
  const publication = {
    fence: "1",
    storeRevision: "1",
    settingsRevision: String(saved.revision),
    generation: String(saved.computer.generation),
    approvalDigest: "a".repeat(64),
    publishOperationId: "publish",
  };
  const root = { path: "/synthetic/work", device: "1", inode: "2" };
  const list = vi
    .fn<StartupRecoveryComputer["list"]>()
    .mockImplementation(async (_id, relativePath) => ({
      publication,
      root,
      workspaceId,
      relativePath,
      entries: ["note.md", "folder/"],
      truncated: false,
    }));
  const snapshot = vi
    .fn<StartupRecoveryComputer["snapshot"]>()
    .mockImplementation(async (_id, relativePath) => ({
      publication,
      root,
      workspaceId,
      relativePath,
      bytes: 5,
      sha256: "b".repeat(64),
    }));
  const close = vi.fn<StartupRecoveryComputer["close"]>().mockResolvedValue();
  const computer: StartupRecoveryComputer = {
    list,
    snapshot,
    close,
    search: vi.fn(async () => {
      throw Error("search is not a renderer port");
    }),
  };
  const ports = {
    load: vi.fn(async () => saved as ProductSettings | null),
    start: vi.fn(async (_settings: ProductSettings) => computer),
    assertCurrent: vi.fn(async () => undefined),
  };
  return {
    saved,
    workspaceId,
    publication,
    ports,
    list,
    snapshot,
    close,
    computer,
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("startup recovery UI resource lifetime", () => {
  it("publishes only the saved-folder projection and strips authority from read results", async () => {
    const f = await fixture(),
      session = createStartupRecoverySession(f.ports);
    const state = RecoveryStateSchema.parse(await session.state());
    expect(state).toEqual({
      status: "ready",
      revision: f.saved.revision,
      folders: [
        { workspaceId: f.workspaceId, root: "/synthetic/work", label: "Work" },
      ],
      computer: "available",
    });
    expect(f.ports.load).toHaveBeenCalledTimes(1);
    expect(f.ports.start).toHaveBeenCalledExactlyOnceWith(f.saved);
    const result = RecoveryReadResultSchema.parse(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    );
    expect(result).toEqual({
      status: "ok",
      data: {
        kind: "list",
        relativePath: ".",
        entries: ["note.md", "folder/"],
        truncated: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("approvalDigest");
    expect(
      await session.read({
        kind: "metadata",
        workspaceId: f.workspaceId,
        relativePath: "note.md",
      }),
    ).toEqual({
      status: "ok",
      data: {
        kind: "metadata",
        relativePath: "note.md",
        bytes: 5,
        sha256: "b".repeat(64),
      },
    });
    await session.close();
    await session.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await session.state()).toEqual({ status: "closing" });
    expect(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    ).toEqual({ status: "unavailable" });
  });
  it.each(["missing", "corrupt"])(
    "keeps %s Settings unavailable without a backend or defaults",
    async (failure) => {
      const f = await fixture();
      if (failure === "missing") f.ports.load.mockResolvedValueOnce(null);
      else
        f.ports.load.mockRejectedValueOnce(Error("synthetic corrupt settings"));
      const session = createStartupRecoverySession(f.ports);
      expect(await session.state()).toEqual({ status: "settings_unavailable" });
      await session.close();
      expect(f.ports.load).toHaveBeenCalledTimes(1);
      expect(f.ports.start).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
    },
  );
  it.each(["refused", "unavailable"] as const)(
    "retains saved Settings when the selected owner is %s",
    async (state) => {
      const f = await fixture();
      f.ports.start.mockRejectedValueOnce(
        new BridgeError(state, "selected_owner_unavailable"),
      );
      const session = createStartupRecoverySession(f.ports);
      expect(await session.state()).toMatchObject({
        status: "ready",
        computer: "unavailable",
        folders: [{ label: "Work" }],
      });
      await session.close();
      expect(f.ports.start).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves unknown startup cleanup on Quit without replacement", async () => {
    const f = await fixture(),
      unknown = new BridgeError("unknown", "original_cleanup_unknown");
    f.ports.start.mockRejectedValueOnce(unknown);
    const session = createStartupRecoverySession(f.ports);
    expect(await session.state()).toMatchObject({
      status: "ready",
      computer: "unavailable",
    });
    await expect(session.close()).rejects.toBe(unknown);
    await expect(session.close()).rejects.toBe(unknown);
    expect(f.ports.start).toHaveBeenCalledTimes(1);
  });
  it.each([
    { kind: "shell", workspaceId: "x", relativePath: "." },
    { kind: "list", workspaceId: "not-uuid", relativePath: "." },
    {
      kind: "list",
      workspaceId: "00000000-0000-4000-8000-000000000999",
      relativePath: ".",
    },
    { kind: "list", relativePath: ".", publication: {} },
  ])(
    "refuses malformed or unselected read request %j before querying",
    async (body) => {
      const f = await fixture(),
        session = createStartupRecoverySession(f.ports);
      await session.state();
      expect(await session.read(body)).toEqual({ status: "refused" });
      expect(f.list).not.toHaveBeenCalled();
      expect(f.snapshot).not.toHaveBeenCalled();
      await session.close();
    },
  );
  it("does not start a child if Quit crosses the existing Settings read", async () => {
    const f = await fixture(),
      pending = deferred<ProductSettings | null>();
    f.ports.load.mockReturnValueOnce(pending.promise);
    const session = createStartupRecoverySession(f.ports);
    await vi.waitFor(() => expect(f.ports.load).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve(f.saved);
    await closing;
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("retains closure until the original pending child launch returns and closes it once", async () => {
    const f = await fixture(),
      pending = deferred<StartupRecoveryComputer>();
    f.ports.start.mockReturnValueOnce(pending.promise);
    const session = createStartupRecoverySession(f.ports);
    await vi.waitFor(() => expect(f.ports.start).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
    pending.resolve(f.computer);
    await closing;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await session.state()).toEqual({ status: "closing" });
  });
  it("fences a lost read without retrying or creating another owner", async () => {
    const f = await fixture();
    f.list.mockRejectedValueOnce(
      new BridgeError("unknown", "original_read_unknown"),
    );
    const session = createStartupRecoverySession(f.ports);
    expect(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    ).toEqual({ status: "unknown" });
    expect(await session.state()).toMatchObject({ computer: "unavailable" });
    expect(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.ports.start).toHaveBeenCalledTimes(1);
    await session.close();
  });
  it("withholds a result after startup exclusion is lost", async () => {
    const f = await fixture(),
      session = createStartupRecoverySession(f.ports);
    await session.state();
    const original = f.list.getMockImplementation()!;
    f.list.mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      f.ports.assertCurrent.mockRejectedValueOnce(
        Error("synthetic lease lost"),
      );
      return value;
    });
    expect(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    ).toEqual({ status: "unknown" });
    expect(await session.state()).toMatchObject({ computer: "unavailable" });
    await session.close();
  });
  it("withholds late results and rejects overlapping queries", async () => {
    const f = await fixture(),
      pending = deferred<Awaited<ReturnType<typeof f.list>>>();
    const original = f.list.getMockImplementation()!;
    f.list.mockReturnValueOnce(pending.promise);
    const session = createStartupRecoverySession(f.ports);
    const result = session.read({
      kind: "list",
      workspaceId: f.workspaceId,
      relativePath: ".",
    });
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
    expect(
      await session.read({
        kind: "metadata",
        workspaceId: f.workspaceId,
        relativePath: "note.md",
      }),
    ).toEqual({ status: "unavailable" });
    await session.close();
    pending.resolve(await original(f.workspaceId, "."));
    expect(await result).toEqual({ status: "unavailable" });
    expect(f.snapshot).not.toHaveBeenCalled();
  });
});

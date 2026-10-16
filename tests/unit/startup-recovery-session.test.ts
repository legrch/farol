import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupRecoverySession } from "../../apps/desktop/recovery/session";
import type { StartupRecoveryCore } from "../../apps/desktop/recovery/core-host";
import {
  RecoveryStateSchema,
  RecoveryReadResultSchema,
} from "../../apps/desktop/renderer/recovery/contract";
import {
  storedSummary,
  storedPage,
  storedReply,
} from "../fixtures/recovery-archive";
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
    .fn<StartupRecoveryCore["list"]>()
    .mockImplementation(async (_id, relativePath) => ({
      publication,
      root,
      workspaceId,
      relativePath,
      entries: ["note.md", "folder/"],
      truncated: false,
    }));
  const snapshot = vi
    .fn<StartupRecoveryCore["snapshot"]>()
    .mockImplementation(async (_id, relativePath) => ({
      publication,
      root,
      workspaceId,
      relativePath,
      bytes: 5,
      sha256: "b".repeat(64),
    }));
  const close = vi.fn<StartupRecoveryCore["close"]>().mockResolvedValue();
  const archiveList = vi
    .fn<StartupRecoveryCore["archiveList"]>()
    .mockResolvedValue(storedPage());
  const archiveRead = vi
    .fn<StartupRecoveryCore["archiveRead"]>()
    .mockResolvedValue(storedReply());
  const computer: StartupRecoveryCore = {
    isAvailable: vi.fn(() => true),
    folderReadsAvailable: true,
    archiveList,
    archiveRead,
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
    assertCurrent: vi.fn<() => Promise<void>>(async () => undefined),
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
    archiveList,
    archiveRead,
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function settledState(
  session: ReturnType<typeof createStartupRecoverySession>,
) {
  return vi.waitFor(async () => {
    const state = await session.state();
    if (
      state.status === "ready" &&
      (state.computer === "starting" || state.archive === "starting")
    )
      throw Error("child still starting");
    return state;
  });
}

describe("startup recovery UI resource lifetime", () => {
  it("publishes only the saved-folder projection and strips authority from read results", async () => {
    const f = await fixture(),
      session = createStartupRecoverySession(f.ports);
    const state = RecoveryStateSchema.parse(await settledState(session));
    expect(state).toEqual({
      status: "ready",
      revision: f.saved.revision,
      folders: [
        { workspaceId: f.workspaceId, root: "/synthetic/work", label: "Work" },
      ],
      computer: "available",
      archive: "available",
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
    expect(await settledState(session)).toEqual({ status: "closing" });
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
      expect(await settledState(session)).toEqual({
        status: "settings_unavailable",
      });
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
      expect(await settledState(session)).toMatchObject({
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
    expect(await settledState(session)).toMatchObject({
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
      await settledState(session);
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
      pending = deferred<StartupRecoveryCore>();
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
    expect(await settledState(session)).toEqual({ status: "closing" });
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
    expect(await settledState(session)).toMatchObject({
      computer: "unavailable",
    });
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
    await settledState(session);
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
    expect(await settledState(session)).toMatchObject({
      computer: "unavailable",
    });
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

it("shows saved Settings while the one original child is pending", async () => {
  const f = await fixture(),
    pending = deferred<StartupRecoveryCore>();
  f.ports.start.mockReturnValueOnce(pending.promise);
  const session = createStartupRecoverySession(f.ports);
  expect(await session.state()).toMatchObject({
    status: "ready",
    computer: "starting",
    archive: "starting",
    folders: [{ label: "Work" }],
  });
  expect(f.ports.start).toHaveBeenCalledTimes(1);
  expect(await session.state()).toMatchObject({ computer: "starting" });
  pending.resolve(f.computer);
  expect(await settledState(session)).toMatchObject({
    computer: "available",
    archive: "available",
  });
  await session.close();
});
it("keeps archive reads independent of known inactive folders and never exposes authority", async () => {
  const f = await fixture();
  f.ports.start.mockResolvedValueOnce({
    ...f.computer,
    folderReadsAvailable: false,
  });
  const session = createStartupRecoverySession(f.ports);
  expect(await settledState(session)).toMatchObject({
    computer: "unavailable",
    archive: "available",
  });
  const page = await session.read({ kind: "archive-list", after: "" });
  expect(page).toEqual({
    status: "ok",
    data: { kind: "archive-list", after: "", ...storedPage() },
  });
  expect(
    await session.read({
      kind: "archive-read",
      key: storedSummary().key,
      digest: storedSummary().digest,
    }),
  ).toEqual({ status: "ok", data: { kind: "archive-read", ...storedReply() } });
  for (const key of [
    "profileId",
    "ownerId",
    "publication",
    "ackDigest",
    "historyOrigin",
  ])
    expect(JSON.stringify(page)).not.toContain('"' + key + '"');
  expect(
    await session.read({
      kind: "list",
      workspaceId: f.workspaceId,
      relativePath: ".",
    }),
  ).toEqual({ status: "unavailable" });
  expect(f.list).not.toHaveBeenCalled();
  await session.close();
});
it("admits only the next observed page and exact selected stored reply", async () => {
  const f = await fixture(),
    rows = Array.from({ length: 32 }, (_, i) => storedSummary(i + 1));
  f.archiveList
    .mockResolvedValueOnce(storedPage(rows, rows[31]!.key))
    .mockResolvedValueOnce(storedPage([storedSummary(33)]));
  const session = createStartupRecoverySession(f.ports);
  const read = {
    kind: "archive-read",
    key: storedSummary().key,
    digest: storedSummary().digest,
  };
  expect(await session.read(read)).toEqual({ status: "refused" });
  expect(f.archiveRead).not.toHaveBeenCalled();
  expect(
    await session.read({ kind: "archive-list", after: "" }),
  ).toHaveProperty("status", "ok");
  expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
    status: "refused",
  });
  expect(await session.read({ ...read, digest: "b".repeat(64) })).toEqual({
    status: "refused",
  });
  expect(
    await session.read({ kind: "archive-list", after: rows[31]!.key }),
  ).toHaveProperty("status", "ok");
  expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
    status: "refused",
  });
  expect(f.archiveList).toHaveBeenCalledTimes(2);
  await session.close();
});
it.each(["unknown", "unavailable"] as const)(
  "pauses only the archive after its original %s read",
  async (status) => {
    const f = await fixture();
    f.archiveList.mockRejectedValueOnce(
      new BridgeError(status, "synthetic_stored_read_lost"),
    );
    const session = createStartupRecoverySession(f.ports);
    expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
      status,
    });
    expect(await session.state()).toMatchObject({
      archive: "unavailable",
      computer: "available",
    });
    expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
      status: "unavailable",
    });
    expect(f.archiveList).toHaveBeenCalledTimes(1);
    expect(
      await session.read({
        kind: "list",
        workspaceId: f.workspaceId,
        relativePath: ".",
      }),
    ).toHaveProperty("status", "ok");
    expect(f.ports.start).toHaveBeenCalledTimes(1);
    await session.close();
  },
);
it.each(["generation", "bytes", "observation"])(
  "withholds a crossed stored %s response and preserves the old selection",
  async (crossed) => {
    const f = await fixture(),
      session = createStartupRecoverySession(f.ports);
    await session.read({ kind: "archive-list", after: "" });
    const value = { ...storedReply(), summary: { ...storedSummary() } };
    if (crossed === "generation") value.summary.backendGeneration = "crossed";
    if (crossed === "bytes") value.text += "!";
    if (crossed === "observation")
      Object.assign(value, { observation: "confirmed" });
    f.archiveRead.mockResolvedValueOnce(value);
    const request = {
      kind: "archive-read",
      key: storedSummary().key,
      digest: storedSummary().digest,
    };
    expect(await session.read(request)).toEqual({ status: "unknown" });
    expect(await session.read(request)).toEqual({ status: "unavailable" });
    expect(f.archiveRead).toHaveBeenCalledTimes(1);
    await session.close();
  },
);
it("withholds a stored read across lost exclusion and disables both read surfaces", async () => {
  const f = await fixture(),
    session = createStartupRecoverySession(f.ports);
  await session.read({ kind: "archive-list", after: "" });
  f.archiveRead.mockImplementationOnce(async () => {
    f.ports.assertCurrent.mockRejectedValueOnce(
      Error("synthetic old lease lost"),
    );
    return storedReply();
  });
  expect(
    await session.read({
      kind: "archive-read",
      key: storedSummary().key,
      digest: storedSummary().digest,
    }),
  ).toEqual({ status: "unknown" });
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  await session.close();
});
it("withholds a stored reply after Quit clears its selection and rejects overlapping folder reads", async () => {
  const f = await fixture(),
    pending = deferred<Awaited<ReturnType<typeof f.archiveRead>>>();
  const session = createStartupRecoverySession(f.ports);
  await session.read({ kind: "archive-list", after: "" });
  f.archiveRead.mockReturnValueOnce(pending.promise);
  const reading = session.read({
    kind: "archive-read",
    key: storedSummary().key,
    digest: storedSummary().digest,
  });
  await vi.waitFor(() => expect(f.archiveRead).toHaveBeenCalledTimes(1));
  expect(
    await session.read({
      kind: "list",
      workspaceId: f.workspaceId,
      relativePath: ".",
    }),
  ).toEqual({ status: "unavailable" });
  await session.close();
  pending.resolve(storedReply());
  expect(await reading).toEqual({ status: "unavailable" });
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.list).not.toHaveBeenCalled();
});

it("does not reactivate a pending exclusion check after another observer lost that lease", async () => {
  const f = await fixture(),
    session = createStartupRecoverySession(f.ports);
  await session.read({ kind: "archive-list", after: "" });
  const postCheck = deferred<void>();
  f.archiveRead.mockImplementationOnce(async () => {
    f.ports.assertCurrent.mockReturnValueOnce(postCheck.promise);
    return storedReply();
  });
  const reading = session.read({
    kind: "archive-read",
    key: storedSummary().key,
    digest: storedSummary().digest,
  });
  await vi.waitFor(() => expect(f.archiveRead).toHaveBeenCalledTimes(1));
  f.ports.assertCurrent.mockRejectedValueOnce(
    Error("another observer lost original lease"),
  );
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  postCheck.resolve();
  expect(await reading).toEqual({ status: "unknown" });
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  await session.close();
});

it("withdraws both live read surfaces after original pipe loss while keeping saved Settings", async () => {
  const f = await fixture(),
    session = createStartupRecoverySession(f.ports);
  expect(await settledState(session)).toMatchObject({
    computer: "available",
    archive: "available",
  });
  vi.mocked(f.computer.isAvailable).mockReturnValueOnce(false);
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
    revision: f.saved.revision,
    folders: [{ label: "Work" }],
  });
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
    status: "unavailable",
  });
  expect(
    await session.read({
      kind: "list",
      workspaceId: f.workspaceId,
      relativePath: ".",
    }),
  ).toEqual({ status: "unavailable" });
  expect(f.list).not.toHaveBeenCalled();
  expect(f.archiveList).not.toHaveBeenCalled();
  expect(f.ports.start).toHaveBeenCalledTimes(1);
  await session.close();
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("withholds another read after common pipe failure rather than treating it as independent storage loss", async () => {
  const f = await fixture(),
    session = createStartupRecoverySession(f.ports);
  f.archiveList.mockImplementationOnce(async () => {
    vi.mocked(f.computer.isAvailable).mockReturnValue(false);
    throw new BridgeError("unknown", "transport_ended");
  });
  expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
    status: "unknown",
  });
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  expect(await session.read({ kind: "archive-list", after: "" })).toEqual({
    status: "unavailable",
  });
  expect(f.archiveList).toHaveBeenCalledTimes(1);
  await session.close();
});

it("withholds a stored query return after a state observer withdraws the original pipe", async () => {
  const f = await fixture(),
    pending = deferred<Awaited<ReturnType<typeof f.archiveList>>>();
  f.archiveList.mockReturnValueOnce(pending.promise);
  const session = createStartupRecoverySession(f.ports);
  const reading = session.read({ kind: "archive-list", after: "" });
  await vi.waitFor(() => expect(f.archiveList).toHaveBeenCalledTimes(1));
  vi.mocked(f.computer.isAvailable).mockReturnValueOnce(false);
  expect(await session.state()).toMatchObject({
    computer: "unavailable",
    archive: "unavailable",
  });
  pending.resolve(storedPage());
  expect(await reading).toEqual({ status: "unavailable" });
  expect(f.archiveRead).not.toHaveBeenCalled();
  await session.close();
  expect(f.close).toHaveBeenCalledTimes(1);
});

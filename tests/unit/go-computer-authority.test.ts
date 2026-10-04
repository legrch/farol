import { describe, expect, it, vi } from "vitest";
import { GoComputerAuthority } from "../../apps/desktop/go-computer-authority";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import type { Client } from "../../apps/desktop/bridge/client";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

// Deterministic host/transport conformance only; the separate Go native CLI test
// proves real stores and admission. This fixture owns no native/backend process.
async function fixture(fault?: (method: string, result: Outcome) => Outcome) {
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      const input = body as Record<string, Json>;
      let data: Json;
      if (method === "computer.authority.deactivate")
        data = { fence: "1", storeRevision: "0" };
      else if (method === "computer.authority.publish")
        data = {
          fence: input.fence!,
          storeRevision: "1",
          settingsRevision: input.settingsRevision!,
          generation: String(
            (input.approval as Record<string, Json>).generation,
          ),
          approvalDigest: "a".repeat(64),
          publishOperationId: options.operationId!,
        };
      else if (method === "computer.settings.list")
        data = {
          publication: input.publication!,
          workspaceId: input.workspaceId!,
          relativePath: input.relativePath!,
          root: { path: "/synthetic/work", device: "1", inode: "2" },
          entries: ["note.md", "folder/"],
          truncated: false,
        };
      else
        data = {
          ownerId: "owner-desktop",
          sessionId: input.sessionId!,
          taskId: input.taskId!,
          taskEpoch: "1",
          participantId: "minted-by-go",
          turnId: input.turnId!,
          generation: "1",
          admissionOperationId: options.operationId!,
          storeRevision: "2",
        };
      const result: Outcome = {
        status: "ok",
        requestId: options.id!,
        ...(options.operationId === undefined
          ? {}
          : { operationId: options.operationId }),
        context,
        data,
      };
      return fault ? fault(method, result) : result;
    },
  );
  const bridge = new GoComputerAuthority(
    { request },
    context,
    () => 1791040000000,
  );
  const store = new ProductSettingsStore({ root: "/unused/synthetic" });
  let stored: ProductSettings | null = null;
  let sequence = 0;
  vi.spyOn(store, "save").mockImplementation(async (value) => {
    stored = structuredClone(value);
  });
  vi.spyOn(store, "load").mockImplementation(async () =>
    structuredClone(stored),
  );
  const service = new ProductConfigurationService(store, {
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    homeDirectory: "/synthetic/home",
    withdrawComputerAuthority: () => bridge.withdraw(),
  });
  await service.initialize();
  const add = () =>
    service.addReadonlyWorkspace({
      root: "/synthetic/work",
      label: "Work",
      rootIdentity: { device: "1", inode: "2" },
    });
  return { bridge, service, request, add };
}
const intent = {
  sessionId: "session",
  taskId: "task",
  turnId: "turn",
  workspaceIds: ["work"],
};

describe("Go Computer host authority mapping", () => {
  it("lists for Settings under the exact publication without creating a Chat owner", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const listed = await f.bridge.listSettings(
      generation,
      workspaces[0]!.workspaceId,
      ".",
    );
    expect(listed.entries).toEqual(["note.md", "folder/"]);
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.list",
    ]);
    expect(f.request.mock.calls[2]![2]?.operationId).toBeUndefined();
    await expect(
      f.bridge.listSettings(generation + 1, workspaces[0]!.workspaceId, "."),
    ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
    expect(f.request).toHaveBeenCalledTimes(3);
    // Actual Chat admission consumes only its own admission receipt. A later
    // owner list neither fabricates nor renews that Chat membership.
    await f.bridge.admitRead(intent);
    await f.bridge.listSettings(generation, workspaces[0]!.workspaceId, ".");
    expect(
      f.request.mock.calls.filter((call) => call[0] === "chat.turn"),
    ).toHaveLength(1);
  });

  it.each(["publication", "workspace", "backend", "operation", "shape"])(
    "fences a crossed Settings %s result without another physical request",
    async (fault) => {
      const f = await fixture((method, result) => {
        if (method !== "computer.settings.list") return result;
        const data = result.data as Record<string, Json>;
        if (fault === "backend")
          return {
            ...result,
            context: { ...result.context, backendGeneration: "other" },
          };
        if (fault === "operation")
          return { ...result, operationId: "unexpected" };
        if (fault === "shape")
          return { ...result, data: { ...data, entries: [42] } };
        return {
          ...result,
          data: {
            ...data,
            ...(fault === "workspace"
              ? { workspaceId: "other" }
              : {
                  publication: {
                    ...(data.publication as Record<string, Json>),
                    settingsRevision: "999",
                  },
                }),
          },
        };
      });
      const added = await f.add();
      if (!added.ok || added.snapshot.status !== "ready")
        throw Error("fixture");
      const { generation, workspaces } = added.snapshot.settings.computer;
      await expect(
        f.bridge.listSettings(generation, workspaces[0]!.workspaceId, "."),
      ).rejects.toMatchObject({ state: "unknown" });
      await expect(
        f.bridge.listSettings(generation, workspaces[0]!.workspaceId, "."),
      ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );

  it("discards a completed listing if host withdrawal crossed its response", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const implementation = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, body, options) => {
      const result = await implementation(method, body, options);
      if (method === "computer.settings.list") await f.bridge.withdraw();
      return result;
    });
    await expect(
      f.bridge.listSettings(generation, workspaces[0]!.workspaceId, "."),
    ).rejects.toMatchObject({ code: "settings_workspace_withdrawn" });
    expect(
      f.request.mock.calls.filter(
        (call) => call[0] === "computer.settings.list",
      ),
    ).toHaveLength(1);
  });

  it("binds an old folder before inspection without inventing successful verification", async () => {
    const f = await fixture();
    const added = await f.service.addReadonlyWorkspace({
      root: "/synthetic/legacy",
      label: "Legacy",
    });
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const before = added.snapshot.settings;
    const workspace = before.computer.workspaces[0]!;
    f.request.mockClear();
    const bound = await f.service.bindWorkspaceRootIdentity(
      workspace.workspaceId,
      before.revision,
      workspace.root,
      { device: "3", inode: "4" },
    );
    if (!bound.ok || bound.snapshot.status !== "ready")
      throw Error("binding refused");
    expect(bound.snapshot.settings.computer.workspaces[0]).toMatchObject({
      rootIdentity: { device: "3", inode: "4" },
      accessCheck: null,
    });
    expect(bound.snapshot.settings.setup.computer.verified).toBeNull();
    expect(bound.snapshot.settings.computer.generation).toBe(
      before.computer.generation + 1,
    );
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
    ]);
    f.request.mockClear();
    await expect(
      f.service.bindWorkspaceRootIdentity(
        workspace.workspaceId,
        bound.snapshot.settings.revision,
        workspace.root,
        { device: "3", inode: "5" },
      ),
    ).resolves.toMatchObject({ ok: false, error: "WORKSPACE_ROOT_CHANGED" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("refuses binding and verification evidence from a stale configuration", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const settings = added.snapshot.settings;
    const workspace = settings.computer.workspaces[0]!;
    f.request.mockClear();
    await expect(
      f.service.bindWorkspaceRootIdentity(
        workspace.workspaceId,
        settings.revision - 1,
        workspace.root,
        { device: "1", inode: "2" },
      ),
    ).resolves.toMatchObject({ ok: false, error: "WORKSPACE_ROOT_CHANGED" });
    await expect(
      f.service.recordComputerVerification(
        workspace.workspaceId,
        {
          profile: "computer.local.read/1",
          runtimeGeneration: "runtime-1",
          buildId: "c".repeat(64),
          protocol: "readonly-workspace/1",
        },
        {
          rootIdentity: workspace.rootIdentity!,
          expectedGeneration: settings.computer.generation + 1,
          expectedRoot: workspace.root,
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "WORKSPACE_ROOT_CHANGED" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps fresh settings inactive without publishing an empty grant, then accepts setup", async () => {
    const f = await fixture();
    const publication = await f.bridge.withdraw();
    const snapshot = f.service.snapshot();
    if (snapshot.status !== "ready") throw new Error("fixture");
    await publication.publish(snapshot.settings);
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
    ]);
    expect((await f.add()).ok).toBe(true);
    expect((await f.bridge.admitRead(intent)).participantId).toBe(
      "minted-by-go",
    );
  });

  it("withdraws the last workspace without retaining the previous admission receipt", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready")
      throw new Error("fixture");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]!.workspaceId;
    f.request.mockClear();
    expect((await f.service.removeWorkspace(workspaceId)).ok).toBe(true);
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
    ]);
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
  });

  it("maps real settings commit to known publication then the actual admission response", async () => {
    const f = await fixture();
    expect((await f.add()).ok).toBe(true);
    const admitted = await f.bridge.admitRead(intent);
    expect(admitted.participantId).toBe("minted-by-go");
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "chat.turn",
    ]);
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it("requires a known publication before admission", async () => {
    const f = await fixture();
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retains unknown publication without replay or a new withdrawal", async () => {
    const f = await fixture((method, result) => {
      if (method === "computer.authority.publish")
        throw new Error("lost acknowledgement");
      return result;
    });
    expect((await f.add()).ok).toBe(false);
    await expect(f.bridge.withdraw()).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("refuses crossed backend identity before settings publication", async () => {
    const f = await fixture((_method, result) => ({
      ...result,
      context: { ...result.context, backendGeneration: "other" },
    }));
    expect((await f.add()).ok).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("refuses a crossed publication receipt without admitting", async () => {
    const f = await fixture((method, result) =>
      method === "computer.authority.publish"
        ? {
            ...result,
            data: {
              ...(result.data as Record<string, Json>),
              publishOperationId: "different",
            },
          }
        : result,
    );
    expect((await f.add()).ok).toBe(false);
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    "consumes each publication closure once with workspace configured=%s",
    async (configured) => {
      const f = await fixture();
      if (configured) expect((await f.add()).ok).toBe(true);
      f.request.mockClear();
      const publication = await f.bridge.withdraw();
      const snapshot = f.service.snapshot();
      if (snapshot.status !== "ready") throw new Error("fixture");
      await publication.publish(snapshot.settings);
      await expect(
        publication.publish(snapshot.settings),
      ).rejects.toMatchObject({
        code: "computer_publication_consumed",
      });
      expect(f.request).toHaveBeenCalledTimes(configured ? 2 : 1);
    },
  );
});

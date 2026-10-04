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
        operationId: options.operationId!,
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

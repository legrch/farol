import { describe, expect, it, vi } from "vitest";
import { taskSettingsFacts } from "../../apps/desktop/bridge/task-current-settings.ts";
import { GoComputerAuthority } from "../../apps/desktop/go-computer-authority";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import { taskPolicy } from "../fixtures/task-policy";
import { fixtureTaskSettingsCompare } from "../fixtures/task-settings-projection.ts";
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
      else if (method === "computer.settings.snapshot")
        data = {
          publication: input.publication!,
          workspaceId: input.workspaceId!,
          relativePath: input.relativePath!,
          root: { path: "/synthetic/work", device: "1", inode: "2" },
          bytes: 7,
          sha256: "b".repeat(64),
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
      else if (method === "computer.settings.search")
        data = {
          publication: input.publication!,
          workspaceId: input.workspaceId!,
          relativePath: input.relativePath!,
          pattern: input.pattern!,
          root: { path: "/synthetic/work", device: "1", inode: "2" },
          matches: [
            { path: "note.md", line: "1", text: "match", truncated: false },
          ],
          resultLimited: false,
          scanLimited: false,
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
    taskSettingsCompare: fixtureTaskSettingsCompare,
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

function selectedTaskSettings(original: ProductSettings): ProductSettings {
  const settings = structuredClone(original);
  const now = 1791040000000;
  const workspace = settings.computer.workspaces[0]!;
  workspace.gitHistoryApproved = true;
  workspace.gitMetadata = {
    gitDirectory: "/synthetic/project/.git/worktrees/work",
    commonDirectory: "/synthetic/project/.git",
  };
  settings.tasks = taskPolicy();
  const verifiedAt = new Date(now - 60_000).toISOString();
  const localVerification = {
    executableSha256: "a".repeat(64),
    schemaSha256: "b".repeat(64),
    buildId: "c".repeat(64),
    verifiedAt,
  };
  const host = {
    executablePath: "/synthetic/codex",
    executableSha256: "a".repeat(64),
    baseSchemaSha256: "b".repeat(64),
  };
  settings.nativeHosts.codex = {
    executablePath: host.executablePath,
    executableSha256: host.executableSha256,
    version: "1.0.0",
    protocol: "codex-app-server/v2",
    schemaSha256: host.baseSchemaSha256,
    verifiedAt,
    localVerification,
    liveVerification: null,
    agentVerification: null,
    taskSource: {
      hostGeneration: settings.nativeHosts.generation,
      localVerification,
      evidence: {
        handoff: {
          ...host,
          status: "supported",
          contract: {
            version: "1.0.0",
            protocol: "codex-app-server/v2",
            schemaSha256: "d".repeat(64),
            projectBoundCreateStatus: true,
          },
        },
        followup: {
          ...host,
          status: "unavailable",
          code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
        },
      },
    },
  };
  settings.nativeHosts.taskRoute = {
    transport: "codex-shared-proxy/v1",
    harness: "codex",
    socketPath: "/synthetic/proxy.sock",
    expectedCodexHome: "/synthetic/home/.codex",
    workspaceId: workspace.workspaceId,
    projectId: "00000000-0000-4000-8000-000000000c01",
    observeThreadId: "00000000-0000-4000-8000-000000000c02",
    observeTurnId: "turn-exact_1",
    projectRoot: "/synthetic/project",
    projectIdentity: { device: "1", inode: "3" },
    gitCommonDirectory: workspace.gitMetadata.commonDirectory,
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    computerGeneration: settings.computer.generation,
    hostGeneration: settings.nativeHosts.generation,
    approvedAt: verifiedAt,
    expiresAt: now + 60_000,
  };
  settings.setup.computer.reachable = "reachable";
  settings.setup.computer.outcomeUnknown = false;
  settings.setup.computer.verified = {
    profile: "fixture",
    workspaceId: workspace.workspaceId,
    configRevision: settings.computer.generation,
    runtimeGeneration: "fixture",
    buildId: "e".repeat(64),
    protocol: "fixture",
    verifiedAt,
  };
  return ProductSettingsSchema.parse(settings);
}

describe("raw Task facts in the original Computer publication", () => {
  it("transports raw saved facts to Go without a Task or provider read", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const settings = selectedTaskSettings(added.snapshot.settings);
    f.request.mockClear();
    const original = await f.bridge.withdraw();
    await original.publish(settings);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
    ]);
    const body = f.request.mock.calls[1]![1];
    expect(body).not.toHaveProperty("taskCodex");
    expect(body).not.toHaveProperty("taskCodexRead");
    expect(body).toMatchObject({
      taskCurrentSettings: {
        snapshot: JSON.stringify(taskSettingsFacts(settings)),
        nowMillis: "1791040000000",
      },
    });
  });

  it.each(["thread-only", "unknown", "stale-generation"])(
    "transports %s evidence for Go to decide without a local positive selection",
    async (loss) => {
      const f = await fixture();
      const added = await f.add();
      if (!added.ok || added.snapshot.status !== "ready")
        throw Error("fixture");
      const settings = selectedTaskSettings(added.snapshot.settings);
      if (loss === "thread-only")
        delete settings.nativeHosts.taskRoute!.observeTurnId;
      if (loss === "unknown") settings.setup.computer.outcomeUnknown = true;
      if (loss === "stale-generation")
        settings.nativeHosts.taskRoute!.hostGeneration += 1;
      f.request.mockClear();
      const original = await f.bridge.withdraw();
      await original.publish(settings);
      const body = f.request.mock.calls[1]![1];
      expect(body).not.toHaveProperty("taskCodexRead");
      expect(body).not.toHaveProperty("taskCodex");
      expect(body).toMatchObject({
        taskCurrentSettings: {
          snapshot: JSON.stringify(taskSettingsFacts(settings)),
          nowMillis: "1791040000000",
        },
      });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "computer.authority.deactivate",
        "computer.authority.publish",
      ]);
    },
  );

  it("retains a lost exact publication response without another dispatch or withdrawal", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const settings = selectedTaskSettings(added.snapshot.settings);
    f.request.mockClear();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[0] === "computer.authority.publish")
        throw Error("lost original response");
      return request(...args);
    });
    const original = await f.bridge.withdraw();
    await expect(original.publish(settings)).rejects.toThrow(
      "lost original response",
    );
    await expect(original.publish(settings)).rejects.toMatchObject({
      code: "computer_publication_consumed",
    });
    await expect(f.bridge.withdraw()).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
    ]);
    expect(f.request.mock.calls[1]![1]).toMatchObject({
      taskCurrentSettings: {
        snapshot: JSON.stringify(taskSettingsFacts(settings)),
      },
    });
  });

  it("captures source facts before the original publication can reenter settings", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const settings = selectedTaskSettings(added.snapshot.settings);
    const captured = JSON.stringify(taskSettingsFacts(settings));
    f.request.mockClear();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[0] === "computer.authority.publish") {
        settings.revision += 1;
        settings.nativeHosts.taskRoute!.observeTurnId = "successor-turn";
        settings.nativeHosts.codex!.executableSha256 = "f".repeat(64);
      }
      return request(...args);
    });
    const publication = await f.bridge.withdraw();
    await publication.publish(settings);
    expect(JSON.stringify(taskSettingsFacts(settings))).not.toBe(captured);
    expect(f.request.mock.calls[1]![1]).toMatchObject({
      settingsRevision: String(settings.revision - 1),
      taskCurrentSettings: { snapshot: captured },
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
    ]);
  });
});

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
    expect(f.request.mock.calls[1]![1]).toMatchObject({
      renewableOwnerConsent: true,
    });
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

  it.each([
    ["../private"],
    ["."],
    ["../"],
    ["folder/child"],
    ["folder//"],
    ["/"],
    ["back\\slash"],
    ["line\nfeed"],
    ["control\u007f"],
    ["é".repeat(128)],
    ["duplicate", "duplicate"],
    ["collision", "collision/"],
  ])(
    "rejects malformed Settings entries before evidence can be consumed: %j",
    async (...entries) => {
      const f = await fixture((method, result) =>
        method === "computer.settings.list"
          ? {
              ...result,
              data: { ...(result.data as Record<string, Json>), entries },
            }
          : result,
      );
      const added = await f.add();
      if (!added.ok || added.snapshot.status !== "ready")
        throw Error("fixture");
      const { generation, workspaces } = added.snapshot.settings.computer;
      const consumed = vi.fn();
      await expect(
        f.bridge
          .listSettings(generation, workspaces[0]!.workspaceId, ".")
          .then(consumed),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "invalid_settings_workspace_result",
      });
      expect(consumed).not.toHaveBeenCalled();
      await expect(
        f.bridge.listSettings(generation, workspaces[0]!.workspaceId, "."),
      ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );

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

  it("publishes explicit empty consent for connection without admitting file reads", async () => {
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
      "computer.authority.publish",
    ]);
    expect(f.request.mock.calls[1]![1]).toMatchObject({
      approval: {
        workspaces: [],
        capabilities: [],
        excludedPaths: [],
        commands: "none",
        network: "none",
      },
    });
    expect(
      f.bridge.settingsMutationPublication(
        snapshot.settings.computer.generation,
      ),
    ).toMatchObject({
      generation: String(snapshot.settings.computer.generation),
    });
    expect((await f.add()).ok).toBe(true);
    expect((await f.bridge.admitRead(intent)).participantId).toBe(
      "minted-by-go",
    );
  });

  it("replaces the last workspace with no-access consent and no file admission", async () => {
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
      "computer.authority.publish",
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
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
});

describe("Go owner Settings search transport", () => {
  it("uses the exact owner publication and decodes bounded matches without Chat admission", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const out = await f.bridge.searchSettings(
      generation,
      workspaces[0]!.workspaceId,
      ".",
      "match",
    );
    expect(out.matches).toEqual([
      { path: "note.md", line: "1", text: "match", truncated: false },
    ]);
    expect(Object.isFrozen(out.matches)).toBe(true);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.search",
    ]);
    expect(f.request.mock.calls[2]![1]).toMatchObject({
      workspaceId: workspaces[0]!.workspaceId,
      relativePath: ".",
      pattern: "match",
    });
    expect(f.request.mock.calls[2]![2]?.operationId).toBeUndefined();
    await expect(
      f.bridge.searchSettings(
        generation + 1,
        workspaces[0]!.workspaceId,
        ".",
        "match",
      ),
    ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it.each([
    "pattern",
    "path",
    "workspace",
    "publication",
    "backend",
    "request",
    "operation",
    "matches",
    "outside-scope",
    "line",
    "text",
    "match-extra",
    "limit",
  ])(
    "fences crossed or malformed search %s without another native request",
    async (fault) => {
      const f = await fixture((method, out) => {
        if (method !== "computer.settings.search") return out;
        const data = out.data as Record<string, Json>;
        if (fault === "backend")
          return {
            ...out,
            context: { ...out.context, backendGeneration: "other" },
          };
        if (fault === "request") return { ...out, requestId: "other" };
        if (fault === "operation") return { ...out, operationId: "unexpected" };
        const match = {
          path: "note.md",
          line: "1",
          text: "match",
          truncated: false,
        };
        const change =
          fault === "pattern"
            ? { pattern: "other" }
            : fault === "path"
              ? { relativePath: "other" }
              : fault === "workspace"
                ? { workspaceId: "other" }
                : fault === "publication"
                  ? {
                      publication: {
                        ...(data.publication as Record<string, Json>),
                        fence: "999",
                      },
                    }
                  : fault === "matches"
                    ? { matches: {} }
                    : fault === "outside-scope"
                      ? { matches: [{ ...match, path: "../private" }] }
                      : fault === "line"
                        ? { matches: [{ ...match, line: "9007199254740992" }] }
                        : fault === "text"
                          ? { matches: [{ ...match, text: "x".repeat(501) }] }
                          : fault === "match-extra"
                            ? { matches: [{ ...match, extra: true }] }
                            : {
                                matches: Array.from(
                                  { length: 101 },
                                  () => match,
                                ),
                              };
        return { ...out, data: { ...data, ...change } as Json };
      });
      const added = await f.add();
      if (!added.ok || added.snapshot.status !== "ready")
        throw Error("fixture");
      const { generation, workspaces } = added.snapshot.settings.computer;
      await expect(
        f.bridge.searchSettings(
          generation,
          workspaces[0]!.workspaceId,
          ".",
          "match",
        ),
      ).rejects.toMatchObject({ state: "unknown" });
      await expect(
        f.bridge.searchSettings(
          generation,
          workspaces[0]!.workspaceId,
          ".",
          "match",
        ),
      ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );

  it("discards search output when withdrawal crosses the reply", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, body, options) => {
      const out = await original(method, body, options);
      if (method === "computer.settings.search") await f.bridge.withdraw();
      return out;
    });
    await expect(
      f.bridge.searchSettings(
        generation,
        workspaces[0]!.workspaceId,
        ".",
        "match",
      ),
    ).rejects.toMatchObject({ code: "settings_workspace_withdrawn" });
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "computer.settings.search",
      ),
    ).toHaveLength(1);
  });

  it("refuses an invalid request before transport", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    await expect(
      f.bridge.searchSettings(generation, workspaces[0]!.workspaceId, ".", ""),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});

describe("Go owner Settings snapshot transport", () => {
  it("reads only full-byte metadata without Chat admission or an effect ID", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const out = await f.bridge.snapshotSettings(
      generation,
      workspaces[0]!.workspaceId,
      "note.md",
    );
    expect(out).toMatchObject({ bytes: 7, sha256: "b".repeat(64) });
    expect(out).not.toHaveProperty("text");
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.snapshot",
    ]);
    expect(f.request.mock.calls[2]![2]?.operationId).toBeUndefined();
    await expect(
      f.bridge.snapshotSettings(
        generation + 1,
        workspaces[0]!.workspaceId,
        "note.md",
      ),
    ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    "bytes",
    "sha",
    "text",
    "page",
    "path",
    "workspace",
    "publication",
    "backend",
    "request",
    "operation",
  ])(
    "fences malformed/crossed snapshot %s without another read",
    async (fault) => {
      const f = await fixture((method, out) => {
        if (method !== "computer.settings.snapshot") return out;
        const data = out.data as Record<string, Json>;
        if (fault === "backend")
          return {
            ...out,
            context: { ...out.context, backendGeneration: "other" },
          };
        if (fault === "request") return { ...out, requestId: "other" };
        if (fault === "operation") return { ...out, operationId: "unexpected" };
        return {
          ...out,
          data: {
            ...data,
            ...(fault === "bytes"
              ? { bytes: 262145 }
              : fault === "sha"
                ? { sha256: "invalid" }
                : fault === "text"
                  ? { text: "must not leave Go" }
                  : fault === "page"
                    ? { page: {} }
                    : fault === "path"
                      ? { relativePath: "other" }
                      : fault === "workspace"
                        ? { workspaceId: "other" }
                        : {
                            publication: {
                              ...(data.publication as Record<string, Json>),
                              fence: "999",
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
        f.bridge.snapshotSettings(
          generation,
          workspaces[0]!.workspaceId,
          "note.md",
        ),
      ).rejects.toMatchObject({ state: "unknown" });
      await expect(
        f.bridge.snapshotSettings(
          generation,
          workspaces[0]!.workspaceId,
          "note.md",
        ),
      ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );
  it("refuses snapshot disclosure if withdrawal crosses the awaited reply", async () => {
    const f = await fixture();
    const added = await f.add();
    if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
    const { generation, workspaces } = added.snapshot.settings.computer;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, body, options) => {
      const out = await original(method, body, options);
      if (method === "computer.settings.snapshot") await f.bridge.withdraw();
      return out;
    });
    await expect(
      f.bridge.snapshotSettings(
        generation,
        workspaces[0]!.workspaceId,
        "note.md",
      ),
    ).rejects.toMatchObject({ code: "settings_workspace_withdrawn" });
    expect(
      f.request.mock.calls.filter(
        (call) => call[0] === "computer.settings.snapshot",
      ),
    ).toHaveLength(1);
  });
});

it("selects an immutable acknowledged mutation publication without transport or renewal", async () => {
  const f = await fixture();
  expect(() => f.bridge.settingsMutationPublication(1)).toThrow(
    "computer_publication_unavailable",
  );
  const added = await f.add();
  if (!added.ok || added.snapshot.status !== "ready") throw Error("fixture");
  const generation = added.snapshot.settings.computer.generation;
  const calls = f.request.mock.calls.length;
  const publication = f.bridge.settingsMutationPublication(generation);
  expect(publication.generation).toBe(String(generation));
  Object.assign(publication, { fence: "999" });
  expect(f.bridge.settingsMutationPublication(generation).fence).toBe("1");
  expect(() => f.bridge.settingsMutationPublication(generation + 1)).toThrow(
    "computer_publication_unavailable",
  );
  expect(f.request).toHaveBeenCalledTimes(calls);
  await f.bridge.withdraw();
  expect(() => f.bridge.settingsMutationPublication(generation)).toThrow(
    "computer_publication_unavailable",
  );
});

it.each(["none", "verification", "workspace"] as const)(
  "empty approval drops saved %s command policy and keeps exact publication",
  async (commands) => {
    const f = await fixture();
    const state = f.service.snapshot();
    if (state.status !== "ready") throw new Error("fixture");
    const settings = structuredClone(state.settings);
    settings.computer.commands = commands;
    const publication = await f.bridge.withdraw();
    await publication.publish(settings);
    expect(f.request.mock.calls[1]![1]).toMatchObject({
      approval: {
        generation: settings.computer.generation,
        workspaces: [],
        capabilities: [],
        excludedPaths: [],
        commands: "none",
        network: "none",
      },
    });
    expect(
      f.bridge.settingsMutationPublication(settings.computer.generation)
        .generation,
    ).toBe(String(settings.computer.generation));
    await expect(f.bridge.admitRead(intent)).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
  },
);
it("does not convert a configured unbound folder into empty connection consent", async () => {
  const f = await fixture();
  const added = await f.add();
  if (!added.ok || added.snapshot.status !== "ready")
    throw new Error("fixture");
  const settings = structuredClone(added.snapshot.settings);
  delete settings.computer.workspaces[0]!.rootIdentity;
  f.request.mockClear();
  const publication = await f.bridge.withdraw();
  await publication.publish(settings);
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    "computer.authority.deactivate",
  ]);
  expect(() =>
    f.bridge.settingsMutationPublication(settings.computer.generation),
  ).toThrow();
});
it("retains unknown empty publication without a retry or file admission", async () => {
  const f = await fixture((method, result) => {
    if (method !== "computer.authority.publish") return result;
    const { data: _data, ...envelope } = result;
    return { ...envelope, status: "unknown" };
  });
  const state = f.service.snapshot();
  if (state.status !== "ready") throw new Error("fixture");
  const publication = await f.bridge.withdraw();
  await expect(publication.publish(state.settings)).rejects.toMatchObject({
    state: "unknown",
  });
  await expect(publication.publish(state.settings)).rejects.toMatchObject({
    code: "computer_publication_consumed",
  });
  await expect(f.bridge.withdraw()).rejects.toMatchObject({
    code: "computer_publication_unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(2);
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  DesktopGoCore,
  startDesktopGoCore,
  type DesktopCoreSelection,
} from "../../apps/desktop/go-core-host.ts";
import {
  AttestedCore,
  type CoreArtifactDeclaration,
} from "../../apps/desktop/bridge/attested-core.ts";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire.ts";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Source-only composition tests: artifact bytes, provisioning, launch and RPC
// are explicit doubles. Authority/Computer adapters and artifact parsing are real.
// No native executable, profile, Electron main, provider or model is exercised.
const ports = vi.hoisted(() => ({
  declaration: "",
  open: vi.fn(() => 41),
  close: vi.fn(),
  provision: vi.fn(),
  qualify: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("Real child creation is forbidden in this fixture");
  }),
  legacyRead: vi.fn(() => {
    throw new Error("TypeScript fallback is forbidden for a selected Go host");
  }),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      openSync: ports.open,
      closeSync: ports.close,
      fstatSync: () => ({
        isFile: () => true,
        nlink: 1n,
        size: BigInt(Buffer.byteLength(ports.declaration)),
        mtimeNs: 1n,
        ctimeNs: 1n,
      }),
      readSync: (_fd: number, buffer: Buffer) =>
        buffer.write(ports.declaration, "utf8"),
    },
  };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: ports.spawn,
}));
vi.mock("../../apps/desktop/bridge/profile-storage.ts", () => ({
  openNativeProfileStorage: ports.provision,
}));
vi.mock("../../apps/desktop/bridge/profile.ts", () => ({
  qualifyProfileLaunch: ports.qualify,
}));
vi.mock(
  "../../src/modules/computer/infra/native/native-readonly-workspace",
  () => ({
    NativeReadonlyWorkspace: class {
      execute = ports.legacyRead;
    },
  }),
);

const context = { profileId: "host-profile", backendGeneration: "backend-one" };
const artifact: CoreArtifactDeclaration = {
  schema: "farol-core-artifact/1",
  build: {
    buildId: "a".repeat(64),
    sourceSHA: "b".repeat(40),
    sourceTreeDigest: "c".repeat(64),
    platform: { goos: "darwin", goarch: "arm64" },
  },
  binary: { path: "bin/farol-core", size: 128, sha256: "d".repeat(64) },
};
const methods = [
  "computer.authority.deactivate",
  "computer.authority.publish",
  "chat.turn",
  "computer.workspace.read",
] as const;
type Fault = (method: string, outcome: Outcome) => Outcome;

async function ownerSettings(): Promise<ProductSettings> {
  let stored: ProductSettings | null = null;
  let id = 0;
  const store = new ProductSettingsStore({ root: "/synthetic/settings" });
  vi.spyOn(store, "save").mockImplementation(async (value) => {
    stored = structuredClone(value);
  });
  vi.spyOn(store, "load").mockImplementation(async () =>
    structuredClone(stored),
  );
  const service = new ProductConfigurationService(store, {
    id: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    homeDirectory: "/synthetic/home",
  });
  await service.initialize();
  const result = await service.addReadonlyWorkspace({
    root: "/synthetic/work",
    label: "Selected work",
    rootIdentity: { device: "11", inode: "22" },
  });
  if (!result.ok || result.snapshot.status !== "ready")
    throw new Error("Settings fixture failed");
  const settings = result.snapshot.settings;
  return {
    ...settings,
    revision: 23,
    computer: { ...settings.computer, generation: 7 },
  };
}

function transport(fault?: Fault) {
  const events: string[] = [];
  const replies: Outcome[] = [];
  let closePoll: (() => void) | undefined;
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      events.push(method);
      const input = body as Record<string, Json>;
      let data: Json;
      switch (method) {
        case "chat.browser.next":
          return new Promise<Outcome>((_resolve, reject) => {
            closePoll = () =>
              reject(new BridgeError("unavailable", "client_closed"));
          });
        case "computer.authority.deactivate":
          data = { fence: "9", storeRevision: "40" };
          break;
        case "computer.authority.publish":
          data = {
            fence: "9",
            storeRevision: "41",
            settingsRevision: "23",
            generation: "7",
            approvalDigest: "e".repeat(64),
            publishOperationId: options.operationId!,
          };
          break;
        case "chat.turn":
          data = {
            ownerId: "owner-desktop",
            sessionId: input.sessionId!,
            taskId: input.taskId!,
            taskEpoch: "1",
            participantId: "go-created-participant",
            turnId: input.turnId!,
            generation: "1",
            admissionOperationId: options.operationId!,
            storeRevision: "42",
          };
          break;
        case "computer.workspace.read":
          data = {
            ...input,
            text: "Selected file\n",
            bytes: "14",
            sha256: "f".repeat(64),
          };
          break;
        default:
          throw new Error(`Unexpected RPC: ${method}`);
      }
      const outcome: Outcome = {
        status: "ok",
        requestId: options.id!,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        context,
        data,
      };
      const reply = fault ? fault(method, outcome) : outcome;
      replies.push(reply);
      return reply;
    },
  );
  const close = vi.fn(async () => {
    events.push("client.close");
    closePoll?.();
  });
  // Deliberately only the host-facing Client port; no constructor/child pipes.
  const client = {
    request,
    close,
    verifiedContext: context,
  } as unknown as Client;
  return { client, request, close, events, replies };
}

let settings: ProductSettings;
let selection: DesktopCoreSelection;
let profileClose: ReturnType<typeof vi.fn>;
let start: MockInstance<AttestedCore["start"]>;
beforeEach(async () => {
  vi.clearAllMocks();
  // Host compatibility is explicit and independent of the machine running CI.
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get(target, key, receiver) {
        if (key === "platform") return "darwin";
        if (key === "arch") return "arm64";
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  );
  settings = await ownerSettings();
  selection = {
    compiledArtifact: structuredClone(artifact),
    build: {
      schema: 1,
      product: "Farol Next Preview",
      version: "0.1.0",
      bundleId: "local.farol.next.preview",
      updateChannel: "local-preview-only",
      builtAt: "2026-10-03T00:00:00.000Z",
      sourceCommit: artifact.build.sourceSHA,
      sourceTreeDigest: artifact.build.sourceTreeDigest,
      sourceDirty: false,
      buildId: artifact.build.buildId,
    },
    artifactRoot: "/synthetic/artifact",
    stateRoot: "/synthetic/state",
    home: "/synthetic/home",
    settings: vi.fn(() => settings),
    browser: vi.fn(() => ({
      driver: Object.fromEntries(
        ["prepare", "verifySend", "send", "observe", "cancel", "dispose"].map(
          (method) => [
            method,
            vi.fn(async () => {
              throw new Error(`Unexpected physical operation: ${method}`);
            }),
          ],
        ),
      ) as unknown as BrowserDriver,
      withdraw: vi.fn(),
    })),
  };
  ports.declaration = JSON.stringify(artifact);
  ports.provision.mockReturnValue({
    profileId: context.profileId,
    root: "/synthetic/state/go-core",
    storeMode: "open",
  });
  profileClose = vi.fn(() => ({ state: "closed" as const }));
  ports.qualify.mockReturnValue({
    state: "qualified",
    profile: {
      beforeSpawn: vi.fn(() => ({ state: "qualified", binding: {} })),
      close: profileClose,
    },
  });
  start = vi
    .spyOn(AttestedCore.prototype, "start")
    .mockRejectedValue(new Error("Unconfigured synthetic core launch"));
});
afterEach(() => {
  expect(ports.spawn).not.toHaveBeenCalled();
  expect(ports.legacyRead).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normal Go host startup", () => {
  it.each([
    { sourceDirty: true },
    { buildId: "1".repeat(64) },
    { sourceCommit: "2".repeat(40) },
    { sourceTreeDigest: "3".repeat(64) },
  ])(
    "refuses independent host build mismatch %j before any resources",
    async (patch) => {
      await expect(
        startDesktopGoCore({
          ...selection,
          build: { ...selection.build, ...patch },
        }),
      ).rejects.toMatchObject({
        state: "refused",
        code: "core_host_build_mismatch",
      });
      expect(selection.settings).not.toHaveBeenCalled();
      expect(ports.open).not.toHaveBeenCalled();
      expect(ports.provision).not.toHaveBeenCalled();
      expect(ports.qualify).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["goos", "goarch"] as const)(
    "refuses compiled platform %s mismatch before provisioning",
    async (field) => {
      const compiled = { ...artifact, build: { ...artifact.build } };
      if (field === "goos")
        compiled.build.platform = { goos: "linux", goarch: "arm64" };
      else compiled.build.platform = { goos: "darwin", goarch: "amd64" };
      await expect(
        startDesktopGoCore({ ...selection, compiledArtifact: compiled }),
      ).rejects.toMatchObject({ code: "core_host_build_mismatch" });
      expect(ports.open).not.toHaveBeenCalled();
      expect(ports.provision).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["build", "source", "tree", "path", "size", "digest"])(
    "refuses disk declaration %s mismatch against the independent compiled pin",
    async (field) => {
      const disk = {
        ...artifact,
        build: { ...artifact.build },
        binary: { ...artifact.binary },
      };
      if (field === "build")
        disk.build = { ...disk.build, buildId: "1".repeat(64) };
      if (field === "source")
        disk.build = { ...disk.build, sourceSHA: "2".repeat(40) };
      if (field === "tree")
        disk.build = { ...disk.build, sourceTreeDigest: "3".repeat(64) };
      if (field === "path")
        disk.binary = { ...disk.binary, path: "bin/other-core" };
      if (field === "size") disk.binary = { ...disk.binary, size: 129 };
      if (field === "digest")
        disk.binary = { ...disk.binary, sha256: "4".repeat(64) };
      ports.declaration = JSON.stringify(disk);
      await expect(startDesktopGoCore(selection)).rejects.toMatchObject({
        state: "refused",
        code: "core_host_artifact_mismatch",
      });
      expect(ports.open).toHaveBeenCalledTimes(1);
      expect(ports.close).toHaveBeenCalledExactlyOnceWith(41);
      expect(ports.provision).not.toHaveBeenCalled();
      expect(ports.qualify).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["refused", "unknown"] as const)(
    "propagates selected Go startup %s once without a replacement or TS fallback",
    async (state) => {
      const failure = new BridgeError(state, "selected_go_failed");
      start.mockRejectedValue(failure);
      await expect(startDesktopGoCore(selection)).rejects.toBe(failure);
      expect(start).toHaveBeenCalledTimes(1);
      expect(ports.provision).toHaveBeenCalledTimes(1);
      expect(profileClose).toHaveBeenCalledTimes(1);
    },
  );

  it("publishes current settings before exposing the started host", async () => {
    const f = transport();
    start.mockImplementation(async (_deadline, native) => {
      f.events.push("start");
      native!.profile.beforeSpawn();
      return f.client;
    });
    const host = await startDesktopGoCore(selection);
    expect(f.events).toEqual([
      "start",
      ...methods.slice(0, 2),
      "chat.browser.next",
    ]);
    expect(selection.browser).toHaveBeenCalledExactlyOnceWith(context);
    expect(host.chat).toBeDefined();
    expect(ports.provision).toHaveBeenCalledExactlyOnceWith(
      selection.stateRoot,
      settings.computer.computerId,
    );
    expect(ports.qualify).toHaveBeenCalledExactlyOnceWith({
      profileId: context.profileId,
      root: "/synthetic/state/go-core",
      home: selection.home,
    });
    expect(start).toHaveBeenCalledWith(
      2000,
      expect.objectContaining({
        ownerId: "owner-desktop",
        computerId: settings.computer.computerId,
        storeMode: "open",
      }),
    );
    expect(profileClose).not.toHaveBeenCalled();
    await host.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    await host.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(() => host.chat).toThrow("host_chat_unavailable");
  });

  it("withdraws physical assignments before pipe closure and preserves unknown cleanup", async () => {
    const f = transport();
    start.mockResolvedValue(f.client);
    const connection = selection.browser(context);
    const withdraw = vi.fn(() => f.events.push("browser.withdraw"));
    selection = { ...selection, browser: () => ({ ...connection, withdraw }) };
    const host = await startDesktopGoCore(selection);
    const close = f.close.getMockImplementation()!;
    const failure = new BridgeError("unknown", "backend_cleanup_unconfirmed");
    f.close.mockImplementation(async () => {
      await close();
      throw failure;
    });
    await expect(host.close()).rejects.toBe(failure);
    expect(f.events.slice(-2)).toEqual(["browser.withdraw", "client.close"]);
    await expect(host.close()).rejects.toBe(failure);
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(() => host.chat).toThrow("host_chat_unavailable");
  });

  it("does not construct a browser after refused Go publication", async () => {
    const failure = new BridgeError("refused", "publication_refused");
    const f = transport((method, outcome) => {
      if (method === "computer.authority.publish") throw failure;
      return outcome;
    });
    start.mockResolvedValue(f.client);
    await expect(startDesktopGoCore(selection)).rejects.toBe(failure);
    expect(selection.browser).not.toHaveBeenCalled();
    expect(f.events).not.toContain("chat.browser.next");
  });

  it("retains profile ownership with the client after an unknown launch handoff", async () => {
    const failure = new BridgeError("unknown", "backend_cleanup_unconfirmed");
    start.mockImplementation(async (_deadline, native) => {
      native!.profile.beforeSpawn();
      throw failure;
    });
    await expect(startDesktopGoCore(selection)).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ports.provision).toHaveBeenCalledTimes(1);
    expect(profileClose).not.toHaveBeenCalled();
  });

  it("closes the selected client after unknown startup publication without retrying", async () => {
    const failure = new BridgeError("unknown", "publication_lost");
    const f = transport((method, outcome) => {
      if (method === "computer.authority.publish") throw failure;
      return outcome;
    });
    start.mockImplementation(async (_deadline, native) => {
      native!.profile.beforeSpawn();
      return f.client;
    });
    await expect(startDesktopGoCore(selection)).rejects.toBe(failure);
    expect(f.events).toEqual([...methods.slice(0, 2), "client.close"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(profileClose).not.toHaveBeenCalled();
  });
});

describe("normal Go host read intents", () => {
  it("reads settings after withdrawal and maps the exact Go admission into the read", async () => {
    const f = transport();
    let current = { ...settings, revision: 22 };
    const settingsPort = vi.fn(() => {
      f.events.push("settings");
      return current;
    });
    const originalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const reply = await originalRequest(...args);
      if (args[0] === "computer.authority.deactivate") current = settings;
      return reply;
    });
    const host = new DesktopGoCore(f.client, settingsPort);
    const workspaceId = settings.computer.workspaces[0]!.workspaceId;
    const observed = await host.readForIntent(
      "owner-file-selection",
      workspaceId,
      "README.md",
    );
    expect(f.events).toEqual([methods[0], "settings", ...methods.slice(1)]);
    expect(settingsPort).toHaveBeenCalledTimes(1);
    const publish = f.request.mock.calls[1]![1] as Record<string, Json>;
    expect(publish).toMatchObject({
      fence: "9",
      expectedStoreRevision: "40",
      settingsRevision: "23",
      approval: {
        computerId: settings.computer.computerId,
        generation: 7,
        workspaces: [
          {
            workspaceId,
            root: "/synthetic/work",
            rootIdentity: { device: "11", inode: "22" },
          },
        ],
      },
    });
    const admissionRequest = f.request.mock.calls[2]![1];
    expect(admissionRequest).toEqual({
      publication: f.replies[1]!.data,
      sessionId: expect.any(String),
      taskId: "owner-file-selection",
      turnId: expect.any(String),
      workspaceIds: [workspaceId],
    });
    expect(observed.admission).toEqual(f.replies[2]!.data);
    const {
      ownerId,
      sessionId,
      taskId,
      taskEpoch,
      participantId,
      turnId,
      generation,
    } = observed.admission;
    expect(f.request.mock.calls[3]![1]).toEqual({
      ownerId,
      sessionId,
      taskId,
      taskEpoch,
      participantId,
      turnId,
      generation,
      callId: expect.any(String),
      workspaceId,
      relativePath: "README.md",
    });
    expect(participantId).toBe("go-created-participant");
    expect(taskEpoch).toBe("1");
    expect(generation).toBe("1");
    expect(observed.result).toEqual({
      status: "ok",
      requestId: f.request.mock.calls[3]![2]!.id,
      context,
      data: f.replies[3]!.data,
    });
    expect(
      new Set(f.request.mock.calls.map(([, , options]) => options!.id)).size,
    ).toBe(4);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(methods.slice(0, 3))(
    "does not replay or continue after unknown %s",
    async (failedMethod) => {
      const failure = new BridgeError("unknown", "acknowledgement_lost");
      const f = transport((method, outcome) => {
        if (method === failedMethod) throw failure;
        return outcome;
      });
      const host = new DesktopGoCore(f.client, () => settings);
      await expect(
        host.readForIntent("owner-file-selection", "work", "README.md"),
      ).rejects.toBe(failure);
      const calls = f.request.mock.calls.length;
      expect(f.events).toEqual(
        methods.slice(0, methods.indexOf(failedMethod) + 1),
      );
      await expect(
        host.readForIntent("another-selection", "work", "README.md"),
      ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
      expect(f.request).toHaveBeenCalledTimes(calls);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["publication", "admission", "context"])(
    "blocks a crossed %s ACK before reading, without retry",
    async (crossed) => {
      const failedMethod = crossed === "publication" ? methods[1] : methods[2];
      const f = transport((method, outcome) => {
        if (method !== failedMethod) return outcome;
        if (crossed === "context")
          return {
            ...outcome,
            context: { ...context, backendGeneration: "other-backend" },
          };
        return {
          ...outcome,
          data: {
            ...(outcome.data as Record<string, Json>),
            ...(crossed === "publication"
              ? { publishOperationId: "other-publication" }
              : { turnId: "other-turn" }),
          },
        };
      });
      const host = new DesktopGoCore(f.client, () => settings);
      await expect(
        host.readForIntent("owner-file-selection", "work", "README.md"),
      ).rejects.toMatchObject({ state: "unknown" });
      const calls = f.request.mock.calls.length;
      await expect(host.publishCurrent()).rejects.toMatchObject({
        code: "computer_publication_unavailable",
      });
      expect(f.request).toHaveBeenCalledTimes(calls);
      expect(f.events).toEqual(
        methods.slice(0, methods.indexOf(failedMethod) + 1),
      );
    },
  );

  it.each(["refused", "unknown", "unavailable"] as const)(
    "returns selected Go read %s without TS fallback or automatic replay",
    async (status) => {
      const f = transport((method, outcome) => {
        if (method !== methods[3]) return outcome;
        const { data: _data, ...envelope } = outcome;
        return { ...envelope, status, code: "selected_read_failed" };
      });
      const host = new DesktopGoCore(f.client, () => settings);
      const observed = await host.readForIntent(
        "owner-file-selection",
        "work",
        "README.md",
      );
      expect(observed.result).toMatchObject({
        status,
        code: "selected_read_failed",
        retry: "never",
      });
      expect(f.events).toEqual(methods);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("does not disclose a successful read belonging to a different participant", async () => {
    const f = transport((method, outcome) =>
      method === methods[3]
        ? {
            ...outcome,
            data: {
              ...(outcome.data as Record<string, Json>),
              participantId: "other-participant",
            },
          }
        : outcome,
    );
    const host = new DesktopGoCore(f.client, () => settings);
    const observed = await host.readForIntent(
      "owner-file-selection",
      "work",
      "README.md",
    );
    expect(observed.result).toMatchObject({
      status: "unknown",
      code: "crossed_computer_response",
      retry: "never",
    });
    expect(observed.result).not.toHaveProperty("data");
    expect(f.events).toEqual(methods);
  });

  it("returns an unknown lost read response without reissuing admission or read", async () => {
    const f = transport((method, outcome) => {
      if (method === methods[3])
        throw new BridgeError("unknown", "read_response_lost");
      return outcome;
    });
    const host = new DesktopGoCore(f.client, () => settings);
    const observed = await host.readForIntent(
      "owner-file-selection",
      "work",
      "README.md",
    );
    expect(observed.result).toMatchObject({
      status: "unknown",
      code: "read_response_lost",
      retry: "never",
    });
    expect(observed.result).not.toHaveProperty("data");
    expect(f.events).toEqual(methods);
    expect(start).not.toHaveBeenCalled();
  });
});

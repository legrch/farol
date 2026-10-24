import {
  startDesktopGoRecovery,
  type RecoveryCoreSelection,
} from "../../apps/desktop/recovery/core-host.ts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { desktopCoreArtifactRoot } from "../../apps/desktop/dev-core-layout.ts";
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
import { CORE_QUALIFICATION_BUDGET_MS } from "../../apps/desktop/bridge/core-resources.ts";
import type {
  Json,
  Outcome,
  ChatReadIntentAccountApprove,
} from "../../apps/desktop/bridge/wire.ts";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import shellFixture from "../fixtures/shell-launch.json";

// Source-only composition tests: artifact bytes, provisioning, launch and RPC
// are explicit doubles. Authority/Computer adapters and artifact parsing are real.
// No native executable, profile, Electron main, provider or model is exercised.
const ports = vi.hoisted(() => ({
  declaration: "",
  open: vi.fn(() => 41),
  close: vi.fn(),
  provision: vi.fn(),
  existing: vi.fn(),
  qualify: vi.fn(),
  resources: vi.fn(async (..._args: unknown[]) => undefined),
  runtime: vi.fn(async (..._args: unknown[]) => ({
    path: "/synthetic/Farol.app",
    device: "11",
    inode: "22",
  })),
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
  openExistingNativeProfileStorage: ports.existing,
}));
vi.mock("../../apps/desktop/bridge/profile.ts", () => ({
  qualifyProfileLaunch: ports.qualify,
}));
vi.mock("../../apps/desktop/bridge/core-resources.ts", async (original) => ({
  ...(await original<
    typeof import("../../apps/desktop/bridge/core-resources.ts")
  >()),
  verifyCoreResources: ports.resources,
}));
vi.mock("../../apps/desktop/bridge/shell-runtime.ts", () => ({
  attestShellRuntime: ports.runtime,
}));
vi.mock(
  "../../src/modules/computer/infra/native/native-readonly-workspace",
  () => ({
    NativeReadonlyWorkspace: class {
      execute = ports.legacyRead;
    },
  }),
);

const context = {
  profileId: "00000000-0000-4000-8000-00000000000a",
  backendGeneration: "backend-one",
};
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
  let stopPoll: (() => void) | undefined;
  let closeStorePoll: (() => void) | undefined;
  let stopStorePoll: (() => void) | undefined;
  let quiesced = false;
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      events.push(method);
      const input = body as Record<string, Json>;
      let data: Json;
      switch (method) {
        case "chat.browser.next":
          if (quiesced) {
            data = {};
            break;
          }
          return new Promise<Outcome>((resolve, reject) => {
            closePoll = () =>
              reject(new BridgeError("unavailable", "client_closed"));
            stopPoll = () =>
              resolve({
                status: "ok",
                requestId: options.id!,
                context,
                data: {},
              });
          });
        case "computer.settings.store.next":
          if (quiesced) {
            data = {};
            break;
          }
          return new Promise<Outcome>((resolve, reject) => {
            closeStorePoll = () =>
              reject(new BridgeError("unavailable", "client_closed"));
            stopStorePoll = () =>
              resolve({
                status: "ok",
                requestId: options.id!,
                context,
                data: {},
              });
          });
        case "core.retirement.prepare":
          quiesced = true;
          stopPoll?.();
          stopStorePoll?.();
          data = { handoffId: input.handoffId!, receiptDigest: "d".repeat(64) };
          break;
        case "core.retirement.ack":
          data = { ...input, ackDigest: "a".repeat(64) };
          break;
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
        case "computer.settings.list":
          data = {
            ...input,
            root: { path: "/synthetic/work", device: "1", inode: "2" },
            entries: ["note.md", "folder/"],
            truncated: false,
          };
          break;
        case "computer.settings.snapshot":
          data = {
            ...input,
            root: { path: "/synthetic/work", device: "1", inode: "2" },
            bytes: 5,
            sha256: "b".repeat(64),
          };
          break;
        case "computer.settings.search":
          data = {
            ...input,
            root: { path: "/synthetic/work", device: "1", inode: "2" },
            matches: [
              {
                path: "note.md",
                line: "1",
                text: "retained",
                truncated: false,
              },
            ],
            resultLimited: false,
            scanLimited: false,
          };
          break;
        case "computer.settings.delivery.apply":
        case "computer.settings.delivery.observe": {
          const edit = input.request as Record<string, Json> | undefined;
          const pending = edit
            ? {
                backend: "go-owner-v2",
                operationId: options.operationId!,
                profileId: context.profileId,
                workspaceId: edit.workspaceId!,
                relativePath: edit.relativePath!,
                computerGeneration: (edit.publication as Record<string, Json>)
                  .generation!,
                beforeSHA256: edit.expectedSHA256!,
                submittedAt: "2026-10-04T00:00:00.123456789Z",
              }
            : (input.pending as Record<string, Json>);
          data = {
            state: "offered",
            pending,
            receiptId: "delivery-receipt",
            retention: "durable",
            result: {
              operationId: pending.operationId!,
              workspaceId: pending.workspaceId!,
              computerGeneration: pending.computerGeneration!,
              phase: "completed",
              publication: "durable",
              receipt: {
                operation: "edit",
                relativePath: pending.relativePath!,
                bytes: "8",
                replacements: 1,
                beforeSHA256: pending.beforeSHA256!,
                afterSHA256: "c".repeat(64),
              },
            },
          };
          break;
        }
        case "computer.settings.delivery.ack":
          data = {
            receiptId: input.receiptId!,
            pending: input.pending!,
            acknowledged: true,
          };
          break;
        case "chat.readintent.account.approve":
          data = {
            admission: input.admission!,
            approvalId: "go-account-approval",
            principalKey: input.confirmedPrincipalKey!,
          };
          break;
        case "chat.readintent.account.revoke":
          data = { admission: input.admission! };
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
    closeStorePoll?.();
  });
  const closeAndObserve = vi
    .fn<Client["closeAndObserve"]>()
    .mockResolvedValue(
      Object.freeze({ exitCode: 0, signal: null, forced: false }),
    );
  // Deliberately only the host-facing Client port; no constructor/child pipes.
  const client = {
    request,
    close,
    closeAndObserve,
    verifiedContext: context,
    verifiedCapabilities: Object.freeze([
      "core.status",
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.inspect",
      "computer.settings.list",
      "computer.settings.search",
      "computer.settings.snapshot",
      "chat.archive.list",
      "chat.archive.read",
    ]),
  } as unknown as Client;
  return { client, request, close, closeAndObserve, events, replies };
}

let settings: ProductSettings;
let selection: DesktopCoreSelection;
let profileClose: ReturnType<typeof vi.fn>;
let start: MockInstance<AttestedCore["start"]>;
function shellSelection(): DesktopCoreSelection {
  const core = {
    ...structuredClone(artifact),
    binary: { ...artifact.binary, path: "farol-backend" },
  };
  const support = {
    ...structuredClone(shellFixture.declaration),
    core: structuredClone(core),
  };
  ports.declaration = JSON.stringify(core);
  return {
    ...selection,
    artifactRoot: "/synthetic/Farol.app/Contents/Resources/app",
    compiledArtifact: core,
    compiledResources: { synthetic: "independent-resource-selection" },
    compiledShell: {
      support,
      watchdogSource: Buffer.from(shellFixture.host.watchdogSource),
    },
  };
}
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
    previousHostDrainConfirmed: true,
    compiledArtifact: structuredClone(artifact),
    build: {
      schema: 1,
      product: "Farol",
      version: "0.1.0",
      bundleId: "io.github.legrch.farol",
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
    settingsMutations: true,
  });
  ports.existing.mockReturnValue({
    profileId: context.profileId,
    root: "/synthetic/state/go-core",
    storeMode: "open",
    settingsMutations: false,
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
  vi.spyOn(AttestedCore.prototype, "completeRetirement").mockResolvedValue();
});
afterEach(() => {
  expect(ports.spawn).not.toHaveBeenCalled();
  expect(ports.legacyRead).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normal Go host startup", () => {
  it("withdraws backend availability when the original verified pipe ends without a new request", async () => {
    const f = transport();
    const host = new DesktopGoCore(f.client, () => settings);
    expect(host.backendAvailable).toBe(true);
    Object.defineProperty(f.client, "verifiedContext", {
      get: () => {
        throw new BridgeError("unavailable", "backend_unavailable");
      },
    });
    expect(host.backendAvailable).toBe(false);
    expect(host.backendAvailable).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    await host.close();
    expect(host.backendAvailable).toBe(false);
  });
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
        startDesktopGoCore({
          ...selection,
          previousHostDrainConfirmed: true,
          compiledArtifact: compiled,
        }),
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
      expect(start.mock.calls[0]![0]).toBe(15_000);
      expect(ports.provision).toHaveBeenCalledTimes(1);
      expect(profileClose).toHaveBeenCalledTimes(1);
    },
  );

  it("checks compiled resources before provisioning or spawning", async () => {
    const compiledResources = { synthetic: "independent-resource-selection" };
    const failure = new BridgeError("refused", "core_resources_unqualified");
    ports.resources.mockRejectedValueOnce(failure);
    await expect(
      startDesktopGoCore({ ...selection, compiledResources }),
    ).rejects.toBe(failure);
    expect(ports.resources).toHaveBeenCalledExactlyOnceWith(
      selection.artifactRoot,
      compiledResources,
      artifact,
      expect.any(Number),
    );
    expect(ports.provision).not.toHaveBeenCalled();
    expect(ports.qualify).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps the selected-read source absent by default", async () => {
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore(selection);
    expect(start.mock.calls[0]![1]).not.toHaveProperty("codexRead");
    await host.close();
  });

  it("copies the trusted read pair before awaited qualification", async () => {
    const codexRead = { hostId: "codex" as const, trustedTemp: "/app/tmp" };
    const input = { ...selection, compiledResources: {}, codexRead };
    const f = transport();
    start.mockResolvedValue(f.client);
    ports.resources.mockImplementationOnce(async () => {
      codexRead.trustedTemp = "/other/tmp";
      input.codexRead = { hostId: "codex", trustedTemp: "/replacement/tmp" };
    });
    const host = await startDesktopGoCore(input);
    const native = start.mock.calls[0]![1]!;
    expect(native.codexRead).toEqual({
      hostId: "codex",
      trustedTemp: "/app/tmp",
    });
    expect(native.codexRead).not.toBe(codexRead);
    expect(Object.isFrozen(native.codexRead)).toBe(true);
    await host.close();
  });

  it("refuses a trusted-read accessor before resource or profile work", async () => {
    const get = vi.fn(() => {
      throw new Error("Accessor must remain uncalled");
    });
    Object.defineProperty(selection, "codexRead", { get });
    await expect(startDesktopGoCore(selection)).rejects.toMatchObject({
      code: "invalid_codex_read_launch",
    });
    expect(get).not.toHaveBeenCalled();
    expect(ports.resources).not.toHaveBeenCalled();
    expect(ports.provision).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["refused", "unknown"] as const)(
    "does not replace a selected-read launch after %s startup",
    async (state) => {
      const failure = new BridgeError(state, "selected_go_failed");
      start.mockRejectedValue(failure);
      await expect(
        startDesktopGoCore({
          ...selection,
          codexRead: { hostId: "codex", trustedTemp: "/app/tmp" },
        }),
      ).rejects.toBe(failure);
      expect(start).toHaveBeenCalledTimes(1);
      expect(profileClose).toHaveBeenCalledTimes(1);
      expect(ports.legacyRead).not.toHaveBeenCalled();
    },
  );

  it("binds the qualified bundle and original host identifiers to one child", async () => {
    const input = shellSelection();
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore(input);
    const native = start.mock.calls[0]![1]!;
    const payload = JSON.parse(Buffer.from(native.shellMetadata!).toString());
    expect(payload.BuildID).toBe(artifact.build.buildId);
    expect(payload.ProfileID).toBe(context.profileId);
    expect(payload.HostLifetimeID).toBe(native.hostLifetimeId);
    expect(payload.ChildLaunchID).toBe(native.childLaunchId);
    expect(payload.Support.ProtectedBundle).toEqual({
      Path: "/synthetic/Farol.app",
      Identity: { Device: "11", Inode: "22" },
    });
    expect(payload.Support.Backend.Path).toBe(
      "/synthetic/Farol.app/Contents/Resources/app/farol-backend",
    );
    expect(ports.runtime.mock.calls[0]![2]).toBe(
      ports.resources.mock.calls[0]![3],
    );
    expect(ports.resources.mock.invocationCallOrder[0]).toBeLessThan(
      ports.runtime.mock.invocationCallOrder[0]!,
    );
    expect(ports.runtime.mock.invocationCallOrder[0]).toBeLessThan(
      ports.provision.mock.invocationCallOrder[0]!,
    );
    expect(start).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it("keeps the readable packaged route for a version-1 profile without Shell metadata", async () => {
    const input = shellSelection();
    ports.provision.mockReturnValueOnce({
      profileId: context.profileId,
      root: "/synthetic/state/go-core",
      storeMode: "open",
      settingsMutations: false,
    });
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore(input);
    expect(ports.resources).toHaveBeenCalledTimes(1);
    expect(ports.runtime).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    const native = start.mock.calls[0]![1]!;
    expect(native.storeMode).toBe("open");
    expect(native.settingsMutations).toBe(false);
    expect(Object.hasOwn(native, "shellMetadata")).toBe(false);
    expect(() => host.settingsMutationProfile()).toThrow(
      "host_mutation_storage_unavailable",
    );
    await host.close();
  });

  it.each([undefined, null])(
    "withholds selected Shell without resource closure: %s",
    async (compiledResources) => {
      const input = shellSelection();
      await expect(
        startDesktopGoCore({ ...input, compiledResources }),
      ).rejects.toThrow("shell_host_resources_missing");
      expect(ports.runtime).not.toHaveBeenCalled();
      expect(ports.provision).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("refuses a crossed Shell core before filesystem qualification", async () => {
    const input = shellSelection();
    const support = input.compiledShell!
      .support as typeof shellFixture.declaration;
    support.core.binary.sha256 = "9".repeat(64);
    await expect(startDesktopGoCore(input)).rejects.toThrow(
      "shell_support_binding_mismatch",
    );
    expect(ports.resources).not.toHaveBeenCalled();
    expect(ports.runtime).not.toHaveBeenCalled();
    expect(ports.provision).not.toHaveBeenCalled();
  });

  it("refuses an unpackaged Shell layout without provisioning", async () => {
    const input = shellSelection();
    await expect(
      startDesktopGoCore({ ...input, artifactRoot: "/synthetic/artifact" }),
    ).rejects.toThrow("shell_host_layout_mismatch");
    expect(ports.runtime).not.toHaveBeenCalled();
    expect(ports.provision).not.toHaveBeenCalled();
  });

  it("qualifies source Dev Shell from its launcher-owned protected resource layout", async () => {
    const input = shellSelection();
    const artifactRoot = desktopCoreArtifactRoot(
      "/synthetic/repo/_output/dev-core/Contents/Resources/app",
      "dev",
    );
    const appRoot = "/synthetic/repo/_output/dev-core";
    ports.runtime.mockResolvedValueOnce({
      path: appRoot,
      device: "11",
      inode: "22",
    });
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore({ ...input, artifactRoot });
    expect(ports.resources).toHaveBeenCalledWith(
      artifactRoot,
      input.compiledResources,
      expect.anything(),
      expect.any(Number),
    );
    expect(ports.runtime).toHaveBeenCalledWith(
      appRoot,
      input.compiledShell!.support,
      expect.any(Number),
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![1]!.shellMetadata).toBeInstanceOf(Uint8Array);
    expect(host.shellAvailable).toBe(true);
    await host.close();
    expect(host.shellAvailable).toBe(false);
  });

  it.each(["dev", "preview"] as const)(
    "keeps packaged %s Shell checks mandatory with no failure fallback",
    async (environment) => {
      const input = shellSelection();
      const artifactRoot = desktopCoreArtifactRoot(
        input.artifactRoot,
        environment,
      );
      expect(artifactRoot).toBe(input.artifactRoot);
      const failure = new BridgeError("refused", "shell_runtime_unqualified");
      ports.runtime.mockRejectedValueOnce(failure);
      await expect(startDesktopGoCore({ ...input, artifactRoot })).rejects.toBe(
        failure,
      );
      expect(ports.provision).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("preserves runtime qualification refusal without launching a fallback", async () => {
    const input = shellSelection();
    const failure = new BridgeError("refused", "shell_runtime_unqualified");
    ports.runtime.mockRejectedValueOnce(failure);
    await expect(startDesktopGoCore(input)).rejects.toBe(failure);
    expect(ports.provision).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  // Measured: a busy packaged launch spent 2 s on qualification that takes
  // 0.3 s idle, and the former 2 s budget refused one launch in fifteen.
  it("gives resource and Shell qualification one startup budget, not two seconds", async () => {
    const input = shellSelection();
    const f = transport();
    start.mockResolvedValue(f.client);
    const before = performance.now();
    const host = await startDesktopGoCore(input);
    const deadline = ports.resources.mock.calls[0]![3] as number;
    // The deadline is created after `before`, so a correct host always gives
    // at least the full budget from `before`; setup time only adds to it. The
    // 1 ms only absorbs floating-point rounding. The old 2 s budget fails here.
    expect(deadline - before).toBeGreaterThanOrEqual(
      CORE_QUALIFICATION_BUDGET_MS - 1,
    );
    expect(deadline - performance.now()).toBeLessThanOrEqual(
      CORE_QUALIFICATION_BUDGET_MS,
    );
    expect(CORE_QUALIFICATION_BUDGET_MS).toBe(10_000);
    expect(ports.runtime.mock.calls[0]![2]).toBe(deadline);
    await host.close();
  });

  it("stops selected Shell at a failed resource check", async () => {
    const input = shellSelection();
    const failure = new BridgeError("refused", "core_resources_unqualified");
    ports.resources.mockRejectedValueOnce(failure);
    await expect(startDesktopGoCore(input)).rejects.toBe(failure);
    expect(ports.runtime).not.toHaveBeenCalled();
    expect(ports.provision).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a runtime identity for a different bundle", async () => {
    const input = shellSelection();
    ports.runtime.mockResolvedValueOnce({
      path: "/other/Farol.app",
      device: "11",
      inode: "22",
    });
    await expect(startDesktopGoCore(input)).rejects.toThrow(
      "shell_host_layout_mismatch",
    );
    expect(ports.provision).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([Buffer.alloc(0), Buffer.alloc(65537)])(
    "refuses an unbounded or empty watchdog before resource IO",
    async (watchdogSource) => {
      const input = shellSelection();
      await expect(
        startDesktopGoCore({
          ...input,
          compiledShell: { ...input.compiledShell!, watchdogSource },
        }),
      ).rejects.toThrow("invalid_shell_launch_metadata");
      expect(ports.resources).not.toHaveBeenCalled();
      expect(ports.runtime).not.toHaveBeenCalled();
      expect(ports.provision).not.toHaveBeenCalled();
    },
  );

  it("freezes the Shell source and support before asynchronous qualification", async () => {
    const input = shellSelection();
    const source = Buffer.from(input.compiledShell!.watchdogSource);
    ports.resources.mockImplementationOnce(async () => {
      input.compiledShell!.watchdogSource.fill(0);
      (
        input.compiledShell!.support as typeof shellFixture.declaration
      ).qualification.osBuild = "25A999";
    });
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore(input);
    const payload = JSON.parse(
      Buffer.from(start.mock.calls[0]![1]!.shellMetadata!).toString(),
    );
    expect(payload.WatchdogSourceBase64).toBe(source.toString("base64"));
    expect(payload.Support.OSBuild).toBe(
      shellFixture.declaration.qualification.osBuild,
    );
    await host.close();
  });

  it("closes the original profile when selected watchdog source does not match", async () => {
    const input = shellSelection();
    input.compiledShell!.watchdogSource.fill(0);
    await expect(startDesktopGoCore(input)).rejects.toThrow(
      "invalid_shell_launch_metadata",
    );
    expect(profileClose).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("publishes current settings before exposing the started host", async () => {
    const f = transport();
    start.mockImplementation(async (_deadline, native) => {
      f.events.push("start");
      native!.profile.beforeSpawn();
      return f.client;
    });
    const compiledResources = { synthetic: "independent-resource-selection" };
    const host = await startDesktopGoCore({ ...selection, compiledResources });
    expect(start.mock.calls[0]![1]).not.toHaveProperty("shellMetadata");
    expect(ports.runtime).not.toHaveBeenCalled();
    expect(ports.resources).toHaveBeenCalledExactlyOnceWith(
      selection.artifactRoot,
      compiledResources,
      artifact,
      expect.any(Number),
    );
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
      15_000,
      expect.objectContaining({
        ownerId: "owner-desktop",
        computerId: settings.computer.computerId,
        storeMode: "open",
        settingsMutations: true,
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
  it("approves only on an explicit host call and retains the original Go receipt", async () => {
    const f = transport();
    const host = new DesktopGoCore(f.client, () => settings);
    const read = await host.readForIntent(
      "preview",
      settings.computer.workspaces[0]!.workspaceId,
      "README.md",
    );
    expect(f.events).toEqual(methods);
    const request: ChatReadIntentAccountApprove = {
      admission: read.admission,
      confirmedPrincipalKey: "c".repeat(64),
      observation: {
        state: "observed",
        source: "provider-session-v1",
        principalKey: "c".repeat(64),
        observedAtMillis: "1",
        expiresAtMillis: "100",
      },
    };
    const receipt = await host.approveReadAccount(request);
    expect(await host.approveReadAccount(request)).toEqual(receipt);
    expect(receipt).toEqual({
      admission: read.admission,
      approvalId: "go-account-approval",
      principalKey: request.confirmedPrincipalKey,
    });
    const revoke = {
      admission: read.admission,
      approvalId: receipt.approvalId,
    };
    await host.revokeReadAccount(revoke);
    await host.revokeReadAccount(revoke);
    expect(f.events).toEqual([
      ...methods,
      "chat.readintent.account.approve",
      "chat.readintent.account.revoke",
    ]);
    await host.close();
    expect(() => host.approveReadAccount(request)).toThrow(
      "host_read_intent_unavailable",
    );
    expect(() => host.revokeReadAccount(revoke)).toThrow(
      "host_read_intent_unavailable",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("does not repeat an unknown explicit account confirmation", async () => {
    const failure = new BridgeError("unknown", "lost-account-approval");
    const f = transport((method, outcome) => {
      if (method === "chat.readintent.account.approve") throw failure;
      return outcome;
    });
    const host = new DesktopGoCore(f.client, () => settings);
    const read = await host.readForIntent(
      "preview",
      settings.computer.workspaces[0]!.workspaceId,
      "README.md",
    );
    const request: ChatReadIntentAccountApprove = {
      admission: read.admission,
      confirmedPrincipalKey: "c".repeat(64),
      observation: {
        state: "observed",
        source: "provider-session-v1",
        principalKey: "c".repeat(64),
        observedAtMillis: "1",
        expiresAtMillis: "100",
      },
    };
    await expect(host.approveReadAccount(request)).rejects.toBe(failure);
    await expect(host.approveReadAccount(request)).rejects.toBe(failure);
    expect(f.events).toEqual([...methods, "chat.readintent.account.approve"]);
    expect(ports.legacyRead).not.toHaveBeenCalled();
  });
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

it("refuses unknown prior host drain before provisioning or child launch", async () => {
  await expect(
    startDesktopGoCore({ ...selection, previousHostDrainConfirmed: false }),
  ).rejects.toMatchObject({ code: "previous_host_drain_unconfirmed" });
  expect(start).not.toHaveBeenCalled();
  expect(ports.provision).not.toHaveBeenCalled();
});

it.each(["core.retirement.prepare", "core.retirement.ack"])(
  "never retries lost %s or calls the recorder",
  async (method) => {
    const fault = new BridgeError("unknown", "reply_lost");
    const f = transport((name, reply) => {
      if (name === method) throw fault;
      return reply;
    });
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoCore(selection);
    await expect(host.close()).rejects.toBe(fault);
    await expect(host.close()).rejects.toBe(fault);
    expect(f.events.filter((name) => name === method)).toHaveLength(1);
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  },
);

it("retains recorder uncertainty across repeated host close", async () => {
  const f = transport();
  start.mockResolvedValue(f.client);
  const fault = new BridgeError("unknown", "recorder_lost");
  vi.mocked(AttestedCore.prototype.completeRetirement).mockRejectedValue(fault);
  const host = await startDesktopGoCore(selection);
  await expect(host.close()).rejects.toBe(fault);
  await expect(host.close()).rejects.toBe(fault);
  expect(AttestedCore.prototype.completeRetirement).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("aborts a later Electron startup failure after browser connection without retirement", async () => {
  const f = transport();
  start.mockResolvedValue(f.client);
  const host = await startDesktopGoCore(selection);
  expect(host.chat).toBeDefined();
  await host.abortStartup();
  await host.abortStartup();
  await host.close();
  expect(f.events).not.toContain("core.retirement.prepare");
  expect(f.events).not.toContain("core.retirement.ack");
  expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("preserves unknown post-connect startup cleanup on later Quit", async () => {
  const f = transport();
  start.mockResolvedValue(f.client);
  const host = await startDesktopGoCore(selection);
  const original = f.close.getMockImplementation()!;
  const failure = new BridgeError("unknown", "startup_cleanup_lost");
  f.close.mockImplementation(async () => {
    await original();
    throw failure;
  });
  await expect(host.abortStartup()).rejects.toBe(failure);
  await expect(host.close()).rejects.toBe(failure);
  expect(f.events).not.toContain("core.retirement.prepare");
  expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
});

describe("normal host Go Settings mutation route", () => {
  it("uses the captured owner publication, retains exact profile and observes after withdrawal", async () => {
    const f = transport();
    const host = new DesktopGoCore(f.client, () => settings, undefined, true);
    await host.publishCurrent();
    const fence = vi.fn(async () => undefined);
    host.connectSettingsStore(() => ({
      read: async () => ({ status: "unavailable" }),
      replace: async () => ({ status: "unknown" }),
      fence,
    }));
    expect(host.settingsMutationProfile()).toBe(context.profileId);
    const workspaceId = settings.computer.workspaces[0]!.workspaceId;
    const result = await host.editSettingsWorkspace(
      "00000000-0000-4000-8000-00000000000e",
      7,
      workspaceId,
      "note.md",
      "b".repeat(64),
      "old",
      "new",
    );
    expect(result.result?.phase).toBe("completed");
    await expect(
      host.editSettingsWorkspace(
        "00000000-0000-4000-8000-00000000000e",
        7,
        workspaceId,
        "note.md",
        "b".repeat(64),
        "old",
        "new",
      ),
    ).rejects.toBeDefined();
    await host.withdraw();
    const read = result.pending;
    expect(await host.observeSettingsMutation(read)).toEqual(result);
    const calls = f.request.mock.calls.length;
    expect(() =>
      host.observeSettingsMutation({ ...read, profileId: "another-profile" }),
    ).toThrow("host_mutation_profile_crossed");
    expect(f.request).toHaveBeenCalledTimes(calls);
    expect(f.events).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.store.next",
      "computer.settings.delivery.apply",
      "computer.authority.deactivate",
      "computer.settings.delivery.observe",
    ]);
    expect(ports.legacyRead).not.toHaveBeenCalled();
    await host.close();
  });
  it("does not enable writes for a legacy profile or infer readiness from settings", async () => {
    const f = transport();
    const host = new DesktopGoCore(f.client, () => settings);
    expect(() => host.settingsMutationProfile()).toThrow(
      "host_mutation_storage_unavailable",
    );
    expect(() =>
      host.editSettingsWorkspace(
        "edit",
        7,
        "work",
        "note.md",
        "b".repeat(64),
        "old",
        "new",
      ),
    ).toThrow("host_mutation_storage_unavailable");
    expect(f.request).not.toHaveBeenCalled();
    await host.close();
  });
});

function recoverySelection(): RecoveryCoreSelection {
  return {
    compiledArtifact: selection.compiledArtifact,
    compiledResources: { synthetic: "independent-resource-selection" },
    build: selection.build,
    artifactRoot: selection.artifactRoot,
    stateRoot: selection.stateRoot,
    home: selection.home,
    settings,
  };
}

describe("explicit recovery Go host composition", () => {
  it("uses the original archive-only handshake without a Computer effect probe", async () => {
    const f = transport();
    Object.defineProperty(f.client, "verifiedCapabilities", {
      value: Object.freeze([
        "core.status",
        "chat.archive.list",
        "chat.archive.read",
      ]),
    });
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    expect(host.folderReadsAvailable).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    for (const read of [
      () => host.list("work", "."),
      () => host.search("work", ".", "text"),
      () => host.snapshot("work", "note.md"),
    ])
      await expect(read()).rejects.toMatchObject({
        state: "unavailable",
        code: "recovery_computer_unavailable",
      });
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockImplementationOnce(async (_method, _body, options) => ({
      status: "ok",
      requestId: options!.id!,
      context,
      data: {
        observation: "stored_unconfirmed",
        entries: [],
        next: "",
        unresolved: false,
      },
    }));
    expect((await host.archiveList("")).observation).toBe("stored_unconfirmed");
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "chat.archive.list",
      { after: "" },
      expect.anything(),
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
    await host.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    await expect(host.archiveList("")).rejects.toMatchObject({
      code: "recovery_computer_closed",
    });
  });
  it.each([
    ["core.status", "chat.archive.list"],
    ["core.status", "chat.archive.read"],
    [
      "core.status",
      "chat.archive.list",
      "chat.archive.read",
      "computer.authority.deactivate",
    ],
    [
      "core.status",
      "chat.archive.list",
      "chat.archive.read",
      "computer.settings.list",
    ],
    ["core.status", "chat.archive.list", "chat.archive.read", "task.create"],
  ])(
    "refuses incomplete or broadened recovery capabilities before effects: %j",
    async (...capabilities) => {
      const f = transport();
      Object.defineProperty(f.client, "verifiedCapabilities", {
        value: Object.freeze(capabilities),
      });
      start.mockResolvedValue(f.client);
      await expect(
        startDesktopGoRecovery(recoverySelection()),
      ).rejects.toMatchObject({ code: "invalid_recovery_capabilities" });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );
  it("retains a lost handshake observation and closes its original child", async () => {
    const f = transport();
    const failure = new BridgeError("unknown", "backend_unavailable");
    Object.defineProperty(f.client, "verifiedCapabilities", {
      get() {
        throw failure;
      },
    });
    start.mockResolvedValue(f.client);
    await expect(startDesktopGoRecovery(recoverySelection())).rejects.toBe(
      failure,
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("qualifies existing storage and one child, publishes owner-only grants and exposes only bounded reads", async () => {
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    expect(ports.resources).toHaveBeenCalledTimes(1);
    expect(ports.existing).toHaveBeenCalledExactlyOnceWith(
      selection.stateRoot,
      settings.computer.computerId,
    );
    expect(ports.provision).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![1]).toMatchObject({
      startupMode: "recovery",
      storeMode: "open",
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      hostLifetimeId: expect.any(String),
      childLaunchId: expect.any(String),
    });
    for (const field of [
      "previousHostDrainConfirmed",
      "settingsMutations",
      "codexRead",
      "shellMetadata",
    ])
      expect(start.mock.calls[0]![1]).not.toHaveProperty(field);
    expect(ports.resources.mock.invocationCallOrder[0]!).toBeLessThan(
      ports.existing.mock.invocationCallOrder[0]!,
    );
    expect(f.request.mock.calls[1]![1]).not.toHaveProperty(
      "taskCurrentSettings",
    );
    expect(Object.keys(host).sort()).toEqual([
      "archiveList",
      "archiveRead",
      "close",
      "closeAndObserve",
      "folderReadsAvailable",
      "isAvailable",
      "list",
      "search",
      "snapshot",
    ]);
    expect(host.folderReadsAvailable).toBe(true);
    expect(Object.isFrozen(host)).toBe(true);
    const workspace = settings.computer.workspaces[0]!.workspaceId;
    expect((await host.list(workspace, ".")).entries).toEqual([
      "note.md",
      "folder/",
    ]);
    expect((await host.snapshot(workspace, "note.md")).bytes).toBe(5);
    expect(
      (await host.search(workspace, ".", "retained")).matches[0]!.path,
    ).toBe("note.md");
    await host.close();
    await host.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([
      "computer.authority.deactivate",
      "computer.authority.publish",
      "computer.settings.list",
      "computer.settings.snapshot",
      "computer.settings.search",
      "client.close",
    ]);
    expect(selection.browser).not.toHaveBeenCalled();
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
    await expect(host.list(workspace, ".")).rejects.toMatchObject({
      code: "recovery_computer_closed",
    });
  });
  it.each([undefined, null])(
    "requires independent compiled resources: %s",
    async (compiledResources) => {
      await expect(
        startDesktopGoRecovery({ ...recoverySelection(), compiledResources }),
      ).rejects.toMatchObject({ code: "core_host_resources_missing" });
      expect(ports.existing).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it("refuses resource failure before profile consumption", async () => {
    const error = new BridgeError("refused", "core_resources_unqualified");
    ports.resources.mockRejectedValueOnce(error);
    await expect(startDesktopGoRecovery(recoverySelection())).rejects.toBe(
      error,
    );
    expect(ports.existing).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    { storeMode: "create", settingsMutations: false },
    { storeMode: "open", settingsMutations: true },
  ])("refuses broader storage before qualification: %j", async (invalid) => {
    ports.existing.mockReturnValueOnce({
      profileId: context.profileId,
      root: "/synthetic/state/go-core",
      ...invalid,
    });
    await expect(
      startDesktopGoRecovery(recoverySelection()),
    ).rejects.toMatchObject({ code: "invalid_recovery_storage" });
    expect(ports.qualify).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it.each(["refused", "unknown"] as const)(
    "preserves the one original selected launch %s without fallback",
    async (state) => {
      const error = new BridgeError(state, "selected_recovery_failed");
      start.mockRejectedValue(error);
      await expect(startDesktopGoRecovery(recoverySelection())).rejects.toBe(
        error,
      );
      expect(start).toHaveBeenCalledTimes(1);
      expect(profileClose).toHaveBeenCalledTimes(1);
      expect(ports.provision).not.toHaveBeenCalled();
      expect(selection.browser).not.toHaveBeenCalled();
    },
  );
  it("closes the original child if its verified context is already unavailable", async () => {
    const f = transport();
    const error = new BridgeError("unavailable", "backend_unavailable");
    Object.defineProperty(f.client, "verifiedContext", {
      get: () => {
        throw error;
      },
    });
    start.mockResolvedValue(f.client);
    await expect(startDesktopGoRecovery(recoverySelection())).rejects.toBe(
      error,
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps original publication loss and cleanup loss without another child", async () => {
    const f = transport((method, result) => {
      if (method !== "computer.authority.publish") return result;
      return {
        status: "unknown",
        requestId: result.requestId,
        context: result.context,
        ...(result.operationId ? { operationId: result.operationId } : {}),
        code: "publication_lost",
      };
    });
    const cleanup = new BridgeError("unknown", "owned_cleanup_unknown");
    f.close.mockRejectedValueOnce(cleanup);
    start.mockResolvedValue(f.client);
    await expect(
      startDesktopGoRecovery(recoverySelection()),
    ).rejects.toMatchObject({
      message: "recovery_startup_and_cleanup_unconfirmed",
      errors: [expect.objectContaining({ state: "unknown" }), cleanup],
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      f.events.filter((event) => event === "computer.authority.publish"),
    ).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
  });
  it("withholds a read that finishes after this view closes", async () => {
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    const perform = f.request.getMockImplementation()!;
    let release!: () => void;
    const retained = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async (...args) => {
      await retained;
      return perform(...args);
    });
    const result = host.list(settings.computer.workspaces[0]!.workspaceId, ".");
    await host.close();
    release();
    await expect(result).rejects.toMatchObject({
      code: "recovery_computer_closed",
    });
  });
  it("retains the original observation promise and immediately withdraws reads", async () => {
    const f = transport();
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    const result = host.closeAndObserve();
    expect(host.closeAndObserve()).toBe(result);
    expect(host.isAvailable()).toBe(false);
    await expect(host.archiveList("")).rejects.toMatchObject({
      code: "recovery_computer_closed",
    });
    expect(await result).toBe(await f.closeAndObserve.mock.results[0]!.value);
    await host.close();
    await host.close();
    expect(f.closeAndObserve).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
  });
  it("waits for an original plain close before observing without another launch", async () => {
    const f = transport();
    let finish!: () => void;
    f.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    const closing = host.close();
    const result = host.closeAndObserve();
    expect(host.close()).toBe(closing);
    expect(f.closeAndObserve).not.toHaveBeenCalled();
    finish();
    await closing;
    await result;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.closeAndObserve).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("retains observation uncertainty for later close without another cleanup call", async () => {
    const f = transport();
    const failure = new BridgeError("unknown", "backend_terminal_unobserved");
    f.closeAndObserve.mockRejectedValueOnce(failure);
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    const result = host.closeAndObserve();
    const failed = expect(result).rejects.toBe(failure);
    const closed = expect(host.close()).rejects.toBe(failure);
    await Promise.all([failed, closed]);
    expect(host.closeAndObserve()).toBe(result);
    expect(f.closeAndObserve).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("does not observe through a failed original close", async () => {
    const f = transport();
    const failure = new BridgeError("unknown", "profile_cleanup_unconfirmed");
    f.close.mockRejectedValueOnce(failure);
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    await expect(host.close()).rejects.toBe(failure);
    const result = host.closeAndObserve();
    await expect(result).rejects.toBe(failure);
    expect(host.closeAndObserve()).toBe(result);
    expect(f.closeAndObserve).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("returns forced terminal facts without upgrading them to clean retirement", async () => {
    const f = transport();
    const terminal = Object.freeze({
      exitCode: null,
      signal: "SIGKILL" as const,
      forced: true,
    });
    f.closeAndObserve.mockResolvedValueOnce(terminal);
    start.mockResolvedValue(f.client);
    const host = await startDesktopGoRecovery(recoverySelection());
    expect(await host.closeAndObserve()).toBe(terminal);
    await host.close();
    expect(f.closeAndObserve).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(AttestedCore.prototype.completeRetirement).not.toHaveBeenCalled();
  });
});

it("keeps the archive independent when saved folders lack physical bindings and no publication ACK exists", async () => {
  const f = transport();
  start.mockResolvedValue(f.client);
  const unbound = structuredClone(settings);
  for (const workspace of unbound.computer.workspaces)
    delete workspace.rootIdentity;
  const host = await startDesktopGoRecovery({
    ...recoverySelection(),
    settings: unbound,
  });
  expect(host.folderReadsAvailable).toBe(false);
  f.request.mockImplementationOnce(async (_method, _body, options) => ({
    status: "ok",
    requestId: options!.id!,
    context,
    data: {
      observation: "stored_unconfirmed",
      entries: [],
      next: "",
      unresolved: false,
    },
  }));
  expect(await host.archiveList("")).toEqual({
    observation: "stored_unconfirmed",
    entries: [],
    next: "",
    unresolved: false,
  });
  await expect(
    host.list(unbound.computer.workspaces[0]!.workspaceId, "."),
  ).rejects.toMatchObject({ code: "computer_publication_unavailable" });
  await host.close();
  expect(f.events).toEqual(["computer.authority.deactivate", "client.close"]);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});

it("observes the original recovery pipe loss without a request, replacement or new cleanup", async () => {
  const f = transport();
  start.mockResolvedValue(f.client);
  const host = await startDesktopGoRecovery(recoverySelection());
  expect(host.isAvailable()).toBe(true);
  const calls = f.request.mock.calls.length;
  Object.defineProperty(f.client, "verifiedContext", {
    get: () => {
      throw new BridgeError("unavailable", "backend_unavailable");
    },
  });
  expect(host.isAvailable()).toBe(false);
  expect(host.isAvailable()).toBe(false);
  await expect(host.archiveList("")).rejects.toMatchObject({
    code: "backend_unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(calls);
  expect(start).toHaveBeenCalledTimes(1);
  expect(f.close).not.toHaveBeenCalled();
  await host.close();
  expect(host.isAvailable()).toBe(false);
  expect(f.close).toHaveBeenCalledTimes(1);
});

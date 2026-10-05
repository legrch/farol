import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../apps/desktop/go-core-host";
import type { SettingsStorePending } from "../../apps/desktop/bridge/wire";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";

// Real host composition, serialized pipes, Go process and disposable stores.
// The build declaration is synthetic test input, not package attestation. No
// Electron window, provider or owner profile is exercised. Empty-owner reopen
// uses actual origin retirement and child terminal observation through the host.
function connectSettings(
  host: DesktopGoCore,
  configuration: ProductConfigurationService,
) {
  configuration.attachComputerAuthority(() => host.withdraw());
  host.connectSettingsStore((profileId) => {
    const store = configuration.attachSettingsDeliveryStore({
      profileId,
      ownerId: "owner-desktop",
    });
    return {
      read: (input) => store.read(input.deadlineMillis),
      replace: (input) => store.replace(input.change, input.deadlineMillis),
      fence: () => store.fence(),
    };
  });
}
let root: string;
let artifactRoot: string;
let artifact: unknown;
let cleanupConfirmed = false;
const build: BuildIdentity = {
  schema: 1,
  product: "Farol Next Preview",
  version: "0.0.0",
  bundleId: "local.farol.next.preview",
  updateChannel: "local-preview-only",
  builtAt: "2026-10-04T00:00:00.000Z",
  sourceCommit: "b".repeat(40),
  sourceTreeDigest: "c".repeat(64),
  sourceDirty: false,
  buildId: "a".repeat(64),
};
beforeAll(() => {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("DARWIN_ARM64_HOST_TEST_REQUIRED");
  const parent = path.resolve("_output/tmp");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "go-host-startup-")));
  artifactRoot = path.join(root, "artifact");
  fs.mkdirSync(artifactRoot, { mode: 0o700 });
  const executable = path.join(artifactRoot, "farol-backend");
  execFileSync(
    "go",
    [
      "build",
      "-ldflags",
      `-X github.com/legrch/farol/boot.BuildID=${build.buildId}`,
      "-o",
      executable,
      "./cmd/farol",
    ],
    {
      timeout: 25000,
      env: {
        ...process.env,
        GOTOOLCHAIN: "local",
        GOPROXY: "off",
        GOSUMDB: "off",
        GOAUTH: "off",
      },
    },
  );
  const bytes = fs.readFileSync(executable);
  artifact = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: build.buildId,
      sourceSHA: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: {
      path: "farol-backend",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  fs.writeFileSync(
    path.join(artifactRoot, "core-artifact.json"),
    JSON.stringify(artifact),
  );
}, 30000);
afterAll(() => {
  if (root && cleanupConfirmed) fs.rmSync(root, { recursive: true });
  else if (root)
    console.info(`Unconfirmed startup/cleanup fixture retained: ${root}`);
});

it("starts the normal host with fresh default settings before any workspace is configured", async () => {
  const stateRoot = path.join(root, "state");
  const home = path.join(root, "home");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const configuration = new ProductConfigurationService(
    new ProductSettingsStore({ root: stateRoot }),
    { homeDirectory: home },
  );
  await configuration.initialize();
  const settings = () => {
    const snapshot = configuration.snapshot();
    if (snapshot.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
    return snapshot.settings;
  };
  expect(settings().computer.workspaces).toEqual([]);
  let browserCalls = 0;
  const forbidden = async (): Promise<never> => {
    browserCalls++;
    throw new Error("BROWSER_DISPATCH_FORBIDDEN");
  };
  const driver: BrowserDriver = {
    prepare: forbidden,
    verifySend: forbidden,
    send: forbidden,
    observe: forbidden,
    cancel: forbidden,
    dispose: forbidden,
  };
  const host = await startDesktopGoCore({
    previousHostDrainConfirmed: true,
    compiledArtifact: artifact,
    build,
    artifactRoot,
    stateRoot,
    home,
    settings,
    browser: () => ({ driver, withdraw: () => undefined }),
  });
  try {
    expect(host.chat).toBeDefined();
    await expect(
      host.readForIntent("before-setup", "absent", "note.md"),
    ).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    connectSettings(host, configuration);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, "note.md"), "Configured Go read.\n");
    const stat = fs.lstatSync(workspace, { bigint: true });
    const added = await configuration.addReadonlyWorkspace({
      root: workspace,
      label: "Disposable workspace",
      rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
    });
    expect(added.ok).toBe(true);
    const workspaceId = settings().computer.workspaces[0]!.workspaceId;
    const read = await host.readForIntent(
      "after-setup",
      workspaceId,
      "note.md",
    );
    expect(read.result).toMatchObject({
      status: "ok",
      data: { text: "Configured Go read.\n" },
    });
    expect((await configuration.removeWorkspace(workspaceId)).ok).toBe(true);
    await expect(
      host.readForIntent("after-removal", workspaceId, "note.md"),
    ).rejects.toMatchObject({
      code: "computer_publication_unavailable",
    });
    expect(browserCalls).toBe(0);
  } finally {
    // This read still owns a Chat admission. Cleanup closes the child but must
    // not misreport that unsettled owner as eligible for successor retirement.
    await expect(host.close()).rejects.toMatchObject({
      code: "core_retirement_prepare_unconfirmed",
    });
    cleanupConfirmed = true;
  }
});

it("reopens the exact empty profile across actual graceful child lifetimes", async () => {
  cleanupConfirmed = false;
  const stateRoot = path.join(root, "reopen-state");
  const home = path.join(root, "reopen-home");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  let configuration = new ProductConfigurationService(
    new ProductSettingsStore({ root: stateRoot }),
    { homeDirectory: home },
  );
  await configuration.initialize();
  const settings = () => {
    const value = configuration.snapshot();
    if (value.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
    return value.settings;
  };
  let browserCalls = 0;
  const forbidden = async (): Promise<never> => {
    browserCalls++;
    throw new Error("PROVIDER_FORBIDDEN");
  };
  const driver: BrowserDriver = {
    prepare: forbidden,
    verifySend: forbidden,
    send: forbidden,
    observe: forbidden,
    cancel: forbidden,
    dispose: forbidden,
  };
  let identity: string | undefined;
  let physical: string | undefined;
  const generations = new Set<string>();
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle > 0) {
      configuration = new ProductConfigurationService(
        new ProductSettingsStore({ root: stateRoot }),
        { homeDirectory: home },
      );
      await configuration.initialize();
    }
    const host = await startDesktopGoCore({
      previousHostDrainConfirmed: true,
      compiledArtifact: artifact,
      build,
      artifactRoot,
      stateRoot,
      home,
      settings,
      browser: (context) => {
        expect(generations.has(context.backendGeneration)).toBe(false);
        generations.add(context.backendGeneration);
        identity ??= context.profileId;
        expect(context.profileId).toBe(identity);
        return { driver, withdraw: () => undefined };
      },
    });
    connectSettings(host, configuration);
    const stat = fs.lstatSync(path.join(stateRoot, "go-core"), {
      bigint: true,
    });
    const current = `${stat.dev}:${stat.ino}`;
    physical ??= current;
    expect(current).toBe(physical);
    expect(host.chat).toBeDefined();
    await host.close();
    await host.close(); // cached completion, no second recorder or publication
  }
  expect(generations.size).toBe(3);
  expect(browserCalls).toBe(0);
  cleanupConfirmed = true;
});

it("cleans a post-connect startup abort without publishing a retirement", async () => {
  cleanupConfirmed = false;
  const stateRoot = path.join(root, "aborted-state");
  const home = path.join(root, "aborted-home");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const configuration = new ProductConfigurationService(
    new ProductSettingsStore({ root: stateRoot }),
    { homeDirectory: home },
  );
  await configuration.initialize();
  const settings = () => {
    const value = configuration.snapshot();
    if (value.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
    return value.settings;
  };
  const forbidden = async (): Promise<never> => {
    throw new Error("PROVIDER_FORBIDDEN");
  };
  const driver: BrowserDriver = {
    prepare: forbidden,
    verifySend: forbidden,
    send: forbidden,
    observe: forbidden,
    cancel: forbidden,
    dispose: forbidden,
  };
  const selected = {
    previousHostDrainConfirmed: true,
    compiledArtifact: artifact,
    build,
    artifactRoot,
    stateRoot,
    home,
    settings,
    browser: () => ({ driver, withdraw: () => undefined }),
  };
  const host = await startDesktopGoCore(selected);
  expect(host.chat).toBeDefined();
  await host.abortStartup();
  await host.close();
  const chatRoot = path.join(stateRoot, "go-core", "chat");
  const before = fs.readdirSync(chatRoot).sort();
  expect(before.filter((name) => /^chat-handoff-/.test(name))).toEqual([]);
  // The later normal host has no independent prior-drain witness. It refuses
  // before creating a child, without trying to revive the retained claim.
  await expect(
    startDesktopGoCore({ ...selected, previousHostDrainConfirmed: false }),
  ).rejects.toMatchObject({ code: "previous_host_drain_unconfirmed" });
  expect(fs.readdirSync(chatRoot).sort()).toEqual(before);
  cleanupConfirmed = true;
});

it("saves Go pending before one native edit and reopens to exact Go result ACK", async () => {
  cleanupConfirmed = false;
  const stateRoot = path.join(root, "delivery-state"),
    home = path.join(root, "delivery-home"),
    workspace = path.join(root, "delivery-workspace");
  for (const directory of [stateRoot, home, workspace])
    fs.mkdirSync(directory, { mode: 0o700 });
  const target = path.join(workspace, "note.md");
  fs.writeFileSync(target, "one old fragment\n", { mode: 0o600 });
  const original = fs.readFileSync(target),
    beforeHash = createHash("sha256").update(original).digest("hex");
  let configuration = new ProductConfigurationService(
    new ProductSettingsStore({ root: stateRoot }),
    { homeDirectory: home },
  );
  await configuration.initialize();
  const settings = () => {
    const v = configuration.snapshot();
    if (v.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
    return v.settings;
  };
  const stat = fs.lstatSync(workspace, { bigint: true });
  expect(
    (
      await configuration.addReadonlyWorkspace({
        root: workspace,
        label: "Disposable edit",
        rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
      })
    ).ok,
  ).toBe(true);
  const workspaceId = settings().computer.workspaces[0]!.workspaceId;
  expect(
    (await configuration.updateWorkspaceAccess(workspaceId, "write")).ok,
  ).toBe(true);
  let providerCalls = 0;
  const forbidden = async (): Promise<never> => {
    providerCalls++;
    throw new Error("PROVIDER_FORBIDDEN");
  };
  const driver: BrowserDriver = {
    prepare: forbidden,
    verifySend: forbidden,
    send: forbidden,
    observe: forbidden,
    cancel: forbidden,
    dispose: forbidden,
  };
  const selected = {
    previousHostDrainConfirmed: true,
    compiledArtifact: artifact,
    build,
    artifactRoot,
    stateRoot,
    home,
    settings,
    browser: () => ({ driver, withdraw: () => undefined }),
  };
  const host = await startDesktopGoCore(selected);
  connectSettings(host, configuration);
  const operationId = randomUUID(),
    generation = settings().computer.generation;
  const { offered, journal, entries, saved } = await (async () => {
    try {
      const offered = await host.editSettingsWorkspace(
        operationId,
        generation,
        workspaceId,
        "note.md",
        beforeHash,
        "old",
        "new",
      );
      expect(offered.state).toBe("offered");
      expect(offered.result?.phase).toBe("completed");
      expect(offered.retention).toBe("durable");
      expect(settings().computer.pendingEdit).toMatchObject({
        operationId,
        profileId: host.settingsMutationProfile(),
        computerGeneration: generation,
        beforeSha256: beforeHash,
      });
      expect(fs.readFileSync(target, "utf8")).toBe("one new fragment\n");
      const journal = path.join(stateRoot, "go-core", "computer", "mutations");
      const entries = fs.readdirSync(journal);
      expect(entries).toHaveLength(1);
      const saved = fs.readFileSync(path.join(journal, entries[0]!));
      await expect(
        host.editSettingsWorkspace(
          operationId,
          generation,
          workspaceId,
          "note.md",
          beforeHash,
          "old",
          "new",
        ),
      ).rejects.toBeDefined();
      return { offered, journal, entries, saved };
    } finally {
      await host.close(); // Known durable effect may retain unacknowledged delivery.
    }
  })();
  configuration = new ProductConfigurationService(
    new ProductSettingsStore({ root: stateRoot }),
    { homeDirectory: home },
  );
  await configuration.initialize();
  const next = await startDesktopGoCore(selected);
  connectSettings(next, configuration);
  try {
    const observed = await next.observeSettingsMutation(
      offered.pending as SettingsStorePending,
    );
    expect(observed.pending).toEqual(offered.pending);
    expect(observed.result).toEqual(offered.result);
    expect(observed.receiptId).not.toBe(offered.receiptId);
    const revision = settings().revision;
    expect(
      (await next.acknowledgeSettingsMutation(operationId)).acknowledged,
    ).toBe(true);
    expect(settings().computer.pendingEdit).toBeNull();
    expect(settings().revision).toBe(revision + 1);
    expect(fs.readdirSync(journal)).toEqual(entries);
    expect(fs.readFileSync(path.join(journal, entries[0]!))).toEqual(saved);
    expect(fs.readFileSync(target, "utf8")).toBe("one new fragment\n");
    expect(providerCalls).toBe(0);
  } finally {
    await next.close();
  }
  cleanupConfirmed = true;
}, 25000);

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startDesktopGoCore } from "../../apps/desktop/go-core-host";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";

// Real host composition, serialized pipes, Go process and disposable stores.
// The build declaration is synthetic test input, not package attestation. No
// Electron window, provider, owner profile, or successor recovery is exercised.
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
    configuration.attachComputerAuthority(() => host.withdraw());
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
    await host.close();
    cleanupConfirmed = true;
  }
});

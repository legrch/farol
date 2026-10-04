/** Controlled offline DOM join of production constructors. No normal main/UI
 * entry, installed product, selector qualification or live-provider claim. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { configPath } from "./fixtures/go-chat-normal-config.ts";
import { app, BrowserWindow, session } from "electron";
import { ChatGptRoute } from "../../src/apps/desktop/chatgpt-route.ts";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract.ts";
import { BuildIdentitySchema } from "../../src/pkg/build-info/identity.ts";
import { createDesktopChatBrowser } from "../../apps/desktop/go-chat-host.ts";
import { GoChatBrowserDriver } from "../../apps/desktop/go-chat-browser.ts";
import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../apps/desktop/go-core-host.ts";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type { ChatCreate, ChatHandle } from "../../apps/desktop/bridge/wire.ts";

// Independently pinned producer declarations are compiled by the harness runner
// only after the existing clean-source/build/input/core attestation gates pass.
declare const __FAROL_NORMAL_CORE__: unknown;
declare const __FAROL_NORMAL_BUILD__: unknown;
type Config = {
  paths: Record<string, string>;
  stateRoot: string;
  workspaceRoot: string | null;
  artifactRoot: string;
  receipt: string;
  origin: string;
  homeUrl: string;
};
type Command =
  | { kind: "start" }
  | { kind: "create"; prompt: string; previousHandle?: string }
  | { kind: "prepare" }
  | { kind: "send" | "observe" | "result"; handleId: string }
  | { kind: "events"; handleId: string; afterSequence: string }
  | { kind: "frame-ack"; handleId: string; sequence: string }
  | { kind: "result-ack"; handleId: string; resultId: string }
  | {
      kind: "computer-read" | "computer-excluded-read" | "computer-revoke-read";
    }
  | { kind: "snapshot" }
  | { kind: "close" };
const config = JSON.parse(
  fs.readFileSync(configPath(process.argv), "utf8"),
) as Config;
const origin = new URL(config.origin);
assert.equal(origin.protocol, "http:");
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.origin, config.origin);
assert.equal(config.homeUrl, `${config.origin}/chatgpt`);
const settingsFile = path.join(config.stateRoot, "settings.json");
const partition = "persist:farol-dev-chatgpt" as const;
const routes: ChatGptRoute[] = [];
let host: DesktopGoCore | undefined;
let startAttempted = false;
let closeAttempted = false;
const computerAttempts = new Set<string>();
let computerRead:
  Awaited<ReturnType<DesktopGoCore["readForIntent"]>> | undefined;
let violation: string | null = null;
const receipt = {
  classification: "controlled-offline-production-composition",
  pid: process.pid,
  windows: [] as {
    kind: string;
    id: number;
    visible?: boolean;
    focused?: boolean;
  }[],
  observations: [] as { operationId: string; kind: string; sequence: string }[],
  blockedRequests: 0,
  commandFailures: [] as { kind: string; code: string }[],
  createdRoutes: 0,
  cleanup: { hostCloseResolved: false, windowsDestroyed: false },
  error: null as string | null,
};
function save() {
  fs.writeFileSync(`${config.receipt}.tmp`, JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(`${config.receipt}.tmp`, config.receipt);
}
function fail(code: string) {
  violation ??= code;
  receipt.error ??= code;
  save();
}
app.setName("Farol Controlled Go Chat DOM Join");
for (const [name, directory] of Object.entries(config.paths))
  app.setPath(name, directory);
app.setAppLogsPath(config.paths.logs!);
app.setActivationPolicy("prohibited");
for (const flag of [
  "disable-background-networking",
  "disable-component-update",
  "disable-sync",
  "no-proxy-server",
])
  app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
);
app.on("browser-window-created", (_event, window) => {
  receipt.windows.push({
    kind: "created",
    id: window.id,
    visible: window.isVisible(),
    focused: window.isFocused(),
  });
  if (window.isVisible() || window.isFocused())
    fail("WINDOW_CREATED_VISIBLE_OR_FOCUSED");
  const forbidden = (kind: "show" | "focus") => () => {
    receipt.windows.push({ kind, id: window.id });
    window.hide();
    fail(`WINDOW_${kind.toUpperCase()}_FORBIDDEN`);
  };
  window.on("show", forbidden("show"));
  window.on("focus", forbidden("focus"));
});
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => {
    fail("POPUP_FORBIDDEN");
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    fail("WEBVIEW_FORBIDDEN");
  });
  contents.on("will-navigate", (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      fail("NAVIGATION_FORBIDDEN");
    }
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      fail("REDIRECT_FORBIDDEN");
    }
  });
});
function allowed(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    return new URL(value).origin === config.origin;
  } catch {
    return false;
  }
}
function hidden() {
  assert.equal(violation, null, violation ?? "NATIVE_ISOLATION_VIOLATION");
  assert.equal(app.isHidden(), true);
  assert.equal(app.dock?.isVisible() ?? false, false);
  const windows = BrowserWindow.getAllWindows();
  assert.ok(
    windows.every((window) => !window.isVisible() && !window.isFocused()),
  );
  for (const window of windows) {
    // Runtime Electron exposes this introspection method; its declarations
    // omit it. Require the real method, never fabricate preference evidence.
    const contents = window.webContents as typeof window.webContents & {
      getLastWebPreferences(): Electron.WebPreferences;
    };
    assert.equal(typeof contents.getLastWebPreferences, "function");
    const prefs = contents.getLastWebPreferences();
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.nodeIntegration, false);
  }
  return {
    routeCount: routes.length,
    windows: windows.map((window) => ({
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  };
}
function settings() {
  const workspaces = [];
  if (config.workspaceRoot !== null) {
    assert.equal(
      config.workspaceRoot,
      path.join(path.dirname(config.stateRoot), "approved-workspace"),
    );
    assert.equal(fs.realpathSync(config.workspaceRoot), config.workspaceRoot);
    const stat = fs.lstatSync(config.workspaceRoot, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    workspaces.push({
      workspaceId: "controlled-workspace",
      root: config.workspaceRoot,
      label: "Disposable controlled workspace",
      access: "read",
      excludedPaths: [path.join(config.workspaceRoot, "excluded.md")],
      rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
    });
  }
  const readiness = {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: randomUUID(),
      generation: 1,
      name: "Controlled offline fixture",
      commands: "none",
      workspaces,
    },
    setup: {
      chatgpt: readiness,
      computer: readiness,
      connect: readiness,
      hosts: readiness,
      verify: readiness,
    },
  });
}
function currentSettings() {
  return ProductSettingsSchema.parse(
    JSON.parse(fs.readFileSync(settingsFile, "utf8")),
  );
}
// Explicit synthetic catalogue, never inferred from requested labels or promoted
// to production qualification. Account/config/grant pins are declarations.
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "controlled-account",
  modelId: "controlled-model",
  effort: "low",
  // This controlled page has no independent mode control. Do not claim one.
  mode: "",
  connectorId: "",
  connectorGrantId: "",
  toolsEnabled: false,
};
const translationId = "controlled-fixture-v1";
const catalogue = {
  model: [{ value: "controlled-model", literal: "Test model" }],
  effort: [{ value: "low", literal: "Light" }],
  mode: [],
  connector: [],
};
const configSHA256 = createHash("sha256")
  .update(JSON.stringify(catalogue))
  .digest("hex");
const deadline = () => String(Date.now() + 12_000);
async function close() {
  if (closeAttempted) return receipt.cleanup;
  closeAttempted = true;
  try {
    if (host) {
      // DesktopGoCore closes its original Client. Client.close waits for the
      // exact owned backend child terminal and profile release, or rejects.
      await host.close();
      receipt.cleanup.hostCloseResolved = true;
    }
  } finally {
    for (const route of routes) route.dispose();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    receipt.cleanup.windowsDestroyed =
      BrowserWindow.getAllWindows().length === 0;
    save();
  }
  return receipt.cleanup;
}
async function dispatch(command: Command): Promise<unknown> {
  if (command.kind === "close") return close();
  if (command.kind === "start") {
    assert.equal(startAttempted, false, "START_ALREADY_CONSUMED");
    startAttempted = true;
    await app.whenReady();
    app.dock?.hide();
    app.hide();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    for (const selected of [
      session.defaultSession,
      session.fromPartition(partition),
    ]) {
      selected.webRequest.onBeforeRequest((details, callback) => {
        const permitted = allowed(details.url);
        if (!permitted) {
          receipt.blockedRequests += 1;
          save();
        }
        callback({ cancel: !permitted });
      });
      selected.setPermissionCheckHandler(() => false);
      selected.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      selected.on("will-download", (event) => event.preventDefault());
    }
    const document = settings();
    fs.writeFileSync(settingsFile, JSON.stringify(document), {
      flag: "wx",
      mode: 0o600,
    });
    host = await startDesktopGoCore({
      previousHostDrainConfirmed: true,
      compiledArtifact: __FAROL_NORMAL_CORE__,
      build: BuildIdentitySchema.parse(__FAROL_NORMAL_BUILD__),
      artifactRoot: config.artifactRoot,
      stateRoot: config.stateRoot,
      home: config.paths.home!,
      settings: currentSettings,
      browser: (context) =>
        createDesktopChatBrowser({
          context,
          partition,
          create: async () => {
            // Lazy creation only at a real Go prepare command, never start/create.
            const route = new ChatGptRoute({
              homeUrl: config.homeUrl,
              initialUrl: config.homeUrl,
              e2eOrigin: config.origin,
              parent: () => null,
              partition,
              title: "Controlled offline Go Chat",
              windowPresentation: { mode: "hidden" },
              publicOutputProfile: "message-anchors-v1",
              physicalContentProfile: "farol-controlled-settled-segments-v1",
            });
            routes.push(route);
            receipt.createdRoutes += 1;
            save();
            assert.equal((await route.open()).status, "opened");
            hidden();
            return route.chatPhysical();
          },
          driver: (lookup) => {
            // The driver must support an explicitly selected trusted loopback
            // e2eOrigin. An HTTPS-only driver refuses this join; no URL remapping,
            // physical binding rewriting or mock BrowserDriver is permitted.
            const dependencies = {
              lookup,
              translations: [
                {
                  version: "public-controls-v1" as const,
                  configSHA256,
                  translationId,
                  ...catalogue,
                },
              ],
              e2eOrigin: config.origin,
            };
            const physical = new GoChatBrowserDriver(dependencies);
            const observer: BrowserDriver = {
              prepare: (input) => physical.prepare(input),
              verifySend: (input) => physical.verifySend(input),
              send: (input) => physical.send(input),
              cancel: (input) => physical.cancel(input),
              dispose: (input) => physical.dispose(input),
              observe: async (input) => {
                const result = await physical.observe(input);
                for (const event of result.events)
                  receipt.observations.push({
                    operationId: event.binding.lease.identity.operationId,
                    kind: event.kind,
                    sequence: event.sequence,
                  });
                save();
                return result;
              },
            };
            return observer;
          },
        }),
    });
    assert.equal(routes.length, 0, "ROUTES_MUST_BE_LAZY");
    hidden();
    save();
    return { started: true, routes: 0 };
  }
  assert.ok(host, "HOST_NOT_STARTED");
  hidden();
  switch (command.kind) {
    case "computer-read": {
      assert.ok(config.workspaceRoot, "CONTROLLED_WORKSPACE_REQUIRED");
      assert.equal(computerAttempts.has(command.kind), false, "NO_READ_REPLAY");
      computerAttempts.add(command.kind);
      computerRead = await host.readForIntent(
        randomUUID(),
        "controlled-workspace",
        "note.md",
      );
      return computerRead;
    }
    case "computer-excluded-read":
    case "computer-revoke-read": {
      assert.ok(computerRead?.result.status === "ok", "KNOWN_READ_REQUIRED");
      assert.equal(computerAttempts.has(command.kind), false, "NO_READ_REPLAY");
      computerAttempts.add(command.kind);
      if (command.kind === "computer-revoke-read") {
        // Withdraw before saving narrowed disposable settings, then publish
        // their exact readback. The next public readForIntent republishes and
        // admits a NEW intent; this does not probe the prior admission's fence.
        const publication = await host.withdraw();
        const before = currentSettings();
        assert.equal(before.computer.workspaces.length, 1);
        assert.equal(before.computer.workspaces[0]?.root, config.workspaceRoot);
        const after = ProductSettingsSchema.parse({
          ...before,
          revision: before.revision + 1,
          computer: {
            ...before.computer,
            generation: before.computer.generation + 1,
            workspaces: before.computer.workspaces.map((workspace) => ({
              ...workspace,
              excludedPaths: [
                ...workspace.excludedPaths,
                path.join(workspace.root, "note.md"),
              ],
            })),
          },
        });
        fs.writeFileSync(`${settingsFile}.revoked`, JSON.stringify(after), {
          flag: "wx",
          mode: 0o600,
        });
        fs.renameSync(`${settingsFile}.revoked`, settingsFile);
        const saved = currentSettings();
        assert.deepEqual(saved, after);
        await publication.publish(saved);
      }
      const document = currentSettings();
      const read = await host.readForIntent(
        randomUUID(),
        "controlled-workspace",
        command.kind === "computer-excluded-read" ? "excluded.md" : "note.md",
      );
      return {
        ...read,
        settingsRevision: document.revision,
        computerGeneration: document.computer.generation,
      };
    }
    case "create": {
      const input: ChatCreate = {
        sessionId: "controlled-session",
        prompt: command.prompt,
        selection,
        resolution: {
          requestedAlias: "chatgpt",
          requestedExecutor: "browser",
          requestedEffort: "low",
          requestedMode: "",
          configSHA256,
          translationId,
          resolved: selection,
        },
        required: { model: true, effort: true, mode: false, connector: false },
        ...(command.previousHandle
          ? { previousHandle: command.previousHandle }
          : {}),
      };
      const handle: ChatHandle = await host.chat.create(input);
      return handle;
    }
    case "prepare":
      return host.chat.prepare(deadline());
    case "send":
      return host.chat.send(command.handleId, deadline());
    case "observe":
      return host.chat.observe(command.handleId, deadline());
    case "result":
      return host.chat.result(command.handleId);
    case "events":
      return host.chat.events(command.handleId, command.afterSequence);
    case "frame-ack":
      return host.chat.acknowledgeFrame(command.handleId, command.sequence);
    case "result-ack":
      return host.chat.acknowledgeResult(command.handleId, command.resultId);
    case "snapshot":
      return { ...hidden(), observations: receipt.observations };
  }
}
// A bounded test-only command facade, not a new production ingress or executor.
(
  globalThis as unknown as {
    goChatNormal: (command: Command) => Promise<unknown>;
  }
).goChatNormal = async (command) => {
  try {
    return await dispatch(command);
  } catch (error) {
    const code = error instanceof Error ? error.message : "HARNESS_FAILURE";
    receipt.commandFailures.push({ kind: command.kind, code });
    save();
    // Content-free error transport; expected lost-ACK failures remain explicit.
    return {
      harnessError: code,
      state: error instanceof BridgeError ? error.state : "harness-failure",
    };
  }
};
const watchdog = setTimeout(() => {
  fail("NATIVE_WATCHDOG_EXPIRED");
  // Do not exit while a Go child may still own the profile. Parent observes
  // cleanup unknown and retains all evidence instead of inferring retirement.
  void close().catch(() => fail("BACKEND_CLEANUP_UNCONFIRMED"));
}, 90_000);
watchdog.unref();
app.on("before-quit", () => clearTimeout(watchdog));
process.on("uncaughtException", () => fail("UNCAUGHT_EXCEPTION"));
process.on("unhandledRejection", () => fail("UNHANDLED_REJECTION"));
save();

import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import type {
  ProductConfigurationCommand,
  ProductConfigurationSnapshot,
} from "../../src/pkg/product-settings/contract";
import type { PreloadApi } from "../../src/ui/renderer/contract";
// Synchronous Node SHA computation behind the async Web Crypto contract.
// The production native test exercises Chromium's actual crypto.subtle.
vi.stubGlobal("crypto", {
  randomUUID,
  subtle: {
    digest: async (_algorithm: string, bytes: Uint8Array) =>
      new Uint8Array(createHash("sha256").update(bytes).digest()).buffer,
  },
});
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
export function settings(revision = 1) {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      name: "This Mac",
      workspaces: [],
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
export function bootstrap() {
  return {
    schema: 3,
    environment: "preview",
    build: {
      schema: 1,
      product: "Farol Next Preview",
      version: "0.1.8-owner.beta.1",
      bundleId: "local.farol.next.preview",
      updateChannel: "github-owner-beta",
      buildVersion: "10",
      builtAt: "2026-10-02T20:00:00.000Z",
      sourceCommit: "1".repeat(40),
      sourceTreeDigest: "2".repeat(64),
      sourceDirty: false,
      buildId: "3".repeat(64),
    },
    configuration: { status: "ready", settings: settings() },
    runtimeState: "ready",
    taskRevision: 0,
    tasks: [],
    windowState: {
      focused: false,
      fullScreen: false,
      trafficLightPosition: null,
    },
  };
}
export function task(id = "task-1") {
  return {
    taskId: id,
    sessionId: id,
    turnId: id,
    label: "Task 1",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// Content-free scripted response. It does not inspect a browser/account.
export function signInReply(
  command: Extract<
    ProductConfigurationCommand,
    { kind: "chatgpt.observe-sign-in" }
  >,
  state: "authenticated" | "signed_out" | "unknown" = "unknown",
  snapshot: ProductConfigurationSnapshot = {
    status: "ready",
    settings: settings(),
  },
) {
  return {
    ok: true,
    snapshot,
    evidence: {
      kind: "chatgpt.sign-in-status",
      observationId: command.observationId,
      buildId: command.buildId,
      state,
      binding:
        state === "unknown" ? null : { documentGeneration: 0, sequence: 1 },
    },
  };
}
export function fixture() {
  const listeners = new Map<string, (value: unknown) => void>();
  const disposers: (() => void)[] = [];
  const subscription =
    (name: string) => (listener: (value: unknown) => void) => {
      listeners.set(name, listener);
      const dispose = vi.fn(() => listeners.delete(name));
      disposers.push(dispose);
      return dispose;
    };
  const api: PreloadApi = {
    bootstrap: vi.fn(async () => bootstrap()),
    snapshot: vi.fn(async () => ({})),
    configure: vi.fn(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command)
        : { ok: true, snapshot: bootstrap().configuration },
    ),
    task: vi.fn(async () => ({
      ok: true,
      state: { revision: 0, tasks: [] },
      selectedTaskId: null,
    })),
    installedUpdate: vi.fn(async () => ({ phase: "idle", checkedAt: null })),
    setNavigationShortcuts: vi.fn(async () => ({ ok: true })),
    layout: vi.fn(),
    onConfigurationChanged: subscription("configuration"),
    onTasksState: subscription("tasks"),
    onRuntimeEvent: subscription("event"),
    onRuntimeState: subscription("runtime"),
    onInstalledUpdateState: subscription("update"),
    onBrowserRouteState: subscription("route"),
    onTaskSurfaceState: subscription("surface"),
    onLayout: subscription("layout"),
    onShellAction: subscription("action"),
    onWindowState: subscription("window"),
  };
  return {
    api,
    listeners,
    disposers,
    emit: (name: string, value: unknown) => listeners.get(name)?.(value),
  };
}

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FarolModelLifecycleStatus } from "../../../src/apps/desktop/farol-model-lifecycle";
import { createModelHost, type ModelHostPorts } from "./model";

// The model route readers and the Codex host path helpers over scripted
// owners. Main's `let`s are fields the ports read afresh; the dialog, the
// process-table detector and the child-home resolver are fakes that record what
// they were given, and the host directories are real private temporary
// directories so the mode, symlink and ownership checks run on a real file
// system. No window, dialog, Codex process or endpoint runs.

function fake<T>(value: unknown): T {
  return value as T;
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function privateTemp(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "model-host-")),
  );
  roots.push(root);
  return root;
}

type Build = Readonly<{
  env?: Record<string, string | undefined>;
  window?: BrowserWindow | null;
  save?: (...args: unknown[]) => Promise<unknown>;
  configuration?: unknown;
  lifecycle?: unknown;
  runtimeRoot?: string;
  environment?: ModelHostPorts["buildEnvironment"];
  codexHome?: string;
  enabled?: boolean;
  childHomes?: {
    codexHomePath: string | undefined;
    processHomePath: string;
  };
  presence?: () => Promise<unknown>;
}>;

function build(options: Build = {}) {
  const calls: string[] = [];
  const env = options.env ?? {};
  const save = vi.fn(
    options.save ?? (async () => ({ canceled: true, filePath: undefined })),
  );
  const getPath = vi.fn((name: string) => `/native/${name}`);
  const homedir = vi.fn(() => "/native/os-home");
  const configPath = vi.fn(
    (environment: string, _identity: unknown, home: string) =>
      `${environment}|${home}|config.toml`,
  );
  const childHomes = vi.fn(
    (
      _environment: string,
      _identity: unknown,
      _home: string,
      _configured: string | undefined,
    ) =>
      options.childHomes ?? {
        codexHomePath: undefined,
        processHomePath: "/unused",
      },
  );
  const detect = vi.fn(
    options.presence ?? (async () => ({ state: "not_running" })),
  );
  const state = {
    window: options.window ?? null,
    configuration: options.configuration ?? null,
    lifecycle: options.lifecycle ?? null,
  };
  const identity = fake<ModelHostPorts["activeDesktopIdentity"]>({
    codexHome: options.codexHome ?? "/unused/codex-home",
    userData: "/unused/user-data",
  });
  const ports: ModelHostPorts = {
    env,
    app: fake({ getPath }),
    dialog: fake({ showSaveDialog: save }),
    os: { homedir },
    window: () => fake<BrowserWindow | null>(state.window),
    configuration: () => fake(state.configuration),
    modelLifecycle: () => fake(state.lifecycle),
    statePaths: () => ({
      codexHostRuntime: options.runtimeRoot ?? "/unused/runtime",
    }),
    buildIdentity: { version: "9.8.7" },
    buildEnvironment: options.environment ?? "dev",
    activeDesktopIdentity: identity,
    FAROL_MODEL_ENABLED: options.enabled ?? true,
    FAROL_PROVIDER_ID: "farol-test-provider",
    ROUTE_B_MODEL: "route-b-test-model",
    desktopCodexConfigPath: fake(configPath),
    desktopCodexChildHomes: fake(childHomes),
    detectCodexHostPresence: fake(detect),
  };
  return {
    host: createModelHost(ports),
    state,
    save,
    getPath,
    homedir,
    configPath,
    childHomes,
    detect,
    identity,
    calls,
  };
}

describe("selectedSupportExportTarget", () => {
  it("returns the E2E target without a dialog when it is absolute", async () => {
    const run = build({
      env: { FAROL_E2E: "1", FAROL_E2E_SUPPORT_EXPORT: "/tmp/support.json" },
    });
    await expect(run.host.selectedSupportExportTarget()).resolves.toBe(
      "/tmp/support.json",
    );
    expect(run.save).not.toHaveBeenCalled();
    expect(run.getPath).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["relative", "support.json"],
    ["NUL-bearing", "/tmp/support\0.json"],
  ])("refuses a %s E2E target before any dialog", async (_label, target) => {
    const run = build({
      env: { FAROL_E2E: "1", FAROL_E2E_SUPPORT_EXPORT: target },
    });
    await expect(run.host.selectedSupportExportTarget()).rejects.toThrow(
      new Error("SUPPORT_EXPORT_E2E_TARGET_INVALID"),
    );
    expect(run.save).not.toHaveBeenCalled();
  });

  it("ignores the E2E target outside E2E and shows the dialog", async () => {
    const run = build({
      env: { FAROL_E2E_SUPPORT_EXPORT: "/tmp/support.json" },
      save: async () => ({ canceled: false, filePath: "/chosen/report.json" }),
    });
    await expect(run.host.selectedSupportExportTarget()).resolves.toBe(
      "/chosen/report.json",
    );
    expect(run.save).toHaveBeenCalledTimes(1);
  });

  it("builds the options from the documents folder and the build version, without a window", async () => {
    const run = build({
      save: async () => ({ canceled: false, filePath: "/chosen/x.json" }),
    });
    await run.host.selectedSupportExportTarget();
    expect(run.getPath).toHaveBeenCalledWith("documents");
    expect(run.save).toHaveBeenCalledWith({
      title: "Export content-free Farol support report",
      defaultPath: "/native/documents/Farol-Support-9.8.7.json",
      buttonLabel: "Export Support Report",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
  });

  it("parents the dialog to the window read at call time", async () => {
    const owner = fake<BrowserWindow>({ id: 1 });
    const run = build({
      save: async () => ({ canceled: false, filePath: "/chosen/x.json" }),
    });
    run.state.window = owner;
    await run.host.selectedSupportExportTarget();
    const [first, second] = run.save.mock.calls[0] ?? [];
    expect(first).toBe(owner);
    expect(second).toMatchObject({ buttonLabel: "Export Support Report" });
  });

  it.each([
    ["canceled", { canceled: true, filePath: "/chosen/x.json" }],
    ["without a path", { canceled: false, filePath: undefined }],
    ["with an empty path", { canceled: false, filePath: "" }],
  ])("returns null when the dialog is %s", async (_label, answer) => {
    const run = build({ save: async () => answer });
    await expect(run.host.selectedSupportExportTarget()).resolves.toBeNull();
  });
});

describe("farolModelCodexConfigPath", () => {
  it("uses the absolute E2E override only under E2E", () => {
    const run = build({
      env: {
        FAROL_E2E: "1",
        FAROL_MODEL_E2E_CODEX_CONFIG_PATH: "/e2e/config.toml",
      },
    });
    expect(run.host.farolModelCodexConfigPath()).toBe("/e2e/config.toml");
    expect(run.configPath).not.toHaveBeenCalled();
  });

  it.each([
    ["outside E2E", { FAROL_MODEL_E2E_CODEX_CONFIG_PATH: "/e2e/config.toml" }],
    [
      "relative",
      { FAROL_E2E: "1", FAROL_MODEL_E2E_CODEX_CONFIG_PATH: "config.toml" },
    ],
    [
      "NUL-bearing",
      { FAROL_E2E: "1", FAROL_MODEL_E2E_CODEX_CONFIG_PATH: "/e2e/c\0.toml" },
    ],
    ["empty", { FAROL_E2E: "1", FAROL_MODEL_E2E_CODEX_CONFIG_PATH: "" }],
    ["absent", { FAROL_E2E: "1" }],
  ])("falls back to the desktop path when the override is %s", (_l, env) => {
    const run = build({ env, environment: "dev" });
    expect(run.host.farolModelCodexConfigPath()).toBe(
      "dev|/native/os-home|config.toml",
    );
    expect(run.configPath).toHaveBeenCalledWith(
      "dev",
      run.identity,
      "/native/os-home",
    );
  });

  it("hands the build environment and the OS home, not the Electron home, to the resolver", () => {
    const run = build({ environment: "preview" });
    expect(run.host.farolModelCodexConfigPath()).toBe(
      "preview|/native/os-home|config.toml",
    );
    expect(run.homedir).toHaveBeenCalledTimes(1);
    expect(run.getPath).not.toHaveBeenCalled();
  });
});

describe("syntheticModelTurnHandler", () => {
  it("answers every request with one completed Responses turn carrying the text", async () => {
    const run = build();
    const handler = run.host.syntheticModelTurnHandler("hello e2e");
    const answer = await handler(fake({}));
    expect(answer).toEqual({
      ok: true,
      events: [
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_e2e",
              object: "response",
              status: "completed",
              output: [
                {
                  id: "msg_e2e",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "hello e2e", annotations: [] },
                  ],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        },
      ],
    });
  });

  it("reads no environment itself: the double gate belongs to the caller", async () => {
    const run = build({ env: {} });
    const handler = run.host.syntheticModelTurnHandler("x");
    await expect(handler(fake({}))).resolves.toMatchObject({ ok: true });
    expect(run.getPath).not.toHaveBeenCalled();
  });
});

describe("farolModelProviderSpec", () => {
  const listening: FarolModelLifecycleStatus = {
    state: "listening",
    port: 4711,
    requestsServed: 0,
    lastAcceptedAtIso: undefined,
  };

  function lifecycle(
    status: FarolModelLifecycleStatus,
    token: string | undefined,
  ) {
    const currentToken = vi.fn(async () => token);
    return {
      currentToken,
      endpoint: { status: () => status, runtimeState: { currentToken } },
    };
  }

  it("is null while the model route is disabled, without touching the endpoint", async () => {
    const owner = lifecycle(listening, "tok");
    const run = build({ enabled: false, lifecycle: owner.endpoint });
    await expect(run.host.farolModelProviderSpec()).resolves.toBeNull();
    expect(owner.currentToken).not.toHaveBeenCalled();
  });

  it("is null when no endpoint exists yet", async () => {
    const run = build({ lifecycle: null });
    await expect(run.host.farolModelProviderSpec()).resolves.toBeNull();
  });

  it.each([
    ["not_running", { state: "not_running" }],
    [
      "port_conflict",
      { state: "port_conflict", port: 4711, occupant: "foreign" },
    ],
    ["sealed", { state: "sealed", port: 4711 }],
  ] as const)(
    "is null for a %s endpoint and never reads the token",
    async (_label, status) => {
      const owner = lifecycle(status, "tok");
      const run = build({ lifecycle: owner.endpoint });
      await expect(run.host.farolModelProviderSpec()).resolves.toBeNull();
      expect(owner.currentToken).not.toHaveBeenCalled();
    },
  );

  it("is null when the endpoint has no token", async () => {
    const owner = lifecycle(listening, undefined);
    const run = build({ lifecycle: owner.endpoint });
    await expect(run.host.farolModelProviderSpec()).resolves.toBeNull();
    expect(owner.currentToken).toHaveBeenCalledTimes(1);
  });

  it.each(["listening", "connected"] as const)(
    "builds the literal-token spec for a %s endpoint",
    async (state) => {
      const owner = lifecycle(
        { state, port: 4711, requestsServed: 2, lastAcceptedAtIso: undefined },
        "secret-token",
      );
      const run = build({ lifecycle: owner.endpoint });
      await expect(run.host.farolModelProviderSpec()).resolves.toEqual({
        providerName: "farol-test-provider",
        displayName: "Farol",
        baseUrl: "http://127.0.0.1:4711",
        model: "route-b-test-model",
        wireApi: "responses",
        delivery: { mode: "bearer-token", token: "secret-token" },
      });
    },
  );

  it("reads the endpoint at call time, not at creation", async () => {
    const run = build();
    await expect(run.host.farolModelProviderSpec()).resolves.toBeNull();
    run.state.lifecycle = lifecycle(listening, "later").endpoint;
    await expect(run.host.farolModelProviderSpec()).resolves.toMatchObject({
      delivery: { mode: "bearer-token", token: "later" },
    });
  });
});

describe("farolModelCodexHostPresence", () => {
  const ready = (executablePath: string | undefined) => ({
    snapshot: () => ({
      status: "ready",
      settings: {
        nativeHosts: {
          codex: executablePath === undefined ? undefined : { executablePath },
        },
      },
    }),
  });

  it.each(["dev", "owner-preview"] as const)(
    "reports not_running for %s without reading settings or the process table",
    async (environment) => {
      const snapshot = vi.fn();
      const run = build({ environment, configuration: { snapshot } });
      await expect(run.host.farolModelCodexHostPresence()).resolves.toBe(
        "not_running",
      );
      expect(snapshot).not.toHaveBeenCalled();
      expect(run.detect).not.toHaveBeenCalled();
    },
  );

  it("is unknown before the configuration exists", async () => {
    const run = build({ environment: "preview", configuration: null });
    await expect(run.host.farolModelCodexHostPresence()).resolves.toBe(
      "unknown",
    );
    expect(run.detect).not.toHaveBeenCalled();
  });

  it("is unknown while the snapshot is not ready", async () => {
    const run = build({
      environment: "preview",
      configuration: {
        snapshot: () => ({ status: "error", error: "SETTINGS_READ_FAILED" }),
      },
    });
    await expect(run.host.farolModelCodexHostPresence()).resolves.toBe(
      "unknown",
    );
    expect(run.detect).not.toHaveBeenCalled();
  });

  it.each([
    ["no Codex host", undefined],
    ["an empty executable path", ""],
  ])("is unknown with %s", async (_label, executablePath) => {
    const run = build({
      environment: "preview",
      configuration: ready(executablePath),
    });
    await expect(run.host.farolModelCodexHostPresence()).resolves.toBe(
      "unknown",
    );
    expect(run.detect).not.toHaveBeenCalled();
  });

  it.each(["running", "not_running", "unknown"] as const)(
    "returns the detector's %s answer for the verified executable",
    async (state) => {
      const run = build({
        environment: "preview",
        configuration: ready("/verified/codex"),
        presence: async () => ({ state }),
      });
      await expect(run.host.farolModelCodexHostPresence()).resolves.toBe(state);
      expect(run.detect).toHaveBeenCalledWith({
        executablePath: "/verified/codex",
      });
    },
  );
});

async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

describe("codexHostRuntimeRoot", () => {
  it("creates a private directory and returns it", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "nested", "runtime");
    const run = build({ runtimeRoot: root });
    await expect(run.host.codexHostRuntimeRoot()).resolves.toBe(root);
    expect(await mode(root)).toBe(0o700);
  });

  it("narrows a directory left with group or other access", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "runtime");
    const run = build({ runtimeRoot: root });
    await run.host.codexHostRuntimeRoot();
    await chmod(root, 0o755);
    await expect(run.host.codexHostRuntimeRoot()).resolves.toBe(root);
    expect(await mode(root)).toBe(0o700);
  });

  it("refuses a symbolic link and leaves its target alone", async () => {
    const parent = await privateTemp();
    const target = path.join(parent, "elsewhere");
    await looseDirectory(target);
    const root = path.join(parent, "runtime");
    await symlink(target, root);
    const run = build({ runtimeRoot: root });
    await expect(run.host.codexHostRuntimeRoot()).rejects.toThrow(
      new Error("CODEX_HOST_RUNTIME_UNSAFE"),
    );
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    expect(await mode(target)).toBe(0o755);
  });

  it("refuses a regular file in its place", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "runtime");
    await writeFile(root, "x");
    const run = build({ runtimeRoot: root });
    await expect(run.host.codexHostRuntimeRoot()).rejects.toThrow();
  });
});

// A directory the check must not touch: created with the loose mode on purpose.
async function looseDirectory(target: string): Promise<void> {
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
}

describe("codexHostHomePath", () => {
  it("creates the app-owned Codex home privately", async () => {
    const parent = await privateTemp();
    const home = path.join(parent, "farol-private", "codex-home");
    const run = build({ codexHome: home });
    await expect(run.host.codexHostHomePath()).resolves.toBe(home);
    expect(await mode(home)).toBe(0o700);
  });

  it("narrows a loose directory and refuses a symbolic link", async () => {
    const parent = await privateTemp();
    const home = path.join(parent, "codex-home");
    const loose = build({ codexHome: home });
    await loose.host.codexHostHomePath();
    await chmod(home, 0o750);
    await loose.host.codexHostHomePath();
    expect(await mode(home)).toBe(0o700);

    const target = path.join(parent, "elsewhere");
    await looseDirectory(target);
    const link = path.join(parent, "linked-home");
    await symlink(target, link);
    const linked = build({ codexHome: link });
    await expect(linked.host.codexHostHomePath()).rejects.toThrow(
      new Error("CODEX_HOST_HOME_UNSAFE"),
    );
  });
});

describe("codexHostHomeOption", () => {
  it("hands the build, the identity, the native home and CODEX_HOME to the resolver", async () => {
    const run = build({
      environment: "preview",
      env: { CODEX_HOME: "/configured/codex" },
      childHomes: { codexHomePath: undefined, processHomePath: "/p" },
    });
    await run.host.codexHostHomeOption();
    expect(run.childHomes).toHaveBeenCalledWith(
      "preview",
      run.identity,
      "/native/home",
      "/configured/codex",
    );
  });

  it("is empty when no Codex home is selected, creating nothing", async () => {
    const parent = await privateTemp();
    const home = path.join(parent, "codex-home");
    const run = build({
      environment: "dev",
      codexHome: home,
      childHomes: { codexHomePath: undefined, processHomePath: "/p" },
    });
    await expect(run.host.codexHostHomeOption()).resolves.toEqual({});
    await expect(lstat(home)).rejects.toThrow();
  });

  it("returns the selection and prepares the private home outside Preview", async () => {
    const parent = await privateTemp();
    const home = path.join(parent, "codex-home");
    const run = build({
      environment: "dev",
      codexHome: home,
      childHomes: { codexHomePath: home, processHomePath: "/p" },
    });
    await expect(run.host.codexHostHomeOption()).resolves.toEqual({
      codexHomePath: home,
    });
    expect(await mode(home)).toBe(0o700);
  });

  it("returns the owner's selection in Preview without touching the app-owned home", async () => {
    const parent = await privateTemp();
    const home = path.join(parent, "codex-home");
    const run = build({
      environment: "preview",
      codexHome: home,
      childHomes: { codexHomePath: "/owner/.codex", processHomePath: "/p" },
    });
    await expect(run.host.codexHostHomeOption()).resolves.toEqual({
      codexHomePath: "/owner/.codex",
    });
    await expect(lstat(home)).rejects.toThrow();
  });

  it("propagates an unsafe app-owned home outside Preview", async () => {
    const parent = await privateTemp();
    const target = path.join(parent, "elsewhere");
    await looseDirectory(target);
    const link = path.join(parent, "linked-home");
    await symlink(target, link);
    const run = build({
      environment: "owner-preview",
      codexHome: link,
      childHomes: { codexHomePath: link, processHomePath: "/p" },
    });
    await expect(run.host.codexHostHomeOption()).rejects.toThrow(
      new Error("CODEX_HOST_HOME_UNSAFE"),
    );
  });
});

describe("codexHostProcessHomePath", () => {
  it("returns the native home in Preview without creating anything", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "native-home");
    const run = build({
      environment: "preview",
      childHomes: { codexHomePath: undefined, processHomePath: root },
    });
    await expect(run.host.codexHostProcessHomePath()).resolves.toBe(root);
    await expect(lstat(root)).rejects.toThrow();
    expect(run.childHomes).toHaveBeenCalledWith(
      "preview",
      run.identity,
      "/native/home",
      undefined,
    );
  });

  it("creates the private process home outside Preview", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "farol-private", "process-home");
    const run = build({
      environment: "dev",
      env: { CODEX_HOME: "/configured/codex" },
      childHomes: { codexHomePath: undefined, processHomePath: root },
    });
    await expect(run.host.codexHostProcessHomePath()).resolves.toBe(root);
    expect(await mode(root)).toBe(0o700);
    expect(run.childHomes).toHaveBeenCalledWith(
      "dev",
      run.identity,
      "/native/home",
      "/configured/codex",
    );
  });

  it("narrows a loose directory and refuses a symbolic link or a file", async () => {
    const parent = await privateTemp();
    const root = path.join(parent, "process-home");
    const first = build({
      environment: "dev",
      childHomes: { codexHomePath: undefined, processHomePath: root },
    });
    await first.host.codexHostProcessHomePath();
    await chmod(root, 0o777);
    await first.host.codexHostProcessHomePath();
    expect(await mode(root)).toBe(0o700);

    const target = path.join(parent, "elsewhere");
    await looseDirectory(target);
    const link = path.join(parent, "linked");
    await symlink(target, link);
    const linked = build({
      environment: "dev",
      childHomes: { codexHomePath: undefined, processHomePath: link },
    });
    await expect(linked.host.codexHostProcessHomePath()).rejects.toThrow(
      new Error("CODEX_HOST_PROCESS_HOME_UNSAFE"),
    );

    const file = path.join(parent, "a-file");
    await writeFile(file, "x");
    const filed = build({
      environment: "dev",
      childHomes: { codexHomePath: undefined, processHomePath: file },
    });
    await expect(filed.host.codexHostProcessHomePath()).rejects.toThrow();
  });
});

import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { App, BrowserWindow, Dialog, SaveDialogOptions } from "electron";
import type {
  desktopCodexChildHomes,
  desktopCodexConfigPath,
  DesktopEnvironment,
  DesktopIdentity,
} from "../../../src/apps/desktop/desktop-environment";
import type { FarolModelProviderSpec } from "../../../src/apps/desktop/farol-model-config-block";
import type { detectCodexHostPresence } from "../../../src/apps/desktop/farol-model-host-presence";
import type {
  FarolModelLifecycle,
  FarolModelLifecycleStatus,
} from "../../../src/apps/desktop/farol-model-lifecycle";
import type { FarolModelRuntimeState } from "../../../src/apps/desktop/farol-model-runtime-state";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

// The model route's small readers and the Codex host path helpers. Main keeps
// every owner: each `let` there is a late getter here, the identity and the
// build constants are shared by reference, and the pure path, config and
// process-table functions are ports. Nothing in this module holds state, and it
// starts no process of its own: the process-table read stays inside the
// injected presence detector.

type ModelEndpoint = Readonly<{
  status: () => FarolModelLifecycleStatus;
  runtimeState: Pick<FarolModelRuntimeState, "currentToken">;
}>;

export type ModelHostPorts = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  app: Pick<App, "getPath">;
  dialog: Pick<Dialog, "showSaveDialog">;
  os: Readonly<{ homedir: () => string }>;
  window: () => BrowserWindow | null;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  modelLifecycle: () => ModelEndpoint | null;
  statePaths: () => Readonly<{ codexHostRuntime: string }>;
  buildIdentity: Readonly<{ version: string }>;
  buildEnvironment: DesktopEnvironment;
  activeDesktopIdentity: DesktopIdentity;
  FAROL_MODEL_ENABLED: boolean;
  FAROL_PROVIDER_ID: string;
  ROUTE_B_MODEL: string;
  desktopCodexConfigPath: typeof desktopCodexConfigPath;
  desktopCodexChildHomes: typeof desktopCodexChildHomes;
  detectCodexHostPresence: typeof detectCodexHostPresence;
}>;

export function createModelHost(ports: ModelHostPorts) {
  const {
    env,
    app,
    dialog,
    os,
    window,
    configuration,
    modelLifecycle,
    statePaths,
    buildIdentity,
    buildEnvironment,
    activeDesktopIdentity,
    FAROL_MODEL_ENABLED,
    FAROL_PROVIDER_ID,
    ROUTE_B_MODEL,
    desktopCodexConfigPath,
    desktopCodexChildHomes,
    detectCodexHostPresence,
  } = ports;

  async function selectedSupportExportTarget(): Promise<string | null> {
    if (env.FAROL_E2E === "1") {
      const target = env.FAROL_E2E_SUPPORT_EXPORT;
      if (!target || !path.isAbsolute(target) || target.includes("\0")) {
        throw new Error("SUPPORT_EXPORT_E2E_TARGET_INVALID");
      }
      return target;
    }
    const options: SaveDialogOptions = {
      title: "Export content-free Farol support report",
      defaultPath: path.join(
        app.getPath("documents"),
        `Farol-Support-${buildIdentity.version}.json`,
      ),
      buttonLabel: "Export Support Report",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const owner = window();
    const selected = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    return selected.canceled || !selected.filePath ? null : selected.filePath;
  }

  // DEV manages only the config inside its app-owned Codex home. It never
  // reads, writes or falls back to the owner's ~/.codex. Packaged Preview keeps
  // its existing explicitly owner-operated configuration behavior.
  function farolModelCodexConfigPath(): string {
    const override =
      env.FAROL_E2E === "1" ? env.FAROL_MODEL_E2E_CODEX_CONFIG_PATH : undefined;
    if (override && path.isAbsolute(override) && !override.includes("\0")) {
      return override;
    }
    return desktopCodexConfigPath(
      buildEnvironment,
      activeDesktopIdentity,
      os.homedir(),
    );
  }

  // E2E-only: a minimal, valid OpenAI Responses-shaped completed turn, used
  // solely behind the FAROL_E2E + FAROL_MODEL_E2E_SYNTHETIC_REPLY double
  // gate above. It never runs in a normal launch.
  function syntheticModelTurnHandler(
    text: string,
  ): NonNullable<
    ConstructorParameters<typeof FarolModelLifecycle>[0]["handler"]
  > {
    return async () => ({
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
                  content: [{ type: "output_text", text, annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        },
      ],
    });
  }

  // This control only ever targets a host the owner starts themselves (their
  // own ordinary Codex reading its own config.toml), so the literal-token
  // delivery from the N04 addendum is the only one it ever builds — the
  // env-key delivery stays reserved for a host Farol launches itself.
  async function farolModelProviderSpec(): Promise<FarolModelProviderSpec | null> {
    if (!FAROL_MODEL_ENABLED) return null;
    const lifecycle = modelLifecycle();
    if (!lifecycle) return null;
    const status = lifecycle.status();
    // S35-TA-2: a sealed endpoint must never produce a provider spec — a
    // block written from one would point an ordinary Codex at a port that
    // refuses every request.
    if (
      status.state === "not_running" ||
      status.state === "port_conflict" ||
      status.state === "sealed"
    ) {
      return null;
    }
    const token = await lifecycle.runtimeState.currentToken();
    if (!token) return null;
    return {
      providerName: FAROL_PROVIDER_ID,
      displayName: "Farol",
      baseUrl: `http://127.0.0.1:${status.port}`,
      // The one model the endpoint serves is the Route B model: the same
      // constant the endpoint validates against and the provider accepts.
      model: ROUTE_B_MODEL,
      wireApi: "responses",
      delivery: { mode: "bearer-token", token },
    };
  }

  // Whether a Codex started from the verified executable is running right
  // now: it decides which restart note the control shows after an apply. A
  // read-only process-table scan; `unknown` when no host is verified yet or
  // the table cannot be read. Never signals or starts anything.
  async function farolModelCodexHostPresence(): Promise<
    "running" | "not_running" | "unknown"
  > {
    // DEV never inspects or asks the owner to restart a personal Codex. Its
    // model route is consumed only by app-owned children with private HOME and
    // CODEX_HOME directories.
    if (buildEnvironment !== "preview") return "not_running";
    const current = configuration();
    const snapshot = current ? current.snapshot() : null;
    const executablePath =
      snapshot && snapshot.status === "ready"
        ? snapshot.settings.nativeHosts.codex?.executablePath
        : undefined;
    if (!executablePath) return "unknown";
    return (await detectCodexHostPresence({ executablePath })).state;
  }

  async function codexHostRuntimeRoot(): Promise<string> {
    const root = statePaths().codexHostRuntime;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("CODEX_HOST_RUNTIME_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
    return root;
  }

  async function codexHostHomePath(): Promise<string> {
    const root = activeDesktopIdentity.codexHome;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("CODEX_HOST_HOME_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
    return root;
  }

  async function codexHostHomeOption(): Promise<
    Readonly<{ codexHomePath?: string }>
  > {
    const { codexHomePath: selected } = desktopCodexChildHomes(
      buildEnvironment,
      activeDesktopIdentity,
      app.getPath("home"),
      env.CODEX_HOME,
    );
    if (selected === undefined) return {};
    if (buildEnvironment !== "preview") await codexHostHomePath();
    return { codexHomePath: selected };
  }

  async function codexHostProcessHomePath(): Promise<string> {
    const { processHomePath: root } = desktopCodexChildHomes(
      buildEnvironment,
      activeDesktopIdentity,
      app.getPath("home"),
      env.CODEX_HOME,
    );
    if (buildEnvironment === "preview") return root;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("CODEX_HOST_PROCESS_HOME_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
    return root;
  }

  return {
    selectedSupportExportTarget,
    farolModelCodexConfigPath,
    syntheticModelTurnHandler,
    farolModelProviderSpec,
    farolModelCodexHostPresence,
    codexHostRuntimeRoot,
    codexHostHomePath,
    codexHostHomeOption,
    codexHostProcessHomePath,
  };
}

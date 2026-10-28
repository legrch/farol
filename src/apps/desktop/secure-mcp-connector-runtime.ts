import {
  readConnectorHealth,
  connectorHealthWire,
} from "../../../apps/desktop/connector-health";
import type { ConnectorHealthSnapshot } from "../../../apps/desktop/bridge/connector-health-snapshot";
import type { ComputerConnectorHealthSnapshot } from "../../../apps/desktop/bridge/wire";
import { readConnectorPollingMetrics } from "../../../apps/desktop/connector-polling";
import type { ComputerConnectorPollingSamples } from "../../../apps/desktop/bridge/wire";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
const PROFILE = "farol";
const HEALTH_URL_FILE = "health.url";
const PID_FILE = "tunnel-client.pid";
const TUNNEL_EXITED = "farol-tunnel-exited-v1";
const TUNNEL_UNKNOWN = "farol-tunnel-unknown-v1";
const TUNNEL_TERMINAL = "farol-tunnel-terminal-v1";

export type ConnectorChildLifecycleObservation = Readonly<{
  source: "connector-tunnel" | "connector-anchor";
  event:
    | "exit"
    | "close"
    | "error"
    | "disconnect"
    | "invalid-receipt"
    | "cleanup-unknown";
  code:
    | "CONNECTOR_TUNNEL_EXIT"
    | "CONNECTOR_TUNNEL_ERROR"
    | "CONNECTOR_TUNNEL_RECEIPT_INVALID"
    | "CONNECTOR_ANCHOR_EXIT"
    | "CONNECTOR_ANCHOR_CLOSE"
    | "CONNECTOR_ANCHOR_ERROR"
    | "CONNECTOR_IPC_DISCONNECTED"
    | "CONNECTOR_STOP_UNCONFIRMED";
  state: "observed" | "outcome_unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}>;
export type ConnectorRuntimeLifecycleObservation =
  ConnectorChildLifecycleObservation &
    Readonly<{
      phase: "startup" | "active" | "closing";
      runtimeGeneration: string;
    }>;
const terminalSignals = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
  "SIGINFO",
  "SIGEMT",
  "SIGBREAK",
]);
function terminalCode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
    ? value
    : null;
}
function terminalSignal(value: unknown): NodeJS.Signals | null {
  return typeof value === "string" && terminalSignals.has(value)
    ? (value as NodeJS.Signals)
    : null;
}
function terminalReceipt(
  value: unknown,
): Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (
      keys.length !== 5 ||
      !["kind", "source", "event", "exitCode", "signal"].every(
        (key) => fields[key] && "value" in fields[key],
      )
    )
      return null;
    const kind = fields.kind!.value,
      source = fields.source!.value,
      event = fields.event!.value;
    const code = fields.exitCode!.value,
      signal = fields.signal!.value;
    if (
      kind !== TUNNEL_TERMINAL ||
      source !== "connector-tunnel" ||
      event !== "exit" ||
      (code !== null && terminalCode(code) !== code) ||
      (signal !== null && terminalSignal(signal) !== signal) ||
      (code === null && signal === null) ||
      (code !== null && signal !== null)
    )
      return null;
    return Object.freeze({ exitCode: code, signal });
  } catch {
    return null;
  }
}

function childLifecycleRecord(
  value: unknown,
): ConnectorChildLifecycleObservation | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(fields).length !== 7 ||
      ![
        "source",
        "event",
        "code",
        "state",
        "exitCode",
        "signal",
        "forced",
      ].every((key) => fields[key] && "value" in fields[key])
    )
      return null;
    const source = fields.source!.value,
      event = fields.event!.value,
      code = fields.code!.value,
      state = fields.state!.value,
      exitCode = fields.exitCode!.value,
      signal = fields.signal!.value,
      forced = fields.forced!.value;
    const allowed = [
      ["connector-tunnel", "exit", "CONNECTOR_TUNNEL_EXIT"],
      ["connector-tunnel", "error", "CONNECTOR_TUNNEL_ERROR"],
      [
        "connector-tunnel",
        "invalid-receipt",
        "CONNECTOR_TUNNEL_RECEIPT_INVALID",
      ],
      ["connector-anchor", "exit", "CONNECTOR_ANCHOR_EXIT"],
      ["connector-anchor", "close", "CONNECTOR_ANCHOR_CLOSE"],
      ["connector-anchor", "error", "CONNECTOR_ANCHOR_ERROR"],
      ["connector-anchor", "disconnect", "CONNECTOR_IPC_DISCONNECTED"],
      ["connector-anchor", "cleanup-unknown", "CONNECTOR_STOP_UNCONFIRMED"],
    ] as const;
    if (
      !allowed.some(([s, e, c]) => source === s && event === e && code === c) ||
      (state !== "observed" && state !== "outcome_unknown") ||
      typeof forced !== "boolean" ||
      (exitCode !== null && terminalCode(exitCode) !== exitCode) ||
      (signal !== null && terminalSignal(signal) !== signal) ||
      (exitCode !== null && signal !== null) ||
      (event !== "exit" &&
        event !== "close" &&
        (state !== "outcome_unknown" ||
          exitCode !== null ||
          signal !== null)) ||
      (state === "observed" && exitCode === null && signal === null)
    )
      return null;
    return Object.freeze({
      source,
      event,
      code,
      state,
      exitCode,
      signal,
      forced,
    });
  } catch {
    return null;
  }
}

export type ConnectorTunnelObservation = Readonly<{
  state: "exited" | "outcome_unknown";
  terminal?: ConnectorChildLifecycleObservation;
}>;

export type ConnectorCommand = Readonly<{
  executablePath: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}>;

export type ConnectorCommandRunner = (
  command: ConnectorCommand,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type ConnectorChild = Readonly<{
  pid: number | undefined;
  exitCode: number | null;
  // Separate from confirmation that the entire owned group has closed.
  tunnelObservation?: ConnectorTunnelObservation | null;
  kill: (signal: NodeJS.Signals) => boolean;
  waitForExit: (timeoutMs: number) => Promise<boolean>;
  observeLifecycle?: (
    observer: (observation: ConnectorChildLifecycleObservation) => void,
  ) => () => void;
}>;

export type ConnectorProcessStarter = (
  command: ConnectorCommand,
  // Call synchronously after asynchronous preparation, before native dispatch.
  beforeEffect?: () => void,
) => Promise<ConnectorChild>;

type Options = Readonly<{
  root: string;
  homePath: string;
  tempPath: string;
  readinessTimeoutMs?: number;
  electronPath?: string;
  recheckExecution?: () => Promise<void>;
}>;

type Dependencies = Readonly<{
  run?: ConnectorCommandRunner;
  start?: ConnectorProcessStarter;
  get?: (url: string) => Promise<boolean>;
  polling?: (base: string) => Promise<ComputerConnectorPollingSamples>;
  health?: (base: string) => Promise<ConnectorHealthSnapshot | null>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  id?: () => string;
  onLifecycleObservation?: (
    observation: ConnectorRuntimeLifecycleObservation,
  ) => void;
}>;

type ConfigureInput = Readonly<{
  beforeEffect?: () => void;
  executablePath: string;
  tunnelId: string;
  credentialReference: string;
  mcp: Readonly<{
    electronPath: string;
    entryPath: string;
    launchContractPath: string;
  }>;
}>;

type StartInput = Readonly<{
  beforeEffect?: () => void;
  executablePath: string;
  executableSha256: string;
  connectorGeneration: number;
  computerGeneration: number;
  buildId: string;
  launchContractSha256: string;
}>;

export type ConnectorStartResult = Readonly<
  | {
      state: "ready";
      runtimeGeneration: string;
      healthBaseUrl: string;
    }
  | {
      state: "unreachable" | "outcome_unknown";
      runtimeGeneration: string;
      code:
        | "CONNECTOR_START_FAILED"
        | "CONNECTOR_EXITED_BEFORE_READY"
        | "CONNECTOR_TUNNEL_OBSERVATION_UNKNOWN"
        | "CONNECTOR_READINESS_TIMEOUT";
    }
>;

function runtimeError(code: string): never {
  throw new Error(code);
}

class ConnectorProcessNotStarted extends Error {}

export class ConnectorRuntimeEffectUnknown extends Error {}

function absolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0");
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    runtimeError("CONNECTOR_MCP_COMMAND_INVALID");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function mcpCommand(input: ConfigureInput["mcp"]): string {
  if (
    !absolutePath(input.electronPath) ||
    !absolutePath(input.entryPath) ||
    !absolutePath(input.launchContractPath)
  ) {
    runtimeError("CONNECTOR_MCP_COMMAND_INVALID");
  }
  return [
    "/usr/bin/env",
    "ELECTRON_RUN_AS_NODE=1",
    input.electronPath,
    input.entryPath,
    "--launch-contract",
    input.launchContractPath,
  ]
    .map(shellQuote)
    .join(" ");
}

const runCommand: ConnectorCommandRunner = async (command) =>
  new Promise((resolve, reject) => {
    execFile(
      command.executablePath,
      [...command.arguments],
      {
        cwd: command.cwd,
        env: { ...command.environment },
        encoding: "utf8",
        maxBuffer: command.maxBufferBytes,
        timeout: command.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });

export function observedConnectorChild(
  child: ChildProcess,
  ownsProcessGroup = false,
  observesTunnel = false,
): ConnectorChild {
  let tunnelObservation: ConnectorTunnelObservation | null = null;
  const retained = new Map<string, ConnectorChildLifecycleObservation>();
  const observers = new Set<
    (observation: ConnectorChildLifecycleObservation) => void
  >();
  let forced = false;
  const diagnostic = (
    source: ConnectorChildLifecycleObservation["source"],
    event: ConnectorChildLifecycleObservation["event"],
    code: ConnectorChildLifecycleObservation["code"],
    state: ConnectorChildLifecycleObservation["state"],
    exitCode: unknown = null,
    signal: unknown = null,
  ) => {
    const key = `${source}:${event}`;
    if (retained.has(key)) return retained.get(key)!;
    const safeCode = terminalCode(exitCode),
      safeSignal = terminalSignal(signal);
    const terminalKnown = (safeCode === null) !== (safeSignal === null);
    const observation = Object.freeze({
      source,
      event,
      code,
      state: state === "observed" && !terminalKnown ? "outcome_unknown" : state,
      exitCode: terminalKnown ? safeCode : null,
      signal: terminalKnown ? safeSignal : null,
      forced,
    });
    retained.set(key, observation);
    for (const observer of observers) {
      try {
        void Promise.resolve(observer(observation)).catch(() => undefined);
      } catch {
        /* Diagnostics never change cleanup. */
      }
    }
    return observation;
  };
  const observe = (
    state: ConnectorTunnelObservation["state"],
    terminal?: ConnectorChildLifecycleObservation,
  ) => {
    tunnelObservation ??= Object.freeze({
      state,
      ...(terminal ? { terminal } : {}),
    });
  };
  // A failed signal can emit `error` without `exit`. Never treat it as exit.
  child.on("error", () => {
    if (observesTunnel) observe("outcome_unknown");
    diagnostic(
      "connector-anchor",
      "error",
      "CONNECTOR_ANCHOR_ERROR",
      "outcome_unknown",
    );
  });
  if (observesTunnel) {
    // This channel belongs to the exact spawned anchor. Accept only closed,
    // content-free receipts; no coercion, getters or retained raw payload.
    child.on("message", (message: unknown) => {
      if (tunnelObservation) return;
      if (message === TUNNEL_EXITED) {
        observe("exited");
        // Legacy exit tokens prove no exit-code/signal detail.
        diagnostic(
          "connector-tunnel",
          "exit",
          "CONNECTOR_TUNNEL_EXIT",
          "outcome_unknown",
        );
      } else if (message === TUNNEL_UNKNOWN) {
        observe("outcome_unknown");
        diagnostic(
          "connector-tunnel",
          "error",
          "CONNECTOR_TUNNEL_ERROR",
          "outcome_unknown",
        );
      } else {
        const receipt = terminalReceipt(message);
        if (receipt) {
          observe("exited");
          const terminal = diagnostic(
            "connector-tunnel",
            "exit",
            "CONNECTOR_TUNNEL_EXIT",
            "observed",
            receipt.exitCode,
            receipt.signal,
          );
          tunnelObservation = Object.freeze({ state: "exited", terminal });
        } else {
          observe("outcome_unknown");
          diagnostic(
            "connector-tunnel",
            "invalid-receipt",
            "CONNECTOR_TUNNEL_RECEIPT_INVALID",
            "outcome_unknown",
          );
        }
      }
    });
    child.once("disconnect", () => {
      observe("outcome_unknown");
      diagnostic(
        "connector-anchor",
        "disconnect",
        "CONNECTOR_IPC_DISCONNECTED",
        "outcome_unknown",
      );
    });
    child.once("exit", (code, signal) => {
      observe("outcome_unknown");
      diagnostic(
        "connector-anchor",
        "exit",
        "CONNECTOR_ANCHOR_EXIT",
        "observed",
        code,
        signal,
      );
    });
    child.once("close", (code, signal) =>
      diagnostic(
        "connector-anchor",
        "close",
        "CONNECTOR_ANCHOR_CLOSE",
        "observed",
        code,
        signal,
      ),
    );
  }
  const groupPid = ownsProcessGroup ? child.pid : undefined;
  let groupGone = false;
  let signalRefused = false;
  const directExitCode = () =>
    child.exitCode ?? (child.signalCode === null ? null : -1);
  const groupExitConfirmed = () => {
    if (!ownsProcessGroup) return true;
    if (signalRefused || groupPid === undefined) return false;
    if (groupGone) return true;
    try {
      process.kill(-groupPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        // Cache absence: never probe or signal a subsequently reused group.
        groupGone = true;
      } else {
        signalRefused = true;
      }
    }
    return groupGone;
  };
  return {
    pid: child.pid,
    get tunnelObservation() {
      return tunnelObservation;
    },
    get exitCode() {
      const code = directExitCode();
      return code !== null && groupExitConfirmed() ? code : null;
    },
    observeLifecycle: (observer) => {
      if (observers.size < 4) {
        observers.add(observer);
        for (const observation of retained.values()) {
          try {
            void Promise.resolve(observer(observation)).catch(() => undefined);
          } catch {
            /* Diagnostics remain optional. */
          }
        }
      }
      return () => {
        observers.delete(observer);
      };
    },
    kill: (signal) => {
      if (signal === "SIGKILL") forced = true;
      if (!ownsProcessGroup) return child.kill(signal);
      // Only the exact detached spawn owns this group. Once its leader exited,
      // ownership cannot be re-established from a numeric PID; do not escalate
      // against descendants or a reused group. Retain unconfirmed cleanup.
      if (
        groupPid === undefined ||
        signalRefused ||
        groupGone ||
        directExitCode() !== null
      )
        return false;
      try {
        process.kill(-groupPid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") groupGone = true;
        else signalRefused = true;
        return false;
      }
    },
    waitForExit: async (timeoutMs) => {
      if (ownsProcessGroup) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (signalRefused) return false;
          if (directExitCode() !== null && groupExitConfirmed()) return true;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          await wait(Math.min(50, remaining));
        }
      }
      if (directExitCode() !== null) return true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", exited);
          child.off("error", failed);
          resolve(value);
        };
        const exited = () => finish(true);
        const failed = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", exited);
        child.once("error", failed);
      });
    },
  };
}

// The anchor stays alive even when the tunnel leader exits, so SIGKILL can
// still address an owned group instead of a potentially reused numeric PID.
// Desktop owns its open stdin pipe. Parent loss closes that pipe and the
// anchor atomically kills its own group; no unreferenced helper survives.
const CONNECTOR_GROUP_ANCHOR = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(process.argv[1], process.argv.slice(2), {
  env: environment, stdio: "ignore", windowsHide: true
});
let observed = false;
const report = (message) => {
  if (observed) return;
  observed = true;
  if (process.connected) process.send(message, () => {});
};
const terminate = () => process.kill(-process.pid, "SIGKILL");
child.once("exit", (exitCode, signal) => report({
  kind: ${JSON.stringify(TUNNEL_TERMINAL)}, source: "connector-tunnel", event: "exit", exitCode, signal
}));
child.once("error", () => {
  report(${JSON.stringify(TUNNEL_UNKNOWN)});
  terminate();
});
process.stdin.once("end", terminate);
process.stdin.resume();
`;

function assertConnectorDispatch(beforeEffect?: () => void): void {
  try {
    beforeEffect?.();
  } catch {
    throw new ConnectorProcessNotStarted("CONNECTOR_ADMISSION_WITHDRAWN");
  }
}

const startProcess = async (
  command: ConnectorCommand,
  electronPath: string,
  recheckExecution?: () => Promise<void>,
  beforeEffect?: () => void,
): Promise<ConnectorChild> => {
  if (process.platform !== "darwin")
    throw new ConnectorProcessNotStarted("CONNECTOR_PROCESS_GROUP_UNSUPPORTED");
  try {
    await fs.access(command.executablePath, fs.constants.X_OK);
  } catch {
    throw new ConnectorProcessNotStarted("CONNECTOR_EXECUTABLE_UNAVAILABLE");
  }
  try {
    await recheckExecution?.();
  } catch {
    throw new ConnectorProcessNotStarted(
      "CONNECTOR_EXECUTION_RESOURCES_UNCONFIRMED",
    );
  }
  assertConnectorDispatch(beforeEffect);
  const child = spawn(
    electronPath,
    [
      "-e",
      CONNECTOR_GROUP_ANCHOR,
      "--",
      command.executablePath,
      ...command.arguments,
    ],
    {
      cwd: command.cwd,
      env: { ...command.environment, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "ignore", "ignore", "ipc"],
      serialization: "json",
      windowsHide: true,
      detached: true,
    },
  );
  // A broken pipe is not a terminal observation for the owned process group.
  child.stdin?.on("error", () => undefined);
  const observed = observedConnectorChild(child, true, true);
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      resolve();
    };
    const failed = () => {
      child.off("spawn", spawned);
      // Node emits `error` instead of `spawn` when the process never began.
      reject(new ConnectorProcessNotStarted("CONNECTOR_START_FAILED"));
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
  return observed;
};

const getReady = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SecureMcpConnectorRuntime {
  private readonly run: ConnectorCommandRunner;
  private readonly startProcess: ConnectorProcessStarter;
  private readonly get: (url: string) => Promise<boolean>;
  private readonly health: (
    base: string,
  ) => Promise<ConnectorHealthSnapshot | null>;
  private healthInstanceId: string | null = null;
  private readonly polling: (
    base: string,
  ) => Promise<ComputerConnectorPollingSamples>;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly readinessTimeoutMs: number;
  private child: ConnectorChild | null = null;
  private uncertainStart: ConnectorStartResult | null = null;
  private uncertainConfigure = false;
  private healthBaseUrl: string | null = null;
  private runtimeGeneration: string | null = null;
  private readonly onLifecycleObservation: Dependencies["onLifecycleObservation"];
  private childLifecycle: Readonly<{
    child: ConnectorChild;
    phase: { value: ConnectorRuntimeLifecycleObservation["phase"] };
    runtimeGeneration: string;
    reported: Set<string>;
  }> | null = null;

  constructor(
    private readonly options: Options,
    dependencies: Dependencies = {},
  ) {
    if (
      !absolutePath(options.root) ||
      !absolutePath(options.homePath) ||
      !absolutePath(options.tempPath) ||
      (options.electronPath !== undefined &&
        !absolutePath(options.electronPath)) ||
      (options.readinessTimeoutMs !== undefined &&
        (!Number.isInteger(options.readinessTimeoutMs) ||
          options.readinessTimeoutMs < 100 ||
          options.readinessTimeoutMs > 30_000))
    ) {
      throw new Error("CONNECTOR_RUNTIME_OPTIONS_INVALID");
    }
    this.run = dependencies.run ?? runCommand;
    this.startProcess =
      dependencies.start ??
      ((command, beforeEffect) =>
        startProcess(
          command,
          options.electronPath ?? process.execPath,
          options.recheckExecution,
          beforeEffect,
        ));
    this.get = dependencies.get ?? getReady;
    this.health = dependencies.health ?? readConnectorHealth;
    this.polling = dependencies.polling ?? readConnectorPollingMetrics;
    this.wait = dependencies.wait ?? wait;
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.onLifecycleObservation = dependencies.onLifecycleObservation;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
  }

  async configure(input: ConfigureInput): Promise<void> {
    if (this.uncertainConfigure)
      throw new ConnectorRuntimeEffectUnknown(
        "CONNECTOR_CONFIGURE_OUTCOME_UNKNOWN",
      );
    assertConnectorDispatch(input.beforeEffect);
    await this.options.recheckExecution?.();
    assertConnectorDispatch(input.beforeEffect);
    this.validateExecutable(input.executablePath);
    if (!/^[0-9A-Za-z._:-]{1,160}$/u.test(input.tunnelId)) {
      runtimeError("CONNECTOR_TUNNEL_ID_INVALID");
    }
    const credentialPath = input.credentialReference.startsWith("file:")
      ? input.credentialReference.slice("file:".length)
      : "";
    if (!absolutePath(credentialPath)) {
      runtimeError("CONNECTOR_CREDENTIAL_REFERENCE_INVALID");
    }
    await this.ensureRoots();
    const command: ConnectorCommand = {
      ...this.commandBase(input.executablePath),
      arguments: [
        "init",
        "--force",
        "--sample",
        "sample_mcp_stdio_local",
        "--profile",
        PROFILE,
        "--profile-dir",
        this.profileRoot(),
        "--tunnel-id",
        input.tunnelId,
        "--control-plane-api-key-ref",
        input.credentialReference,
        "--health-listen-addr",
        "127.0.0.1:0",
        "--mcp-command",
        mcpCommand(input.mcp),
      ],
      timeoutMs: 15_000,
    };
    assertConnectorDispatch(input.beforeEffect);
    try {
      await this.run(command);
    } catch (error) {
      // ENOENT/EACCES are launch refusals. Any other failure may follow a
      // partial --force profile write, so no second init is admissible here.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "EACCES") {
        this.uncertainConfigure = true;
        throw new ConnectorRuntimeEffectUnknown(
          "CONNECTOR_CONFIGURE_OUTCOME_UNKNOWN",
        );
      }
      runtimeError("CONNECTOR_CONFIGURE_FAILED");
    }
  }

  hasUnresolvedEffect(): boolean {
    return this.uncertainConfigure || this.uncertainStart !== null;
  }

  async doctor(
    input: Readonly<{ executablePath: string; beforeEffect?: () => void }>,
  ): Promise<void> {
    assertConnectorDispatch(input.beforeEffect);
    this.validateExecutable(input.executablePath);
    await this.ensureRoots();
    assertConnectorDispatch(input.beforeEffect);
    try {
      await this.run({
        ...this.commandBase(input.executablePath),
        arguments: [
          "doctor",
          "--profile",
          PROFILE,
          "--profile-dir",
          this.profileRoot(),
          "--json",
          "--explain",
        ],
        timeoutMs: 60_000,
      });
    } catch {
      runtimeError("CONNECTOR_DOCTOR_FAILED");
    }
  }

  async start(input: StartInput): Promise<ConnectorStartResult> {
    // A lost spawn acknowledgement is not authority to launch another child.
    // Return the original identity even when a later caller supplies new input.
    if (this.uncertainStart) return this.uncertainStart;
    assertConnectorDispatch(input.beforeEffect);
    this.validateStartInput(input);
    if (this.child?.exitCode === null) {
      runtimeError("CONNECTOR_ALREADY_RUNNING");
    }
    await this.ensureRoots();
    this.healthBaseUrl = null;
    await this.removeRuntimeFile(this.healthUrlFile());
    await this.removeRuntimeFile(this.pidFile());
    const runtimeGeneration = createHash("sha256")
      .update(
        [
          this.id(),
          input.executableSha256,
          String(input.connectorGeneration),
          String(input.computerGeneration),
          input.buildId,
          input.launchContractSha256,
        ].join("\0"),
      )
      .digest("hex");
    let child: ConnectorChild;
    assertConnectorDispatch(input.beforeEffect);
    try {
      child = await this.startProcess(
        {
          ...this.commandBase(input.executablePath),
          arguments: [
            "run",
            "--profile",
            PROFILE,
            "--profile-dir",
            this.profileRoot(),
            "--health.listen-addr",
            "127.0.0.1:0",
            "--health.url-file",
            this.healthUrlFile(),
            "--pid.file",
            this.pidFile(),
            "--log.format",
            "json",
            "--log.level",
            "info",
          ],
          timeoutMs: 0,
        },
        () => assertConnectorDispatch(input.beforeEffect),
      );
    } catch (error) {
      const result: ConnectorStartResult = {
        state:
          error instanceof ConnectorProcessNotStarted
            ? "unreachable"
            : "outcome_unknown",
        runtimeGeneration,
        code: "CONNECTOR_START_FAILED",
      };
      if (result.state === "outcome_unknown") this.uncertainStart = result;
      return result;
    }
    this.child = child;
    this.healthInstanceId = null;
    this.runtimeGeneration = runtimeGeneration;
    const phase = {
      value: "startup" as ConnectorRuntimeLifecycleObservation["phase"],
    };
    const reported = new Set<string>();
    this.childLifecycle = { child, phase, runtimeGeneration, reported };
    if (this.onLifecycleObservation)
      try {
        child.observeLifecycle?.((observation) => {
          // The observer closes over this original lifetime, never the mutable slot.
          try {
            const record = childLifecycleRecord(observation);
            if (!record) return;
            const key = `${record.source}:${record.event}`;
            if (reported.has(key)) return;
            reported.add(key);
            void Promise.resolve(
              this.onLifecycleObservation?.(
                Object.freeze({
                  ...record,
                  phase: phase.value,
                  runtimeGeneration,
                }),
              ),
            ).catch(() => undefined);
          } catch {
            /* Diagnostics cannot alter Start, stop or group ownership. */
          }
        });
      } catch {
        /* A missing diagnostic port cannot change original Start. */
      }
    const supersededResult = (): ConnectorStartResult | null =>
      this.child === child
        ? null
        : {
            state: "unreachable",
            runtimeGeneration,
            code: "CONNECTOR_EXITED_BEFORE_READY",
          };
    const terminalResult = (): ConnectorStartResult | null => {
      const superseded = supersededResult();
      if (superseded) return superseded;
      const observation = child.tunnelObservation;
      if (!observation) return null;
      return {
        state:
          observation.state === "exited" ? "unreachable" : "outcome_unknown",
        runtimeGeneration,
        code:
          observation.state === "exited"
            ? "CONNECTOR_EXITED_BEFORE_READY"
            : "CONNECTOR_TUNNEL_OBSERVATION_UNKNOWN",
      };
    };
    const deadline = this.now() + this.readinessTimeoutMs;
    let healthObserved = false;
    while (this.now() <= deadline) {
      // A terminal tunnel does not release the anchor or group ownership.
      const terminal = terminalResult();
      if (terminal) return terminal;
      if (child.exitCode !== null) {
        if (this.child === child) this.child = null;
        return {
          state: "unreachable",
          runtimeGeneration,
          code: "CONNECTOR_EXITED_BEFORE_READY",
        };
      }
      const healthBaseUrl = await this.readHealthBaseUrl();
      const afterRead = terminalResult();
      if (afterRead) return afterRead;
      if (healthBaseUrl !== null) {
        healthObserved = true;
        const ready = await this.get(`${healthBaseUrl}/readyz`);
        const afterProbe = terminalResult();
        if (afterProbe) return afterProbe;
        if (ready && this.child === child && child.exitCode === null) {
          this.healthBaseUrl = healthBaseUrl;
          phase.value = "active";
          return { state: "ready", runtimeGeneration, healthBaseUrl };
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.wait(Math.min(50, remaining));
    }
    const beforeCleanup = supersededResult();
    if (beforeCleanup) return beforeCleanup;
    if (!healthObserved) {
      phase.value = "closing";
      child.kill("SIGTERM");
      let exited = await child.waitForExit(1_000);
      const afterTerm = supersededResult();
      if (afterTerm) return afterTerm;
      if (!exited) {
        child.kill("SIGKILL");
        exited = await child.waitForExit(1_000);
        const afterKill = supersededResult();
        if (afterKill) return afterKill;
      }
      if (exited) {
        if (this.child === child) this.child = null;
      } else {
        return {
          state: "outcome_unknown",
          runtimeGeneration,
          code: "CONNECTOR_READINESS_TIMEOUT",
        };
      }
    }
    return {
      state: healthObserved ? "outcome_unknown" : "unreachable",
      runtimeGeneration,
      code: "CONNECTOR_READINESS_TIMEOUT",
    };
  }

  // One non-disruptive probe of the endpoint observed for this exact child.
  // No caller URL, shell command, credential read, restart or model turn.
  async checkHealth(): Promise<boolean> {
    const child = this.child;
    const base = this.healthBaseUrl;
    if (
      !child ||
      child.exitCode !== null ||
      child.tunnelObservation != null ||
      base === null
    )
      return false;
    try {
      const ready = await this.get(`${base}/readyz`);
      return (
        ready &&
        this.child === child &&
        child.exitCode === null &&
        child.tunnelObservation == null &&
        this.healthBaseUrl === base
      );
    } catch {
      return false;
    }
  }

  // A read from this exact child/locator, with no effectful fallback. A stale
  // completion is absent, never positive data borrowed by a replacement.
  async observePolling(): Promise<Readonly<{
    runtimeGeneration: string;
    samples: ComputerConnectorPollingSamples;
  }> | null> {
    const child = this.child,
      base = this.healthBaseUrl,
      generation = this.runtimeGeneration;
    if (
      !child ||
      child.exitCode !== null ||
      child.tunnelObservation != null ||
      base === null ||
      generation === null
    )
      return null;
    const samples = await this.polling(base);
    if (
      this.child !== child ||
      child.exitCode !== null ||
      child.tunnelObservation != null ||
      this.healthBaseUrl !== base ||
      this.runtimeGeneration !== generation
    )
      return null;
    return Object.freeze({ runtimeGeneration: generation, samples });
  }

  // Passive reads are bound to this original owned child and locator. The
  // first report pins its runtime instance for diagnostics, never authority.
  async observeHealth(): Promise<Readonly<{
    runtimeGeneration: string;
    expectedInstanceId: string;
    snapshot?: ComputerConnectorHealthSnapshot;
  }> | null> {
    const child = this.child,
      base = this.healthBaseUrl,
      generation = this.runtimeGeneration;
    if (
      !child ||
      child.exitCode !== null ||
      child.tunnelObservation != null ||
      base === null ||
      generation === null ||
      this.hasUnresolvedEffect()
    )
      return null;
    const sample = await this.health(base);
    if (
      this.child !== child ||
      child.exitCode !== null ||
      child.tunnelObservation != null ||
      this.healthBaseUrl !== base ||
      this.runtimeGeneration !== generation ||
      this.hasUnresolvedEffect()
    )
      return null;
    const snapshot = sample === null ? null : connectorHealthWire(sample);
    if (snapshot && this.healthInstanceId === null)
      this.healthInstanceId = snapshot.runtimeInstanceId;
    if (this.healthInstanceId === null) return null;
    return Object.freeze({
      runtimeGeneration: generation,
      expectedInstanceId: this.healthInstanceId,
      ...(snapshot === null ? {} : { snapshot }),
    });
  }

  // Host composition must correlate this with its current runtime generation;
  // it is neither a group-closure receipt nor authority to start another child.
  getTunnelObservation():
    | (ConnectorTunnelObservation &
        Readonly<{
          runtimeGeneration: string;
        }>)
    | null {
    const observation = this.child?.tunnelObservation;
    return observation && this.runtimeGeneration
      ? Object.freeze({
          ...observation,
          runtimeGeneration: this.runtimeGeneration,
        })
      : null;
  }

  async observeStopAttempt<T>(operation: () => Promise<T>): Promise<T> {
    const lifetime = this.childLifecycle;
    // Publishing the existing durable Stop can end the tunnel before the
    // anchor is stopped. Only annotate this original active lifetime; this
    // scope supplies no admission, drain, terminal or cleanup authority.
    if (!lifetime || lifetime.phase.value !== "active") return operation();
    const before = lifetime.reported.size;
    lifetime.phase.value = "closing";
    try {
      return await operation();
    } catch (error) {
      lifetime.phase.value = "active";
      const key = "connector-anchor:cleanup-unknown";
      // If Stop failed after a terminal notification, retain that uncertainty
      // even when the enclosing failure is classified as a known refusal.
      if (lifetime.reported.size !== before && !lifetime.reported.has(key)) {
        lifetime.reported.add(key);
        try {
          void Promise.resolve(
            this.onLifecycleObservation?.(
              Object.freeze({
                source: "connector-anchor",
                phase: "closing",
                event: "cleanup-unknown",
                code: "CONNECTOR_STOP_UNCONFIRMED",
                state: "outcome_unknown",
                exitCode: null,
                signal: null,
                forced: false,
                runtimeGeneration: lifetime.runtimeGeneration,
              }),
            ),
          ).catch(() => undefined);
        } catch {
          /* Preserve the original Stop failure. */
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.hasUnresolvedEffect()) runtimeError("CONNECTOR_STOP_UNCONFIRMED");
    const child = this.child;
    this.healthBaseUrl = null;
    if (!child) return;
    const lifetime =
      this.childLifecycle?.child === child ? this.childLifecycle : null;
    if (lifetime) lifetime.phase.value = "closing";
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      // The anchor retains group ownership after TERM. Leave time inside the
      // Desktop's absolute Quit budget for terminal confirmation and MCP cleanup.
      if (!(await child.waitForExit(500))) {
        child.kill("SIGKILL");
        if (!(await child.waitForExit(1_000))) {
          try {
            const key = "connector-anchor:cleanup-unknown";
            if (lifetime && !lifetime.reported.has(key)) {
              lifetime.reported.add(key);
              void Promise.resolve(
                this.onLifecycleObservation?.(
                  Object.freeze({
                    source: "connector-anchor",
                    phase: "closing",
                    event: "cleanup-unknown",
                    code: "CONNECTOR_STOP_UNCONFIRMED",
                    state: "outcome_unknown",
                    exitCode: null,
                    signal: null,
                    forced: true,
                    runtimeGeneration: lifetime.runtimeGeneration,
                  }),
                ),
              ).catch(() => undefined);
            }
          } catch {
            /* Diagnostic failure does not change original UNKNOWN. */
          }
          throw new Error("CONNECTOR_STOP_UNCONFIRMED");
        }
      }
    }
    if (this.child === child) this.child = null;
  }

  isRunning(): boolean {
    return this.uncertainStart !== null || this.child?.exitCode === null;
  }

  private commandBase(
    executablePath: string,
  ): Omit<ConnectorCommand, "arguments" | "timeoutMs"> {
    return {
      executablePath,
      cwd: this.options.root,
      environment: {
        PATH: `${path.dirname(executablePath)}:${SAFE_PATH}`,
        HOME: this.options.homePath,
        TMPDIR: this.options.tempPath,
        TUNNEL_CLIENT_STATE_DIR: this.stateRoot(),
        NO_COLOR: "1",
        TERM: "dumb",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
      maxBufferBytes: 256 * 1_024,
    };
  }

  private validateExecutable(executablePath: string): void {
    if (!absolutePath(executablePath)) {
      runtimeError("CONNECTOR_EXECUTABLE_INVALID");
    }
  }

  private validateStartInput(input: StartInput): void {
    this.validateExecutable(input.executablePath);
    if (
      !/^[a-f0-9]{64}$/u.test(input.executableSha256) ||
      !Number.isInteger(input.connectorGeneration) ||
      input.connectorGeneration < 1 ||
      !Number.isInteger(input.computerGeneration) ||
      input.computerGeneration < 1 ||
      !/^[a-f0-9]{64}$/u.test(input.buildId) ||
      !/^[a-f0-9]{64}$/u.test(input.launchContractSha256)
    ) {
      runtimeError("CONNECTOR_START_INPUT_INVALID");
    }
  }

  private async ensureRoots(): Promise<void> {
    for (const root of [
      this.options.root,
      this.profileRoot(),
      this.stateRoot(),
      this.runtimeRoot(),
    ]) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(root);
      const effectiveUser = process.geteuid?.();
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (effectiveUser !== undefined && info.uid !== effectiveUser)
      ) {
        runtimeError("CONNECTOR_RUNTIME_UNSAFE");
      }
      if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
    }
  }

  private async removeRuntimeFile(file: string): Promise<void> {
    try {
      const info = await fs.lstat(file);
      const effectiveUser = process.geteuid?.();
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (effectiveUser !== undefined && info.uid !== effectiveUser)
      ) {
        runtimeError("CONNECTOR_RUNTIME_UNSAFE");
      }
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async readHealthBaseUrl(): Promise<string | null> {
    try {
      const info = await fs.lstat(this.healthUrlFile());
      const effectiveUser = process.geteuid?.();
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > 256 ||
        (effectiveUser !== undefined && info.uid !== effectiveUser)
      ) {
        runtimeError("CONNECTOR_RUNTIME_UNSAFE");
      }
      const value = (await fs.readFile(this.healthUrlFile(), "utf8")).trim();
      const parsed = new URL(value);
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "127.0.0.1" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.port === ""
      ) {
        return null;
      }
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      if ((info.mode & 0o077) !== 0) {
        await fs.chmod(this.healthUrlFile(), 0o600);
      }
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof TypeError
      ) {
        return null;
      }
      throw error;
    }
  }

  private profileRoot(): string {
    return path.join(this.options.root, "profiles");
  }

  private stateRoot(): string {
    return path.join(this.options.root, "state");
  }

  private runtimeRoot(): string {
    return path.join(this.options.root, "runtime");
  }

  private healthUrlFile(): string {
    return path.join(this.runtimeRoot(), HEALTH_URL_FILE);
  }

  private pidFile(): string {
    return path.join(this.runtimeRoot(), PID_FILE);
  }
}

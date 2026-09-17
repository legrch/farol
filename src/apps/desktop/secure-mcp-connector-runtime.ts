import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");
const PROFILE = "farol-next";
const HEALTH_URL_FILE = "health.url";
const PID_FILE = "tunnel-client.pid";

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
  kill: (signal: NodeJS.Signals) => boolean;
  waitForExit: (timeoutMs: number) => Promise<boolean>;
}>;

export type ConnectorProcessStarter = (
  command: ConnectorCommand,
) => Promise<ConnectorChild>;

type Options = Readonly<{
  root: string;
  homePath: string;
  tempPath: string;
  readinessTimeoutMs?: number;
}>;

type Dependencies = Readonly<{
  run?: ConnectorCommandRunner;
  start?: ConnectorProcessStarter;
  get?: (url: string) => Promise<boolean>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  id?: () => string;
}>;

type ConfigureInput = Readonly<{
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
        | "CONNECTOR_READINESS_TIMEOUT";
    }
>;

function runtimeError(code: string): never {
  throw new Error(code);
}

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

const startProcess: ConnectorProcessStarter = async (command) => {
  const child = spawn(command.executablePath, [...command.arguments], {
    cwd: command.cwd,
    env: { ...command.environment },
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    pid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    kill: (signal) => child.kill(signal),
    waitForExit: async (timeoutMs) => {
      if (child.exitCode !== null) return true;
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
        const failed = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", exited);
        child.once("error", failed);
      });
    },
  };
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
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly readinessTimeoutMs: number;
  private child: ConnectorChild | null = null;

  constructor(
    private readonly options: Options,
    dependencies: Dependencies = {},
  ) {
    if (
      !absolutePath(options.root) ||
      !absolutePath(options.homePath) ||
      !absolutePath(options.tempPath) ||
      (options.readinessTimeoutMs !== undefined &&
        (!Number.isInteger(options.readinessTimeoutMs) ||
          options.readinessTimeoutMs < 100 ||
          options.readinessTimeoutMs > 30_000))
    ) {
      throw new Error("CONNECTOR_RUNTIME_OPTIONS_INVALID");
    }
    this.run = dependencies.run ?? runCommand;
    this.startProcess = dependencies.start ?? startProcess;
    this.get = dependencies.get ?? getReady;
    this.wait = dependencies.wait ?? wait;
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
  }

  async configure(input: ConfigureInput): Promise<void> {
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
    try {
      await this.run({
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
      });
    } catch {
      runtimeError("CONNECTOR_CONFIGURE_FAILED");
    }
  }

  async doctor(input: Readonly<{ executablePath: string }>): Promise<void> {
    this.validateExecutable(input.executablePath);
    await this.ensureRoots();
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
    this.validateStartInput(input);
    if (this.child?.exitCode === null) {
      runtimeError("CONNECTOR_ALREADY_RUNNING");
    }
    await this.ensureRoots();
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
    try {
      child = await this.startProcess({
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
      });
    } catch {
      return {
        state: "unreachable",
        runtimeGeneration,
        code: "CONNECTOR_START_FAILED",
      };
    }
    this.child = child;
    const deadline = this.now() + this.readinessTimeoutMs;
    let healthObserved = false;
    while (this.now() <= deadline) {
      if (child.exitCode !== null) {
        this.child = null;
        return {
          state: "unreachable",
          runtimeGeneration,
          code: "CONNECTOR_EXITED_BEFORE_READY",
        };
      }
      const healthBaseUrl = await this.readHealthBaseUrl();
      if (healthBaseUrl !== null) {
        healthObserved = true;
        if (await this.get(`${healthBaseUrl}/readyz`)) {
          return { state: "ready", runtimeGeneration, healthBaseUrl };
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.wait(Math.min(50, remaining));
    }
    return {
      state: healthObserved ? "outcome_unknown" : "unreachable",
      runtimeGeneration,
      code: "CONNECTOR_READINESS_TIMEOUT",
    };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (!(await child.waitForExit(5_000))) {
      child.kill("SIGKILL");
      await child.waitForExit(1_000);
    }
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

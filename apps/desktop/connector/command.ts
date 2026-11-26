import path from "node:path";

// The exact command lines Desktop gives the connector executable, and the
// closed environment each runs in. Nothing here runs a process or touches a
// file: the runtime keeps the effect, this only decides its argument vector.

const SAFE_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export const PROFILE = "farol";

export type ConnectorCommand = Readonly<{
  executablePath: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}>;

export type ConnectorMcp = Readonly<{
  electronPath: string;
  entryPath: string;
  launchContractPath: string;
}>;

export type ConnectorBase = Readonly<{
  root: string;
  homePath: string;
  tempPath: string;
  stateRoot: string;
}>;

export function runtimeError(code: string): never {
  throw new Error(code);
}

export function absolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0");
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    runtimeError("CONNECTOR_MCP_COMMAND_INVALID");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function mcpCommand(input: ConnectorMcp): string {
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

export function commandBase(
  base: ConnectorBase,
  executablePath: string,
): Omit<ConnectorCommand, "arguments" | "timeoutMs"> {
  return {
    executablePath,
    cwd: base.root,
    environment: {
      PATH: `${path.dirname(executablePath)}:${SAFE_PATH}`,
      HOME: base.homePath,
      TMPDIR: base.tempPath,
      TUNNEL_CLIENT_STATE_DIR: base.stateRoot,
      NO_COLOR: "1",
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
    maxBufferBytes: 256 * 1_024,
  };
}

export function configureArguments(
  input: Readonly<{
    profileRoot: string;
    tunnelId: string;
    credentialReference: string;
    mcp: ConnectorMcp;
  }>,
): readonly string[] {
  return [
    "init",
    "--force",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    PROFILE,
    "--profile-dir",
    input.profileRoot,
    "--tunnel-id",
    input.tunnelId,
    "--control-plane-api-key-ref",
    input.credentialReference,
    "--health-listen-addr",
    "127.0.0.1:0",
    "--mcp-command",
    mcpCommand(input.mcp),
  ];
}

export function doctorArguments(profileRoot: string): readonly string[] {
  return [
    "doctor",
    "--profile",
    PROFILE,
    "--profile-dir",
    profileRoot,
    "--json",
    "--explain",
  ];
}

export function runArguments(
  input: Readonly<{
    profileRoot: string;
    healthUrlFile: string;
    pidFile: string;
  }>,
): readonly string[] {
  return [
    "run",
    "--profile",
    PROFILE,
    "--profile-dir",
    input.profileRoot,
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    input.healthUrlFile,
    "--pid.file",
    input.pidFile,
    "--log.format",
    "json",
    "--log.level",
    "info",
  ];
}

import { spawn } from "node:child_process";
import path from "node:path";

import { CodexAppServerClient } from "./codex-app-server-client";

const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

function absolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0");
}

export async function launchCodexAppServer(
  input: Readonly<{
    executablePath: string;
    cwd: string;
    homePath: string;
    tempPath: string;
    clientVersion: string;
    codexHomePath?: string;
  }>,
): Promise<CodexAppServerClient> {
  if (
    !absolutePath(input.executablePath) ||
    !absolutePath(input.cwd) ||
    !absolutePath(input.homePath) ||
    !absolutePath(input.tempPath) ||
    (input.codexHomePath !== undefined && !absolutePath(input.codexHomePath)) ||
    !/^[0-9A-Za-z.+-]{1,80}$/u.test(input.clientVersion)
  ) {
    throw new Error("CODEX_APP_SERVER_LAUNCH_INPUT_INVALID");
  }
  const environment: Record<string, string> = {
    PATH: `${path.dirname(input.executablePath)}:${SAFE_PATH}`,
    HOME: input.homePath,
    TMPDIR: input.tempPath,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  if (input.codexHomePath) environment.CODEX_HOME = input.codexHomePath;

  const child = spawn(input.executablePath, ["app-server", "--stdio"], {
    cwd: input.cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  const client = new CodexAppServerClient(child, {
    clientInfo: { name: "farol-next", version: input.clientVersion },
    requestTimeoutMs: 30_000,
  });
  try {
    await client.initialize();
    return client;
  } catch {
    await client.close().catch(() => undefined);
    throw new Error("CODEX_APP_SERVER_START_FAILED");
  }
}

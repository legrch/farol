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

function providerRouteValid(
  value: Readonly<{ baseUrl: string; token: string }>,
): boolean {
  if (
    value.token.length < 16 ||
    value.token.length > 512 ||
    /[\0\r\n]/u.test(value.token)
  ) {
    return false;
  }
  try {
    const url = new URL(value.baseUrl);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      /^\d{1,5}$/u.test(url.port) &&
      Number(url.port) >= 1 &&
      Number(url.port) <= 65_535 &&
      url.pathname === "/v1" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function providerArguments(baseUrl: string): string[] {
  return [
    "-c",
    'model_provider="farol_next"',
    "-c",
    `model_providers.farol_next={ name = "Farol Next", base_url = "${baseUrl}", wire_api = "responses", env_key = "FAROL_NEXT_PROVIDER_TOKEN", requires_openai_auth = false, request_max_retries = 0, stream_max_retries = 0, stream_idle_timeout_ms = 120000 }`,
  ];
}

export async function launchCodexAppServer(
  input: Readonly<{
    executablePath: string;
    cwd: string;
    homePath: string;
    tempPath: string;
    clientVersion: string;
    codexHomePath?: string;
    providerRoute?: Readonly<{ baseUrl: string; token: string }>;
  }>,
): Promise<CodexAppServerClient> {
  if (
    !absolutePath(input.executablePath) ||
    !absolutePath(input.cwd) ||
    !absolutePath(input.homePath) ||
    !absolutePath(input.tempPath) ||
    (input.codexHomePath !== undefined && !absolutePath(input.codexHomePath)) ||
    (input.providerRoute !== undefined &&
      !providerRouteValid(input.providerRoute)) ||
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
  if (input.providerRoute) {
    environment.FAROL_NEXT_PROVIDER_TOKEN = input.providerRoute.token;
  }

  const arguments_ = [
    "app-server",
    "--stdio",
    ...(input.providerRoute
      ? providerArguments(input.providerRoute.baseUrl)
      : []),
  ];

  const child = spawn(input.executablePath, arguments_, {
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

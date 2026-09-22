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

export type CodexAppServerToolProfile = "dynamic-only" | "native-agent";

const BOUNDED_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "memories",
  "multi_agent_v2",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

// These host capabilities are configured outside the feature registry. The
// installed App Server otherwise advertises `request_user_input` and a
// generic `skills` tool even with every execution/MCP feature below disabled.
// The bounded check/Agent children have no interactive owner channel and no
// skill authority, so both are removed at config parse time as well.
const BOUNDED_CONFIG_ARGUMENTS = [
  "-c",
  "tools.experimental_request_user_input={ enabled = false }",
  "-c",
  "skills=[]",
] as const;

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,120}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedArguments(
  profile: CodexAppServerToolProfile,
  mcpServerNames: readonly string[],
): string[] {
  return [
    "--strict-config",
    ...BOUNDED_CONFIG_ARGUMENTS,
    "-c",
    'web_search="disabled"',
    "--enable",
    "skip_host_skill_discovery",
    profile === "native-agent" ? "--enable" : "--disable",
    "multi_agent",
    ...BOUNDED_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ...mcpServerNames.flatMap((name) => [
      "-c",
      `mcp_servers.${name}.enabled=false`,
    ]),
  ];
}

function effectiveConfig(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.config)) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  return value.config;
}

function configuredMcpServerNames(value: unknown): string[] {
  const config = effectiveConfig(value);
  const candidate = config.mcp_servers;
  if (candidate === undefined || candidate === null) return [];
  if (!record(candidate)) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  const names = Object.keys(candidate).sort();
  if (names.some((name) => !MCP_SERVER_NAME.test(name))) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  return names;
}

function verifyBoundedConfig(
  value: unknown,
  profile: CodexAppServerToolProfile,
  expectedMcpServerNames: readonly string[],
): void {
  const config = effectiveConfig(value);
  if (config.web_search !== "disabled" || !record(config.features)) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  const features = config.features;
  if (
    features.skip_host_skill_discovery !== true ||
    features.multi_agent !== (profile === "native-agent") ||
    BOUNDED_DISABLED_FEATURES.some((feature) => features[feature] !== false)
  ) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  const actualMcpServerNames = configuredMcpServerNames(value);
  if (
    actualMcpServerNames.length !== expectedMcpServerNames.length ||
    actualMcpServerNames.some(
      (name, index) => name !== expectedMcpServerNames[index],
    )
  ) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
  const servers = config.mcp_servers;
  if (
    expectedMcpServerNames.some(
      (name) =>
        !record(servers) ||
        !record(servers[name]) ||
        servers[name].enabled !== false,
    )
  ) {
    throw new Error("CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED");
  }
}

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
    toolProfile?: CodexAppServerToolProfile;
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
    (input.toolProfile !== undefined &&
      input.toolProfile !== "dynamic-only" &&
      input.toolProfile !== "native-agent") ||
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
  if (input.codexHomePath !== undefined) {
    environment.CODEX_HOME = input.codexHomePath;
  }
  if (input.providerRoute) {
    environment.FAROL_NEXT_PROVIDER_TOKEN = input.providerRoute.token;
  }

  const provider = input.providerRoute
    ? providerArguments(input.providerRoute.baseUrl)
    : [];
  const start = (arguments_: readonly string[]): CodexAppServerClient => {
    const child = spawn(input.executablePath, [...arguments_], {
      cwd: input.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.resume();
    return new CodexAppServerClient(child, {
      clientInfo: { name: "farol-next", version: input.clientVersion },
      requestTimeoutMs: 30_000,
    });
  };

  let mcpServerNames: string[] = [];
  if (input.toolProfile) {
    const discovery = start([
      "app-server",
      "--stdio",
      ...provider,
      ...boundedArguments(input.toolProfile, []),
    ]);
    try {
      await discovery.initialize({ deferReady: true });
      mcpServerNames = configuredMcpServerNames(
        await discovery.request("config/read", {
          cwd: input.cwd,
          includeLayers: false,
        }),
      );
    } finally {
      await discovery.close().catch(() => undefined);
    }
  }

  const client = start([
    "app-server",
    "--stdio",
    ...provider,
    ...(input.toolProfile
      ? boundedArguments(input.toolProfile, mcpServerNames)
      : []),
  ]);
  try {
    await client.initialize({ deferReady: input.toolProfile !== undefined });
    if (input.toolProfile) {
      verifyBoundedConfig(
        await client.request("config/read", {
          cwd: input.cwd,
          includeLayers: false,
        }),
        input.toolProfile,
        mcpServerNames,
      );
      client.markReady();
    }
    return client;
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause instanceof Error &&
      cause.message === "CODEX_APP_SERVER_CAPABILITY_POLICY_UNVERIFIED"
      ? cause
      : new Error("CODEX_APP_SERVER_START_FAILED");
  }
}

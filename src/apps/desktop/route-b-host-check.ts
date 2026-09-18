import fs from "node:fs/promises";
import path from "node:path";

import { ROUTE_B_MODEL } from "./route-b-runtime";

// One harmless turn: it asks for a fixed word and touches no tool.
export const ROUTE_B_CHECK_PROMPT =
  "This is a Farol Next connection check. Reply with the single word READY and nothing else.";

// The check's host runs under the launcher's bounded profile: built-in tools,
// web search and every configured MCP server are disabled and the effective
// configuration is verified before the host is ready, so the prompt's intent
// of touching no tool is enforced rather than hoped for. The thread itself
// offers no dynamic tools. Ordinary Route B hosts are the owner's own and
// keep their explicitly approved tools; this profile is the check's alone.
export const ROUTE_B_CHECK_TOOL_PROFILE = "dynamic-only";

export type RouteBHostClient = Readonly<{ close(): Promise<void> }>;

export type RouteBHostLaunchInput = Readonly<{
  executablePath: string;
  cwd: string;
  homePath: string;
  tempPath: string;
  clientVersion: string;
  codexHomePath: string;
  providerRoute: Readonly<{ baseUrl: string; token: string }>;
  toolProfile: typeof ROUTE_B_CHECK_TOOL_PROFILE;
}>;

export type RouteBHostRouteResult = Readonly<{
  threadId: string;
  turnId: string;
  deltaCount: number;
  observedCharacters: number;
}>;

export type RouteBHostCheckDependencies<Client extends RouteBHostClient> =
  Readonly<{
    launch(input: RouteBHostLaunchInput): Promise<Client>;
    route(
      client: Client,
      input: Readonly<{
        model: typeof ROUTE_B_MODEL;
        cwd: string;
        prompt: string;
        timeoutMs: number;
      }>,
    ): Promise<RouteBHostRouteResult>;
  }>;

export type RouteBHostCheckResult =
  | Readonly<{
      status: "completed";
      deltaCount: number;
      observedCharacters: number;
    }>
  | Readonly<{ status: "failed"; code: string }>
  | Readonly<{ status: "outcome_unknown"; code: string }>;

/**
 * Proves Route B end to end with a host this process launches: an isolated
 * Codex App Server whose own Codex home lives in Next's private runtime
 * directory (never the owner's), whose model provider is the running Route B
 * endpoint, whose capabilities are bounded and verified before readiness,
 * and which runs one harmless turn through it. A host that does not apply
 * the bounded profile fails to start, before any model request. Once the
 * host is running, a failure may follow a submitted model request, so it is
 * reported as an unknown outcome and never retried here.
 */
export async function runRouteBHostCheck<Client extends RouteBHostClient>(
  input: Readonly<{
    executablePath: string;
    runtimeRoot: string;
    homePath: string;
    tempPath: string;
    clientVersion: string;
    endpoint: Readonly<{ baseUrl: string; token: string }>;
    timeoutMs?: number;
  }>,
  dependencies: RouteBHostCheckDependencies<Client>,
): Promise<RouteBHostCheckResult> {
  if (!path.isAbsolute(input.runtimeRoot)) {
    return { status: "failed", code: "ROUTE_B_CHECK_INPUT_INVALID" };
  }
  const codexHomePath = path.join(input.runtimeRoot, "route-b-codex-home");
  let client: Client;
  try {
    await fs.mkdir(codexHomePath, { recursive: true, mode: 0o700 });
    client = await dependencies.launch({
      executablePath: input.executablePath,
      cwd: input.runtimeRoot,
      homePath: input.homePath,
      tempPath: input.tempPath,
      clientVersion: input.clientVersion,
      codexHomePath,
      providerRoute: input.endpoint,
      toolProfile: ROUTE_B_CHECK_TOOL_PROFILE,
    });
  } catch {
    return { status: "failed", code: "ROUTE_B_HOST_START_FAILED" };
  }
  try {
    const routed = await dependencies.route(client, {
      model: ROUTE_B_MODEL,
      cwd: input.runtimeRoot,
      prompt: ROUTE_B_CHECK_PROMPT,
      timeoutMs: input.timeoutMs ?? 120_000,
    });
    return {
      status: "completed",
      deltaCount: routed.deltaCount,
      observedCharacters: routed.observedCharacters,
    };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "";
    if (code === "CODEX_CHATGPT_ROUTE_INPUT_INVALID") {
      return { status: "failed", code };
    }
    return {
      status: "outcome_unknown",
      code: /^[A-Z][A-Z0-9_]{2,119}$/u.test(code)
        ? code
        : "ROUTE_B_CHECK_OUTCOME_UNKNOWN",
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

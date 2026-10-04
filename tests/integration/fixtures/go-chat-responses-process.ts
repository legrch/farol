// Real Go services/Root/framing, with controlled in-memory browser and journal.
// This helper opens no Electron, native runtime/profile store or live provider.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "../../../apps/desktop/bridge/client.ts";
import { ChatBridge } from "../../../apps/desktop/bridge/chat.ts";
import { ChatCallerBridge } from "../../../apps/desktop/bridge/chat-caller.ts";
import type {
  BrowserSelection,
  BrowserResolution,
  BrowserRequiredControls,
} from "../../../apps/desktop/bridge/wire.ts";

const scenarios = ["tool", "text", "lost-send-reply"] as const;
export type GoChatResponsesScenario = (typeof scenarios)[number];
const count = z.number().int().nonnegative().max(100000);
const receiptSchema = z.strictObject({
  classification: z.literal("controlled-go-chat-cpu-peer"),
  scenario: z.enum(scenarios),
  methods: z.record(
    z.string(),
    z.strictObject({ attempts: count, known: count }),
  ),
  commits: z.record(z.string(), count),
  physicalSendAttempts: count,
  acceptedSubmissions: count,
  observations: count,
  serverEOF: z.literal(true),
});
export type GoChatResponsesReceipt = z.infer<typeof receiptSchema>;

export async function startGoChatResponsesFixture(
  scenario: GoChatResponsesScenario,
): Promise<{
  client: Client;
  chat: ChatBridge;
  caller: ChatCallerBridge;
  selection: BrowserSelection;
  resolution: BrowserResolution;
  required: BrowserRequiredControls;
  close(): Promise<GoChatResponsesReceipt>;
}> {
  if (!scenarios.includes(scenario))
    throw new Error("fixture_scenario_invalid");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const go = process.env.FAROL_TEST_GO ?? "go";
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
  };
  const version = execFileSync(go, ["version"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  if (!version.startsWith("go version go1.26.2 "))
    throw new Error("fixture_go_toolchain_mismatch");
  const directory = await mkdtemp(
    path.join(tmpdir(), "farol-go-responses-cpu-"),
  );
  const executable = path.join(directory, "chat-responses");
  // Only the controlled test peer is compiled. This is not an application build
  // or package gate; no native profile/authority launch arguments are supplied.
  execFileSync(
    go,
    ["build", "-o", executable, "./tests/fixtures/chat-responses"],
    { cwd: root, env, timeout: 30000, stdio: "pipe" },
  );
  const child = spawn(executable, [scenario], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
    stdio: "pipe",
  });
  let diagnostic = "";
  let overflow = false;
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(diagnostic) + chunk.length > 65536) {
      overflow = true;
      return;
    }
    diagnostic += chunk.toString("utf8");
  });
  const terminal = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const client = new Client(child, true);
  let closing: Promise<GoChatResponsesReceipt> | undefined;
  const close = (): Promise<GoChatResponsesReceipt> =>
    (closing ??= (async () => {
      await client.close();
      const ended = await terminal;
      if (ended.code !== 0 || ended.signal !== null || overflow)
        throw new Error("fixture_original_terminal_not_clean");
      const prefix = "FAROL_CHAT_RESPONSES_CPU ";
      const lines = diagnostic
        .split("\n")
        .filter((line) => line.startsWith(prefix));
      if (lines.length !== 1)
        throw new Error("fixture_receipt_missing_or_repeated");
      const result = receiptSchema.parse(
        JSON.parse(lines[0]!.slice(prefix.length)),
      );
      if (result.scenario !== scenario)
        throw new Error("fixture_scenario_crossed");
      await rm(directory, { recursive: true });
      return result;
    })());
  try {
    await client.handshake(
      {
        protocolMajor: 1,
        protocolMinor: 0,
        buildId: "chat-responses-cpu",
        profileId: "profile",
      },
      3000,
    );
  } catch (error) {
    await close();
    throw error;
  }
  const tools = scenario === "tool";
  const selection: BrowserSelection = {
    provider: "farol",
    alias: "chatgpt",
    accountId: "controlled-account",
    modelId: "controlled-model",
    effort: "low",
    mode: "standard",
    toolsEnabled: tools,
    connectorId: tools ? "connector" : "",
    connectorGrantId: tools ? "grant" : "",
  };
  return {
    client,
    chat: new ChatBridge(client),
    caller: new ChatCallerBridge(client),
    close,
    selection,
    resolution: {
      requestedAlias: "chatgpt",
      requestedExecutor: "browser",
      requestedEffort: "low",
      requestedMode: "standard",
      configSHA256: "a".repeat(64),
      translationId: "configured",
      resolved: selection,
    },
    required: { model: true, effort: true, mode: true, connector: tools },
  };
}

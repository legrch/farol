import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchCodexAppServer } from "../src/apps/desktop/codex-app-server-process";
import { probeCodexHost } from "../src/apps/desktop/codex-host-probe";
import { runCodexChatGptHostRoute } from "../src/apps/desktop/codex-chatgpt-host-route";
import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
} from "../src/apps/desktop/codex-chatgpt-provider";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const executablePath = argument("--codex");
const codexHomePath = argument("--codex-home");
if (
  executablePath === null ||
  !path.isAbsolute(executablePath) ||
  executablePath.includes("\0") ||
  (codexHomePath !== null &&
    (!path.isAbsolute(codexHomePath) || codexHomePath.includes("\0")))
) {
  throw new Error(
    "usage: probe-codex-chatgpt-route.mjs --codex /absolute/path [--codex-home /absolute/path]",
  );
}

const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-next-route-b-native-"),
);
const privateHome = path.join(scratch, "home");
const runtimeRoot = path.join(scratch, "runtime");
await fs.mkdir(privateHome, { recursive: true, mode: 0o700 });
await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
let toolCount = 0;
let toolCatalogueSha256 = "";
const conversation: CodexChatGptConversation = {
  run: async (input, observer) => {
    toolCount = input.tools.length;
    if (toolCount < 1) {
      throw new Error("CODEX_CHATGPT_NATIVE_TOOL_CATALOGUE_MISSING");
    }
    toolCatalogueSha256 = createHash("sha256")
      .update(JSON.stringify(input.tools))
      .digest("hex");
    const parts = ["FAROL", "_NEXT_ROUTE_", "B_OK"];
    let text = "";
    for (const [index, delta] of parts.entries()) {
      text += delta;
      await observer.onTextDelta({
        sequence: index + 1,
        delta,
        text,
        observedCharacters: text.length,
      });
    }
    return {
      state: "completed",
      code: null,
      outputText: text,
      observedProvider: "deterministic-native-local",
      observedModel: null,
      observedMode: null,
    };
  },
};

const token = randomBytes(32).toString("base64url");
const provider = await startCodexChatGptProvider({
  model: "farol-next/mind",
  token,
  conversation,
});
let client: Awaited<ReturnType<typeof launchCodexAppServer>> | null = null;

try {
  const host = await probeCodexHost({
    executablePath,
    scratchRoot: path.join(scratch, "probe"),
  });
  client = await launchCodexAppServer({
    executablePath,
    cwd: runtimeRoot,
    homePath: privateHome,
    tempPath: os.tmpdir(),
    clientVersion: "0.1.0-preview.0",
    ...(codexHomePath ? { codexHomePath } : {}),
    providerRoute: {
      baseUrl: `${provider.baseUrl}/v1`,
      token,
    },
  });
  const listed = (await client.request("model/list", { limit: 100 })) as {
    data?: unknown[];
  };
  let result;
  try {
    result = await runCodexChatGptHostRoute(client, {
      model: "farol-next/mind",
      cwd: runtimeRoot,
      prompt: "Return the exact fixed marker FAROL_NEXT_ROUTE_B_OK.",
      timeoutMs: 30_000,
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        stage: "native-host-route",
        listedModels: Array.isArray(listed.data) ? listed.data.length : null,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        boundary: "deterministic-native-local",
        host: {
          version: host.version,
          executableSha256: host.executableSha256,
          schemaSha256: host.schemaSha256,
        },
        ...result,
        toolCount,
        toolCatalogueSha256,
        provider: provider.diagnostics(),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await provider.close().catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true });
}

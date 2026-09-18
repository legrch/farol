import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchCodexAppServer } from "../src/apps/desktop/codex-app-server-process";
import { compactCodexHostThread } from "../src/apps/desktop/codex-host-compaction";
import { probeCodexHost } from "../src/apps/desktop/codex-host-probe";
import {
  continueCodexChatGptHostThread,
  runCodexChatGptHostRoute,
} from "../src/apps/desktop/codex-chatgpt-host-route";
import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
} from "../src/apps/desktop/codex-chatgpt-provider";
import { PrivateProviderTurnJournal } from "../src/apps/desktop/provider-turn-journal";
import { createCodexContextController } from "../src/apps/desktop/codex-context-runtime";
import type { ContextBinding } from "../src/modules/chat/domain/context-continuity";

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
const contextRoot = path.join(scratch, "context");
await fs.mkdir(privateHome, { recursive: true, mode: 0o700 });
await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
let toolCount = 0;
let toolCatalogueSha256 = "";
let toolNames: string[] = [];
let nativeToolRoundTrips = 0;
let nativeToolOutputSha256 = "";
let nativeToolErrorCode: string | null = null;
let summarySubmissions = 0;
let summaryResets = 0;
let summaryConversationUrl: string | null =
  "https://chatgpt.com/c/farol-next-native-context";
const checkpointContent = {
  goal: "Preserve the deterministic native context route.",
  activeConstraints: ["No paid or external provider fallback."],
  latestCorrections: ["Continue on the exact compacted native thread."],
  keyDecisions: ["Use ordinary one-cycle context compaction."],
  completedWork: [
    {
      description: "The initial native-local provider turn completed.",
      evidenceRefs: ["receipt:native-route-initial"],
    },
  ],
  unfinishedWork: ["Confirm the first post-compaction continuation."],
  unresolvedQuestions: [],
  unknownOutcomes: [
    {
      operationRef: "operation:external-not-run",
      description: "No external provider action was attempted.",
    },
  ],
  artifactRefs: [
    { reference: "artifact:native-route-probe", availability: "available" },
  ],
  attachmentRefs: [
    { reference: "attachment:not-provided", availability: "unavailable" },
  ],
  nextSafeStep: "Continue the same native thread once.",
} as const;
const summaryRoute = {
  runReadonlyTask: async () => {
    summarySubmissions += 1;
    const outputText = JSON.stringify(checkpointContent);
    return {
      state: "completed" as const,
      code: null,
      deltaCount: 1,
      observedCharacters: outputText.length,
      outputText,
    };
  },
  currentConversationUrl: () => summaryConversationUrl,
  retainedConversationUrl: () => summaryConversationUrl,
  resetConversation: () => {
    summaryResets += 1;
    summaryConversationUrl = null;
  },
  dispose: () => {
    summaryConversationUrl = null;
  },
};
const context = createCodexContextController({
  ownerId: "owner-native-route-probe",
  providerProfileId: "profile-native-route-probe",
  stateRoot: contextRoot,
  summaryRoutes: {
    retained: () => summaryRoute,
    createFallback: () => {
      throw new Error("NATIVE_ROUTE_FALLBACK_UNEXPECTED");
    },
  },
});
const conversation: CodexChatGptConversation = {
  run: async (input, observer) => {
    toolCount = input.tools.length;
    if (toolCount < 1) {
      throw new Error("CODEX_CHATGPT_NATIVE_TOOL_CATALOGUE_MISSING");
    }
    toolCatalogueSha256 = createHash("sha256")
      .update(JSON.stringify(input.tools))
      .digest("hex");
    toolNames = input.tools.flatMap((tool) => {
      if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
        return [];
      }
      const name = (tool as { name?: unknown }).name;
      const type = (tool as { type?: unknown }).type;
      return typeof name === "string" && typeof type === "string"
        ? [`${type}:${name}`]
        : [];
    });
    const nativeTool = input.tools.find(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        !Array.isArray(tool) &&
        (tool as { type?: unknown }).type === "function" &&
        (tool as { name?: unknown }).name === "get_goal",
    );
    if (!nativeTool) {
      throw new Error("CODEX_CHATGPT_NATIVE_GOAL_TOOL_MISSING");
    }
    let nativeOutput: string;
    try {
      nativeOutput = await observer.onToolCall({
        name: "get_goal",
        arguments: {},
      });
    } catch (error) {
      nativeToolErrorCode =
        error instanceof Error ? error.message : "NATIVE_TOOL_REQUEST_FAILED";
      throw error;
    }
    if (nativeOutput.trim().length === 0) {
      throw new Error("CODEX_CHATGPT_NATIVE_TOOL_RESULT_INVALID");
    }
    nativeToolRoundTrips += 1;
    nativeToolOutputSha256 = createHash("sha256")
      .update(nativeOutput)
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
  compaction: context.continuity,
  turns: new PrivateProviderTurnJournal({
    root: path.join(scratch, "provider-turns"),
  }),
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
        toolNames,
        nativeToolErrorCode,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw error;
  }
  let compacted;
  try {
    compacted = await compactCodexHostThread(client, {
      threadId: result.threadId,
      timeoutMs: 30_000,
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        stage: "native-host-compaction",
        error: error instanceof Error ? error.message : "UNKNOWN",
        summarySubmissions,
        summaryResets,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw error;
  }
  const confirmed = await context.continuity.confirmHostCompaction({
    modelId: "farol-next/mind",
    ...compacted,
  });
  if (!confirmed.ok) {
    process.stderr.write(
      `${JSON.stringify({
        stage: "native-host-confirmation",
        error: confirmed.error.code,
        compaction: compacted,
        summarySubmissions,
        summaryResets,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw new Error(confirmed.error.code);
  }
  let continuation;
  try {
    continuation = await continueCodexChatGptHostThread(client, {
      model: "farol-next/mind",
      threadId: result.threadId,
      prompt: "Continue after compaction and return FAROL_NEXT_ROUTE_B_OK.",
      timeoutMs: 30_000,
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        stage: "native-host-continuation",
        error: error instanceof Error ? error.message : "UNKNOWN",
        compaction: compacted,
        summarySubmissions,
        summaryResets,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw error;
  }
  const contextBinding: ContextBinding = {
    ownerId: "owner-native-route-probe",
    taskId: result.threadId,
    hostThreadId: result.threadId,
    sessionId: result.threadId,
    providerProfileId: "profile-native-route-probe",
    modelId: "farol-next/mind",
    mode: "mind",
  };
  const contextSession = await context.store.load(contextBinding);
  if (
    !contextSession ||
    contextSession.phase !== "active" ||
    contextSession.epoch !== 2 ||
    contextSession.lastCompletedOperationId === null ||
    contextSession.lastCheckpointId === null ||
    summarySubmissions !== 1 ||
    summaryResets !== 1
  ) {
    process.stderr.write(
      `${JSON.stringify({
        stage: "native-context-state",
        context: contextSession
          ? {
              phase: contextSession.phase,
              epoch: contextSession.epoch,
              hasOperation: contextSession.operation !== null,
              hasCompletedOperation:
                contextSession.lastCompletedOperationId !== null,
              hasCheckpoint: contextSession.lastCheckpointId !== null,
            }
          : null,
        summarySubmissions,
        summaryResets,
        provider: provider.diagnostics(),
      })}\n`,
    );
    throw new Error("NATIVE_CONTEXT_CONTINUITY_NOT_CONFIRMED");
  }
  const retainedSource = await context.store.getSource(
    contextBinding,
    contextSession.lastCompletedOperationId,
  );
  if (retainedSource !== null) {
    throw new Error("NATIVE_CONTEXT_SOURCE_NOT_RETIRED");
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
        compaction: {
          ...compacted,
          nextTurnId: continuation.turnId,
          nextTurnDeltaCount: continuation.deltaCount,
          epoch: contextSession.epoch,
          phase: contextSession.phase,
          summarySubmissions,
          summaryResets,
          sourceRetired: true,
          checkpointSha256: createHash("sha256")
            .update(JSON.stringify(checkpointContent))
            .digest("hex"),
        },
        toolCount,
        toolCatalogueSha256,
        nativeToolRoundTrips,
        nativeToolOutputSha256,
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

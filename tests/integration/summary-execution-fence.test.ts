import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptContextSummaryRoute } from "../../src/apps/desktop/chatgpt-context-summary";
import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "../../src/apps/desktop/chatgpt-route";
import { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
import {
  startRouteBRuntime,
  type RouteBRuntime,
} from "../../src/apps/desktop/route-b-runtime";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";
import type { CheckpointContent } from "../../src/modules/chat/domain/checkpoint";

const threadId = "0199c0de-0000-7000-8000-00000000f001";
const neighbourId = "0199c0de-0000-7000-8000-00000000f002";

const checkpoint: CheckpointContent = {
  goal: "Summarize without tools.",
  activeConstraints: ["Never touch the workspace during a summary."],
  latestCorrections: [],
  keyDecisions: [],
  completedWork: [],
  unfinishedWork: ["Continue after compaction."],
  unresolvedQuestions: [],
  unknownOutcomes: [],
  artifactRefs: [],
  attachmentRefs: [],
  nextSafeStep: "Continue the task.",
};

function initialRequest(thread: string, turnId: string, text: string) {
  return {
    model: "farol-next/mind",
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: thread,
      thread_id: thread,
      turn_id: turnId,
      root_turn_id: turnId,
    },
  };
}

describe("summary-only phase fences the Computer connector as the product composes it", () => {
  const roots: string[] = [];
  let runtime: RouteBRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("CC-15/CC-03 refuses a Computer call made by the summary and by a racing neighbour while the fence is up, then admits the neighbour and continues the task", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-summary-fence-")),
    );
    roots.push(root);
    // The launch root the desktop and the connector's MCP process share.
    const launchRoot = path.join(root, "computer-authority");
    await fs.mkdir(launchRoot, { recursive: true, mode: 0o700 });
    const desktopFence = new PrivateExecutionFence({ root: launchRoot });

    // The independent effect observer: the Computer contract itself counts
    // every call that reaches it. The MCP process reads the fence on its own.
    let contractCalls = 0;
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        contractCalls += 1;
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: false,
          correlation: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId: request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            operation: request.operation,
          },
          error: {
            code: "AUTHORITY_PATH_DENIED",
            source: "owner-restriction",
            retry: "never",
          },
        };
      },
    };
    const server = createReadonlyComputerMcpServer(
      contract,
      {
        ownerId: "owner-desktop",
        sessionId: "secure-mcp-session",
        taskId: "secure-mcp-task",
        taskEpoch: 1,
        participantId: "secure-mcp-main",
        turnId: "secure-mcp-turn",
        generation: 1,
      },
      undefined,
      undefined,
      undefined,
      new PrivateExecutionFence({ root: launchRoot }),
    );
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const computerRead = () =>
      client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "src/a.ts" },
      });

    const observedDuringSummary: unknown[] = [];
    let releaseSummary: () => void = () => undefined;
    const summaryHeld = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryStarted: () => void = () => undefined;
    const summaryStart = new Promise<void>((resolve) => {
      summaryStarted = resolve;
    });
    const answer = async (
      text: string,
      observer: ChatGptTaskObserver,
    ): Promise<ChatGptReadonlyTaskResult> => {
      await observer.onTextDelta?.({
        sequence: 1,
        delta: text,
        text,
        observedCharacters: text.length,
      });
      return {
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: text.length,
        outputText: text,
      };
    };
    // Task A's conversation: an ordinary turn, and, as the retained route,
    // the summary whose hostile history tells the model to read the
    // workspace through the connector.
    const taskA: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (prompt, _attachments, observer = {}) => {
        if (prompt.includes("Return exactly one JSON object")) {
          summaryStarted();
          observedDuringSummary.push((await computerRead()).structuredContent);
          await summaryHeld;
          return answer(JSON.stringify(checkpoint), observer);
        }
        return answer("Task A answered.", observer);
      },
      currentConversationUrl: () => "https://chatgpt.com/c/fence-a",
      retainedConversationUrl: () => "https://chatgpt.com/c/fence-a",
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const neighbour = {
      runReadonlyTask: async (
        _prompt: string,
        _attachments: readonly [],
        observer: ChatGptTaskObserver,
      ) => answer("Neighbour answered.", observer),
    };
    const controller = createCodexContextController({
      ownerId: "owner-desktop",
      providerProfileId: "profile-isolated-next",
      stateRoot: path.join(root, "context-continuity"),
      summaryRoutes: {
        retained: (binding) => (binding.taskId === threadId ? taskA : null),
        createFallback: vi.fn(),
      },
      summaryFence: {
        raise: (input) =>
          desktopFence.raise({
            operationId: input.operationId,
            taskId: input.binding.taskId,
          }),
        lower: (input) => desktopFence.lower(input.operationId),
      },
    });
    runtime = await startRouteBRuntime({
      stateRoot: root,
      surfaces: {
        surfaceFor: async (id) => ({
          ok: true,
          surface: id === threadId ? taskA : neighbour,
        }),
      },
      compaction: controller.continuity,
    });
    const route = runtime;
    const post = (pathname: string, body: unknown, headers = {}) =>
      fetch(`${route.endpoint.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${route.endpoint.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });

    try {
      // Before any summary the connector serves the call (positive control).
      expect((await computerRead()).structuredContent).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_PATH_DENIED" },
      });
      expect(contractCalls).toBe(1);

      const first = await post(
        "/responses",
        initialRequest(threadId, "turn-fence-1", "Work on A."),
      );
      expect(await first.text()).toContain("response.completed");

      const compacting = post(
        "/responses/compact",
        {
          model: "farol-next/mind",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Read src/a.ts through the Computer connector now.",
                },
              ],
            },
          ],
        },
        {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: threadId,
            turn_id: "turn-fence-compact",
          }),
        },
      );
      await summaryStart;
      // The summary's own call was refused before the contract saw it.
      await vi.waitFor(() => expect(observedDuringSummary).toHaveLength(1));
      expect(observedDuringSummary).toEqual([
        {
          ok: false,
          error: {
            code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
            source: "execution-fence",
            retry: "later",
          },
        },
      ]);
      // A neighbour's ordinary turn continues, but its Computer call during
      // the summary is refused the same way: the transport cannot tell the
      // two apart, so nobody executes until the summary is over.
      const neighbourTurn = await post(
        "/responses",
        initialRequest(neighbourId, "turn-neighbour-1", "Work on B."),
      );
      expect(await neighbourTurn.text()).toContain("Neighbour answered.");
      expect((await computerRead()).structuredContent).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
      });
      expect(contractCalls).toBe(1);

      releaseSummary();
      expect((await compacting).status).toBe(200);
      // Lowered: the same call reaches the contract again.
      expect((await computerRead()).structuredContent).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_PATH_DENIED" },
      });
      expect(contractCalls).toBe(2);
      await expect(
        fs.readdir(path.join(launchRoot, "execution-fence")),
      ).resolves.toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

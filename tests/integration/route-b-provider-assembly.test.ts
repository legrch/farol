import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {} }));
const httpFixture = vi.hoisted(() => ({
  responses: [] as import("node:http").ServerResponse[],
}));
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();
  return {
    ...original,
    createServer: (...args: Parameters<typeof original.createServer>) => {
      const server = original.createServer(...args);
      server.on("request", (_request, response) =>
        httpFixture.responses.push(response),
      );
      return server;
    },
  };
});

import {
  ChatGptRoute,
  type ChatGptReadonlyTaskResult,
} from "../../src/apps/desktop/chatgpt-route";
import { chatGptTaskConversation } from "../../src/apps/desktop/route-b-runtime";
import { startCodexChatGptProvider } from "../../src/apps/desktop/codex-chatgpt-provider";
import { startCodexCallerRelay } from "../../src/apps/desktop/codex-caller-relay";
import { CodexCallerRelayClient } from "../../apps/desktop/computer-mcp/codex-caller-relay-client";
import type { ProviderTurnJournal } from "../../src/apps/desktop/provider-turn-journal";
import { CHATGPT_MODEL_ID } from "../../src/pkg/model-route/contract";

function journal(): ProviderTurnJournal {
  const intents = new Map<string, string>();
  return {
    admit: async (key, digest) => {
      const previous = intents.get(key);
      if (previous !== undefined)
        return previous === digest ? "replayed" : "conflict";
      intents.set(key, digest);
      return "admitted";
    },
    release: async (key) => {
      intents.delete(key);
    },
  };
}
function events(stream: string): Record<string, unknown>[] {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function output(stream: string, deltas: readonly string[]) {
  const wire = events(stream);
  const terminals = wire.filter((item) => item.type === "response.completed");
  expect(terminals).toHaveLength(1);
  expect(wire.at(-1)).toBe(terminals[0]);
  expect(wire.filter((item) => item.type === "response.failed")).toHaveLength(
    0,
  );
  const response = terminals[0]!.response as {
    id: string;
    status: string;
    output: Record<string, unknown>[];
  };
  expect(response.status).toBe("completed");
  const starts = wire.filter((item) => item.type === "response.created");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.response).toMatchObject({ id: response.id });
  const textDeltas = wire.filter(
    (item) => item.type === "response.output_text.delta",
  );
  expect(textDeltas.map((item) => item.delta)).toEqual(deltas);
  const message = response.output.find((item) => item.type === "message");
  expect(message).toBeDefined();
  const done = wire.filter((item) => item.type === "response.output_text.done");
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({
    item_id: message!.id,
    content_index: 0,
    text: deltas.join(""),
  });
  for (const delta of textDeltas) {
    expect(delta).toMatchObject({ item_id: message!.id, content_index: 0 });
    expect(wire.indexOf(delta)).toBeLessThan(wire.indexOf(done[0]!));
  }
  return response.output;
}
function messageText(items: Record<string, unknown>[]) {
  return items
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content as { type: string; text: string }[])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

// Real route/admission/adapter/provider/relay code, controlled page answers and
// disposable local transports. No Electron window/account/Send/tool execution.
async function assembly(
  options: {
    startProvider?: typeof startCodexChatGptProvider;
    beforeContinuation?: () => void;
    onRelayStarted?: (
      root: string,
      relay: Awaited<ReturnType<typeof startCodexCallerRelay>>,
    ) => void;
  } = {},
) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-assembly-"));
  const progress = {
    toolInvoke: null as Promise<unknown> | null,
    routeOutcome: null as Promise<ChatGptReadonlyTaskResult> | null,
  };
  let ownedRelay: Awaited<ReturnType<typeof startCodexCallerRelay>> | null =
    null;
  let ownedProvider: Awaited<
    ReturnType<typeof startCodexChatGptProvider>
  > | null = null;
  let originalFailure = false;
  try {
    root = await fs.realpath(root);
    await fs.chmod(root, 0o700);
    const relay = await startCodexCallerRelay({ root });
    ownedRelay = relay;
    options.onRelayStarted?.(root, relay);
    const client = new CodexCallerRelayClient(relay.endpoint);
    const prefix = "Committed prefix.";
    const tail = " Exact fixture tool result.";
    let text = prefix;
    let finished = false;
    let sends = 0;
    let runs = 0;

    const settle = vi.fn();
    const route = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      taskPollMs: 1,
      taskTimeoutMs: 5_000,
    });
    vi.spyOn(route, "open").mockResolvedValue({ status: "opened" });
    const execute = vi.fn(async (script: string) => {
      if (script.includes("return { composerVisible: composer, signInVisible:"))
        return { composerVisible: true, signInVisible: false };
      if (script.includes("const running = [")) return { running: false };
      if (script.includes("const baselineAssistantCount"))
        return {
          ready: true,
          baselineAssistantCount: 0,
          baselineUserCount: 0,
          baselineMessageIds: [],
        };
      if (script.includes("send.click()")) {
        sends += 1;
        return { activated: true };
      }
      return {
        assistantCount: 1,
        assistantCharacters: text.length,
        assistantText: text,
        userCount: 1,
        turnUserId: "fixture-user",
        turnAssistantId: "fixture-assistant",
        busy: !finished,
        sendVisible: finished,
        signInVisible: false,
        errorVisible: false,
      };
    });
    Reflect.set(route, "load", "loaded");
    Reflect.set(route, "routeWindow", {
      isDestroyed: () => false,
      webContents: {
        getURL: () => "https://chatgpt.com/c/fixture-assembly",
        executeJavaScript: execute,
      },
    });
    const identity = {
      session_id: "fixture-session",
      thread_id: "fixture-thread",
      turn_id: "fixture-turn",
      root_turn_id: "fixture-turn",
    };
    const conversation = chatGptTaskConversation(
      {
        surfaceFor: async (threadId) => {
          expect(threadId).toBe(identity.thread_id);
          return {
            ok: true,
            surface: {
              runReadonlyTask: (prompt, attachments, observer) => {
                runs += 1;
                const ticket =
                  /with ticket ([a-f0-9]{64}) and binding ([a-f0-9]{64})/u.exec(
                    prompt,
                  );
                expect(ticket).not.toBeNull();
                progress.routeOutcome = route.runReadonlyTask(
                  prompt,
                  attachments,
                  {
                    ...observer,
                    onTextDelta: async (delta) => {
                      await observer.onTextDelta?.(delta);
                      if (!progress.toolInvoke) {
                        progress.toolInvoke = client
                          .request({
                            operation: "invoke",
                            ticket: ticket![1]!,
                            binding: ticket![2]!,
                            operationId: "fixture-invoke",
                            name: "exec_command",
                            namespace: null,
                            arguments: { cmd: "printf FIXTURE_ONLY" },
                          })
                          .then((result) => {
                            expect(result).toMatchObject({
                              ok: true,
                              operation: "invoke",
                              output: "FIXTURE_ONLY",
                            });
                            text = prefix + tail;
                            finished = true;
                            return result;
                          });
                        // Attach immediately while retaining the original promise
                        // for the positive assertions and awaited teardown.
                        void progress.toolInvoke.catch(() => undefined);
                      }
                    },
                  },
                );
                return progress.routeOutcome;
              },
            },
          };
        },
        settled: settle,
      },
      relay,
    );
    const token = "assembly-fixture-only";
    const provider = await (options.startProvider ?? startCodexChatGptProvider)(
      {
        model: CHATGPT_MODEL_ID,
        token,
        conversation,
        turns: journal(),
      },
    );
    ownedProvider = provider;
    const post = (body: unknown) =>
      fetch(provider.baseUrl + "/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    const initial = {
      model: CHATGPT_MODEL_ID,
      stream: true,
      store: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Read the synthetic tool result." },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Fixture only; never executes a command.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      client_metadata: identity,
    };
    const first = await (await post(initial)).text();
    const firstItems = output(first, [prefix]);
    const call = firstItems.find((item) => item.type === "function_call");
    expect(call).toMatchObject({
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf FIXTURE_ONLY" }),
    });
    expect(messageText(firstItems)).toBe(prefix);
    options.beforeContinuation?.();
    const continuation = {
      ...initial,
      tools: [],
      input: [
        call,
        {
          type: "function_call_output",
          call_id: call!.call_id,
          output: "FIXTURE_ONLY",
        },
      ],
    };
    const foreign = await post({
      ...continuation,
      client_metadata: {
        ...identity,
        turn_id: "foreign",
        root_turn_id: "foreign",
      },
    });
    expect(foreign.status).toBe(409);
    await expect(foreign.json()).resolves.toEqual({
      error: { code: "FAROL_CONTINUATION_FOREIGN" },
    });
    expect(finished).toBe(false);
    expect(sends).toBe(1);
    const last = await (await post(continuation)).text();
    const lastItems = output(last, [tail]);
    expect(messageText(lastItems)).toBe(tail);
    expect(messageText(firstItems) + messageText(lastItems)).toBe(
      prefix + tail,
    );
    await progress.toolInvoke;
    await expect(progress.routeOutcome).resolves.toMatchObject({
      state: "completed",
      outputText: prefix + tail,
      deltaCount: 2,
    });
    const repeated = await post(continuation);
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toEqual({
      error: { code: "FAROL_CONTINUATION_NOT_FOUND" },
    });
    expect(runs).toBe(1);
    expect(sends).toBe(1);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      identity.thread_id,
      "completed",
    );
    expect(provider.diagnostics()).toMatchObject({
      activeTurns: 0,
      toolCalls: 1,
      responseRequests: 4,
    });
    // A new logical fixture turn loses its HTTP stream after the committed
    // prefix. This does not authorize a repeated initial request/second Send.
    text = prefix;
    finished = false;
    const lostBody = {
      ...initial,
      client_metadata: {
        ...identity,
        turn_id: "fixture-loss",
        root_turn_id: "fixture-loss",
      },
    };
    const controller = new AbortController();
    const lost = await fetch(provider.baseUrl + "/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(lostBody),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    });
    const reader = lost.body!.getReader();
    const decoder = new TextDecoder();
    let observed = "";
    while (!observed.includes('"type":"response.output_text.delta"')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      observed += decoder.decode(chunk.value, { stream: true });
    }
    expect(observed).toContain(prefix);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    // Public ServerResponse state proves the actual owned server side is
    // destroyed before the controlled page produces further output.
    await vi.waitFor(() =>
      expect(httpFixture.responses.at(-1)?.destroyed).toBe(true),
    );
    text = prefix + tail;
    finished = true;
    await expect(progress.routeOutcome).resolves.toMatchObject({
      state: "outcome_unknown",
    });
    await vi.waitFor(() => expect(provider.diagnostics().activeTurns).toBe(0));
    const replay = await post(lostBody);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      error: { code: "FAROL_TURN_ALREADY_SUBMITTED" },
    });
    expect(runs).toBe(2);
    expect(sends).toBe(2);
    expect(settle).toHaveBeenLastCalledWith(
      identity.thread_id,
      "outcome_unknown",
    );
    expect(provider.diagnostics()).toMatchObject({
      activeTurns: 0,
      toolCalls: 1,
      responseRequests: 6,
    });
  } catch (error) {
    originalFailure = true;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await cleanup(async () => {
      await ownedProvider?.close();
    });
    await cleanup(async () => {
      await progress.routeOutcome?.catch(() => undefined);
    });
    await cleanup(async () => {
      await progress.toolInvoke?.catch(() => undefined);
    });
    await cleanup(async () => {
      await ownedRelay?.close();
    });
    await cleanup(() => fs.rm(root, { recursive: true, force: true }));
    vi.restoreAllMocks();
    if (cleanupErrors.length > 0) {
      if (!originalFailure)
        throw new AggregateError(
          cleanupErrors,
          "ASSEMBLY_FIXTURE_CLEANUP_FAILED",
        );
      console.error(
        "ASSEMBLY_FIXTURE_CLEANUP_FAILED_AFTER_ORIGINAL_ASSERTION",
        cleanupErrors,
      );
    }
  }
}

it("assembles exact tool continuation and proven host-loss refusal without another route Send", async () => {
  await assembly();
});

it("closes the started relay and removes its owned root when provider setup rejects", async () => {
  const failure = new Error("INJECTED_ASSEMBLY_PROVIDER_SETUP_FAILURE");
  const roots: string[] = [];
  let completedRelayCloses = 0;
  const startProvider: typeof startCodexChatGptProvider = vi.fn(async () => {
    const root = roots[0]!;
    expect(
      (await fs.lstat(path.join(root, "caller-relay.sock"))).isSocket(),
    ).toBe(true);
    throw failure;
  });
  await expect(
    assembly({
      startProvider,
      onRelayStarted: (root, relay) => {
        roots.push(root);
        const close = relay.close;
        vi.spyOn(relay, "close").mockImplementation(async () => {
          await close();
          completedRelayCloses += 1;
        });
      },
    }),
  ).rejects.toBe(failure);
  expect(startProvider).toHaveBeenCalledTimes(1);
  expect(roots).toHaveLength(1);
  expect(completedRelayCloses).toBe(1);
  await expect(fs.stat(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains a pre-continuation assertion while cancelling its pending relay invoke", async () => {
  const failure = new Error("INJECTED_ASSEMBLY_PRE_CONTINUATION_ASSERTION");
  const roots: string[] = [];
  let completedRelayCloses = 0;
  await expect(
    assembly({
      beforeContinuation: () => {
        throw failure;
      },
      onRelayStarted: (root, relay) => {
        roots.push(root);
        const close = relay.close;
        vi.spyOn(relay, "close").mockImplementation(async () => {
          await close();
          completedRelayCloses += 1;
        });
      },
    }),
  ).rejects.toBe(failure);
  expect(completedRelayCloses).toBe(1);
  expect(roots).toHaveLength(1);
  await expect(fs.stat(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

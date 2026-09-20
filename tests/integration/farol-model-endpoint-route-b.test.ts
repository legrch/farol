// Packet N04c (Decisions.md, run farol-local-completion-0919): the Farol
// Model endpoint answers from the product's real chat-turn route — the
// already-running Route B provider (`startRouteBRuntime`) — instead of the
// `unavailableHandler` left by N04b. These tests compose a real
// `RouteBRuntime` exactly as `route-b-runtime.test.ts` does (synthetic
// `RouteBTaskSurfaces`/`RouteBConversationSurface` and a real
// `startCodexCallerRelay`, never a live ChatGPT account or Codex), point a
// real `FarolModelEndpoint` at it through `routeBModelTurnHandler`, and
// drive every request through the endpoint's own loopback HTTP surface —
// proving the endpoint, not just the runtime underneath it. Every request
// body is the shape an ordinary Codex sends, including the Route B model.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptContextSummaryRoute } from "../../src/apps/desktop/chatgpt-context-summary";
import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "../../src/apps/desktop/chatgpt-route";
import { CodexCallerRelayClient } from "../../src/apps/computer-mcp/codex-caller-relay-client";
import {
  startCodexCallerRelay,
  type CodexCallerRelayRuntime,
} from "../../src/apps/desktop/codex-caller-relay";
import { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
import {
  FarolModelEndpoint,
  routeBModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";
import {
  ROUTE_B_MODEL,
  startRouteBRuntime,
  type RouteBRuntime,
  type RouteBTaskSurfaces,
} from "../../src/apps/desktop/route-b-runtime";

const threadId = "0199c0de-0000-7000-8000-00000000e001";

const roots: string[] = [];
let runtime: RouteBRuntime | null = null;
let endpoint: FarolModelEndpoint | null = null;
let relayHandle: CodexCallerRelayRuntime | null = null;

afterEach(async () => {
  await endpoint?.stop();
  endpoint = null;
  await runtime?.close();
  runtime = null;
  await relayHandle?.close();
  relayHandle = null;
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  roots.push(root);
  return root;
}

// The relay's Unix socket path must stay under `codex-caller-relay.ts`'s
// 100-byte limit. `os.tmpdir()` alone can already spend 50-90+ bytes on
// macOS (`/private/var/folders/<xx>/<per-user random>/T`), so anchoring the
// relay's root there via `tempRoot()` — whose descriptive prefix and
// `mkdtemp`'s random suffix add more on top — pushes the socket path over
// the limit depending only on how long the environment's per-user temp
// directory happens to be, not on anything this test is proving. Anchor the
// relay's root in a short, fixed system directory instead, decoupled from
// TMPDIR/os.tmpdir(), so the outcome does not depend on the environment.
async function relaySocketRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/tmp", "fr-")));
  roots.push(root);
  return root;
}

async function compose(
  surfaces: RouteBTaskSurfaces,
  task: ChatGptContextSummaryRoute,
  relay?: CodexCallerRelayRuntime,
): Promise<RouteBRuntime> {
  const root = await tempRoot("farol-model-endpoint-route-b-");
  const controller = createCodexContextController({
    ownerId: "owner-desktop",
    providerProfileId: "profile-isolated-next",
    stateRoot: path.join(root, "context-continuity"),
    summaryRoutes: {
      retained: (binding) => (binding.taskId === threadId ? task : null),
      createFallback: vi.fn(),
    },
  });
  runtime = await startRouteBRuntime({
    stateRoot: root,
    surfaces,
    compaction: controller.continuity,
    ...(relay ? { relay } : {}),
  });
  return runtime;
}

/** Starts the Farol Model Endpoint pointed at the given runtime's provider. */
async function startEndpoint(
  route: RouteBRuntime,
): Promise<{ endpoint: FarolModelEndpoint; port: number; token: string }> {
  const state = new FarolModelRuntimeState(
    path.join(await tempRoot("farol-model-endpoint-state-"), "model-endpoint"),
  );
  endpoint = new FarolModelEndpoint({
    state,
    model: ROUTE_B_MODEL,
    handler: routeBModelTurnHandler(() => route.endpoint),
  });
  const { port } = await endpoint.start();
  const token = await state.currentToken();
  if (!token) throw new Error("FAROL_MODEL_TOKEN_MISSING_IN_TEST");
  return { endpoint, port, token };
}

function postToEndpoint(
  port: number,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** Exactly what an ordinary Codex sends: the Route B model, streamed, unstored. */
function initialRequest(
  turnId: string,
  text: string,
  tools: unknown[] = [],
  input: unknown[] = [],
) {
  return {
    model: ROUTE_B_MODEL,
    stream: true,
    store: false,
    input: [
      ...input,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools,
    client_metadata: {
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
      root_turn_id: turnId,
    },
  };
}

async function extractEvents(
  response: Response,
): Promise<{ event: string; data: unknown }[]> {
  const text = await response.text();
  const events: { event: string; data: unknown }[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    const eventLine = block
      .split("\n")
      .find((line) => line.startsWith("event: "));
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }
  return events;
}

/**
 * The provider's internal route token is the endpoint's own credential
 * toward Route B; it must never appear in what a caller receives nor in
 * the evidence the owner's UI reads.
 */
function expectNoRouteTokenLeak(
  route: RouteBRuntime,
  served: FarolModelEndpoint,
  ...payloads: readonly string[]
): void {
  const internal = route.endpoint.token;
  expect(internal.length).toBeGreaterThan(0);
  for (const payload of payloads) expect(payload).not.toContain(internal);
  expect(JSON.stringify(served.evidence())).not.toContain(internal);
}

describe("Farol Model endpoint dispatches through the real Route B provider (packet N04c)", () => {
  it("carries one real tool roundtrip: the route calls a host tool and the endpoint's answer carries its result", async () => {
    relayHandle = await startCodexCallerRelay({
      root: await relaySocketRoot(),
    });
    const client = new CodexCallerRelayClient(relayHandle.endpoint);
    const invocations: unknown[] = [];
    const task: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (
        prompt: string,
        _attachments: readonly unknown[] = [],
        observer: ChatGptTaskObserver = {},
      ): Promise<ChatGptReadonlyTaskResult> => {
        const ticket =
          /with ticket ([a-f0-9]{64}) and binding ([a-f0-9]{64})/u.exec(prompt);
        if (!ticket) throw new Error("TICKET_MISSING");
        const invoked = await client.request({
          operation: "invoke",
          ticket: ticket[1]!,
          binding: ticket[2]!,
          operationId: "endpoint-operation-1",
          name: "add_numbers",
          namespace: null,
          arguments: { a: 2, b: 3 },
        });
        invocations.push(invoked);
        const text =
          invoked.ok && invoked.operation === "invoke"
            ? `Sum is ${invoked.output}.`
            : "No tool result.";
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
      },
      currentConversationUrl: () => "https://chatgpt.com/c/route-b-endpoint",
      retainedConversationUrl: () => "https://chatgpt.com/c/route-b-endpoint",
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const route = await compose(
      { surfaceFor: async () => ({ ok: true, surface: task }) },
      task,
      relayHandle,
    );
    // The tool that "performs" the roundtrip: the host (in production, an
    // external Codex CLI reached through this same endpoint) advertises it,
    // and executes it itself once ChatGPT's page calls the connector.
    const tools = [
      {
        type: "function",
        name: "add_numbers",
        description: "Add two numbers and return their sum as a string.",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        strict: true,
      },
    ];
    const { endpoint: served, port, token } = await startEndpoint(route);
    const initial = initialRequest("turn-endpoint-tool", "Add 2 and 3.", tools);

    const first = await postToEndpoint(port, token, initial);
    expect(first.status).toBe(200);
    const firstStream = await first.text();
    const call =
      /"type":"function_call"[^}]*"call_id":"(farol_next_call_[a-f0-9]{32})"/u.exec(
        firstStream,
      );
    expect(call).not.toBeNull();
    expect(firstStream).toContain('\\"a\\":2');
    expect(firstStream).toContain('\\"b\\":3');
    const completedItem = JSON.parse(
      firstStream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .find((line) => line.includes('"response.completed"')) ?? "{}",
    ) as { response: { output: Readonly<Record<string, unknown>>[] } };
    const toolCallItem = completedItem.response.output[0];

    // The endpoint's second, ordinary request delivers the executed tool's
    // real output back — this is "one tool roundtrip", not a text echo.
    const continued = await postToEndpoint(port, token, {
      ...initial,
      tools: [],
      input: [
        toolCallItem,
        {
          type: "function_call_output",
          call_id: call?.[1],
          output: "5",
        },
      ],
    });
    expect(continued.status).toBe(200);
    const finalStream = await continued.text();
    expect(finalStream).toContain("Sum is 5.");
    expect(finalStream).toContain("response.completed");
    expect(invocations).toEqual([
      {
        ok: true,
        operation: "invoke",
        operationId: "endpoint-operation-1",
        output: "5",
      },
    ]);
    expectNoRouteTokenLeak(route, served, firstStream, finalStream);
  });

  it("refuses a second turn on the same thread while the first is admitted, with no queued second submission", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runs = 0;
    const task: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (
        _prompt,
        _attachments = [],
        observer: ChatGptTaskObserver = {},
      ): Promise<ChatGptReadonlyTaskResult> => {
        runs += 1;
        await gate;
        const text = "First turn finished.";
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
      },
      currentConversationUrl: () => "https://chatgpt.com/c/route-b-busy",
      retainedConversationUrl: () => "https://chatgpt.com/c/route-b-busy",
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const route = await compose(
      { surfaceFor: async () => ({ ok: true, surface: task }) },
      task,
    );
    const { endpoint: served, port, token } = await startEndpoint(route);

    const running = postToEndpoint(
      port,
      token,
      initialRequest("turn-busy-1", "Hold the thread."),
    );
    await vi.waitFor(() => expect(route.owns(threadId)).toBe(true));

    // A second, distinct turn on the exact same thread while the first is
    // admitted: refused with a distinct code, never a second submission.
    const second = await postToEndpoint(
      port,
      token,
      initialRequest("turn-busy-2", "A different request on the same thread."),
    );
    expect(second.status).toBe(200);
    const secondText = await second.clone().text();
    const secondEvents = await extractEvents(second);
    const secondFailure = secondEvents.find(
      (event) => event.event === "response.failed",
    );
    expect(secondFailure?.data).toMatchObject({
      response: { error: { code: "ROUTE_B_THREAD_BUSY" } },
    });
    expect(runs).toBe(1);

    releaseFirst();
    const firstResponse = await running;
    expect(firstResponse.status).toBe(200);
    const firstText = await firstResponse.text();
    expect(firstText).toContain("First turn finished.");
    expect(route.owns(threadId)).toBe(false);
    expectNoRouteTokenLeak(route, served, firstText, secondText);
  });

  it("surfaces an interrupted turn as unknown through the endpoint, with no retry", async () => {
    let attempts = 0;
    const task: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (): Promise<ChatGptReadonlyTaskResult> => {
        attempts += 1;
        throw new Error("SYNTHETIC_PAGE_INTERRUPTED");
      },
      currentConversationUrl: () => "https://chatgpt.com/c/route-b-unknown",
      retainedConversationUrl: () => "https://chatgpt.com/c/route-b-unknown",
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const route = await compose(
      { surfaceFor: async () => ({ ok: true, surface: task }) },
      task,
    );
    const { endpoint: served, port, token } = await startEndpoint(route);

    const response = await postToEndpoint(
      port,
      token,
      initialRequest("turn-unknown-1", "This turn gets interrupted."),
    );
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const events = await extractEvents(response);
    const failure = events.find((event) => event.event === "response.failed");
    expect(failure?.data).toMatchObject({
      response: { error: { code: "CHATGPT_TASK_ERROR" } },
    });
    expect(events.some((event) => event.event === "response.completed")).toBe(
      false,
    );
    // Exactly one attempt: the endpoint never retries an unknown outcome.
    expect(attempts).toBe(1);
    expectNoRouteTokenLeak(route, served, text);
  });

  it("answers FAROL_MODEL_ROUTE_UNAVAILABLE when no Route B runtime is running yet", async () => {
    const state = new FarolModelRuntimeState(
      path.join(
        await tempRoot("farol-model-endpoint-unwired-"),
        "model-endpoint",
      ),
    );
    endpoint = new FarolModelEndpoint({
      state,
      model: ROUTE_B_MODEL,
      handler: routeBModelTurnHandler(() => null),
    });
    const { port } = await endpoint.start();
    const token = await state.currentToken();
    if (!token) throw new Error("FAROL_MODEL_TOKEN_MISSING_IN_TEST");

    const response = await postToEndpoint(
      port,
      token,
      initialRequest("turn-unwired-1", "Nothing is wired yet."),
    );
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("FAROL_MODEL_ROUTE_UNAVAILABLE");
  });

  it("refuses a request for any model but the Route B model before it reaches the provider", async () => {
    let runs = 0;
    const task: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (): Promise<ChatGptReadonlyTaskResult> => {
        runs += 1;
        return {
          state: "completed",
          code: null,
          deltaCount: 0,
          observedCharacters: 0,
          outputText: "",
        };
      },
      currentConversationUrl: () => null,
      retainedConversationUrl: () => null,
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const route = await compose(
      { surfaceFor: async () => ({ ok: true, surface: task }) },
      task,
    );
    const { endpoint: served, port, token } = await startEndpoint(route);

    const response = await postToEndpoint(port, token, {
      ...initialRequest("turn-wrong-model", "Hello."),
      model: "farol-model",
    });
    expect(response.status).toBe(422);
    const text = await response.text();
    const payload = JSON.parse(text) as {
      error: { code: string; expected_model: string };
    };
    expect(payload.error.code).toBe("FAROL_MODEL_MODEL_MISMATCH");
    expect(payload.error.expected_model).toBe(ROUTE_B_MODEL);
    expect(runs).toBe(0);
    expectNoRouteTokenLeak(route, served, text);
  });

  it("still refuses a missing token when wired to the real route", async () => {
    const task: ChatGptContextSummaryRoute = {
      runReadonlyTask: async (): Promise<ChatGptReadonlyTaskResult> => ({
        state: "completed",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      }),
      currentConversationUrl: () => null,
      retainedConversationUrl: () => null,
      resetConversation: () => undefined,
      dispose: () => undefined,
    };
    const route = await compose(
      { surfaceFor: async () => ({ ok: true, surface: task }) },
      task,
    );
    const { endpoint: served, port } = await startEndpoint(route);

    const missing = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initialRequest("turn-anonymous", "Hello.")),
    });
    expect(missing.status).toBe(401);
    const text = await missing.text();
    expect(text).not.toMatch(/farol/iu);
    expectNoRouteTokenLeak(route, served, text);
  });
});

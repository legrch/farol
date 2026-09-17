import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCodexCallerRelay,
  type CodexCallerRelayRuntime,
} from "../../src/apps/desktop/codex-caller-relay";
import { CodexCallerRelayClient } from "../../src/apps/computer-mcp/codex-caller-relay-client";

const command = {
  type: "function",
  name: "get_goal",
  description: "Read the current goal.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  strict: true,
} as const;

describe("Farol Next Codex caller relay", () => {
  let root: string | null = null;
  let runtime: CodexCallerRelayRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  async function start(now: () => number = () => Date.now()) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-relay-test-"));
    runtime = await startCodexCallerRelay({
      root,
      token: "relay-test-token-that-is-long-enough",
      now,
    });
    return runtime;
  }

  it("describes the exact frozen catalogue and invokes one operation at most once", async () => {
    const relay = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await gate;
      return '{"status":"active"}';
    });
    const turn = relay.openTurn({
      identity: {
        sessionId: "session-a",
        threadId: "thread-a",
        turnId: "turn-a",
        rootTurnId: "turn-a",
      },
      tools: [command, { type: "web_search", name: "search" }],
      invoke,
    });
    const client = new CodexCallerRelayClient(relay.endpoint);

    expect(turn.inventory).toEqual([{ name: "get_goal", namespace: null }]);
    await expect(
      client.request({
        operation: "describe",
        ticket: turn.ticket,
        binding: turn.binding,
      }),
    ).resolves.toMatchObject({
      ok: true,
      operation: "describe",
      catalogue: {
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        tools: [
          {
            name: "get_goal",
            namespace: null,
            description: "Read the current goal.",
            parameters: command.parameters,
          },
        ],
        unsupported: [{ type: "web_search", name: "search" }],
      },
    });

    const request = {
      operation: "invoke" as const,
      ticket: turn.ticket,
      binding: turn.binding,
      operationId: "operation-a",
      name: "get_goal",
      namespace: null,
      arguments: {},
    };
    const first = client.request(request);
    const duplicate = client.request(request);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    release();
    await expect(first).resolves.toEqual({
      ok: true,
      operation: "invoke",
      operationId: "operation-a",
      output: '{"status":"active"}',
    });
    await expect(duplicate).resolves.toEqual({
      ok: true,
      operation: "invoke",
      operationId: "operation-a",
      output: '{"status":"active"}',
    });
    await expect(client.request(request)).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses wrong-turn, changed, malformed, expired, and stale requests before execution", async () => {
    let now = 1_000;
    const relay = await start(() => now);
    const invoke = vi.fn(async () => "unused");
    const turn = relay.openTurn({
      identity: {
        sessionId: "session-a",
        threadId: "thread-a",
        turnId: "turn-a",
        rootTurnId: "turn-a",
      },
      tools: [command],
      invoke,
      lifetimeMs: 100,
    });
    const client = new CodexCallerRelayClient(relay.endpoint);

    await expect(
      client.request({
        operation: "invoke",
        ticket: turn.ticket,
        binding: "0".repeat(64),
        operationId: "wrong-turn",
        name: "get_goal",
        namespace: null,
        arguments: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_BINDING_INVALID", retry: "never" },
    });
    await expect(
      client.request({
        operation: "invoke",
        ticket: turn.ticket,
        binding: turn.binding,
        operationId: "malformed",
        name: "get_goal",
        namespace: null,
        arguments: { unexpected: true },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CODEX_TOOL_ARGUMENTS_INVALID", retry: "never" },
    });
    expect(invoke).not.toHaveBeenCalled();

    await expect(
      client.request({
        operation: "invoke",
        ticket: turn.ticket,
        binding: turn.binding,
        operationId: "same-id",
        name: "get_goal",
        namespace: null,
        arguments: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.request({
        operation: "invoke",
        ticket: turn.ticket,
        binding: turn.binding,
        operationId: "same-id",
        name: "get_goal",
        namespace: null,
        arguments: { changed: true },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_OPERATION_CHANGED", retry: "never" },
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    now = 1_101;
    await expect(
      client.request({
        operation: "describe",
        ticket: turn.ticket,
        binding: turn.binding,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_TICKET_EXPIRED", retry: "never" },
    });

    const fresh = relay.openTurn({
      identity: {
        sessionId: "session-b",
        threadId: "thread-b",
        turnId: "turn-b",
        rootTurnId: "turn-b",
      },
      tools: [command],
      invoke,
    });
    fresh.close();
    await expect(
      client.request({
        operation: "describe",
        ticket: fresh.ticket,
        binding: fresh.binding,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_TICKET_NOT_FOUND", retry: "never" },
    });
  });

  it("rejects a client without the private launch credential", async () => {
    const relay = await start();
    const client = new CodexCallerRelayClient({
      ...relay.endpoint,
      token: "different-private-token-that-is-long-enough",
    });

    await expect(
      client.request({
        operation: "describe",
        ticket: "a".repeat(64),
        binding: "b".repeat(64),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_UNAUTHORIZED", retry: "never" },
    });
  });

  it("fails closed for invalid options, unavailable sockets, and oversized requests", async () => {
    const relay = await start();
    expect(() => new CodexCallerRelayClient(relay.endpoint, 0)).toThrow(
      "CALLER_RELAY_CLIENT_OPTIONS_INVALID",
    );

    const unavailable = new CodexCallerRelayClient(
      {
        ...relay.endpoint,
        socketPath: path.join(root ?? "", "missing.sock"),
      },
      100,
    );
    await expect(
      unavailable.request({
        operation: "describe",
        ticket: "a".repeat(64),
        binding: "b".repeat(64),
      }),
    ).rejects.toThrow("CALLER_RELAY_UNAVAILABLE");

    const client = new CodexCallerRelayClient(relay.endpoint);
    await expect(
      client.request({
        operation: "invoke",
        ticket: "a".repeat(64),
        binding: "b".repeat(64),
        operationId: "oversized",
        name: "get_goal",
        namespace: null,
        arguments: { value: "x".repeat(800 * 1_024) },
      }),
    ).rejects.toThrow("CALLER_RELAY_REQUEST_TOO_LARGE");
  });

  it("caches a bounded refusal when multibyte tool output exceeds the frame", async () => {
    const relay = await start();
    const invoke = vi.fn(async () => "😀".repeat(200_000));
    const turn = relay.openTurn({
      identity: {
        sessionId: "session-output",
        threadId: "thread-output",
        turnId: "turn-output",
        rootTurnId: "turn-output",
      },
      tools: [command],
      invoke,
    });
    const client = new CodexCallerRelayClient(relay.endpoint);
    const request = {
      operation: "invoke" as const,
      ticket: turn.ticket,
      binding: turn.binding,
      operationId: "multibyte-output",
      name: "get_goal",
      namespace: null,
      arguments: {},
    };

    await expect(client.request(request)).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_OUTPUT_TOO_LARGE", retry: "never" },
    });
    await expect(client.request(request)).resolves.toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_OUTPUT_TOO_LARGE", retry: "never" },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

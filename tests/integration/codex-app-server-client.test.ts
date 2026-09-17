import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type CodexAppServerProcess,
} from "../../src/apps/desktop/codex-app-server-client";

class FakeProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.emit("exit", 0, signal);
    return true;
  }
}

class StubbornProcess extends FakeProcess {
  override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (signal === "SIGKILL") this.emit("exit", null, signal);
    return true;
  }
}

class BackpressuredProcess extends FakeProcess {
  override readonly stdin = new PassThrough({ highWaterMark: 1 });
}

async function nextLine(stream: PassThrough): Promise<unknown> {
  return new Promise((resolve) => {
    stream.once("data", (chunk) =>
      resolve(JSON.parse(chunk.toString("utf8").trim()) as unknown),
    );
  });
}

function send(process: FakeProcess, value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

describe("Codex App Server client", () => {
  it("initializes and correlates native host requests", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    const initialized = client.initialize();
    const initializeRequest = await nextLine(process.stdin);
    expect(initializeRequest).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "farol-next", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    send(process, { id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await initialized;
    expect(await nextLine(process.stdin)).toEqual({
      method: "initialized",
      params: {},
    });

    const models = client.request("model/list", { limit: 5 });
    expect(await nextLine(process.stdin)).toEqual({
      id: 2,
      method: "model/list",
      params: { limit: 5 },
    });
    send(process, {
      id: 2,
      result: { data: [{ id: "gpt-6-astra" }], nextCursor: null },
    });
    await expect(models).resolves.toEqual({
      data: [{ id: "gpt-6-astra" }],
      nextCursor: null,
    });

    await client.close();
    expect(process.killed).toBe(true);
  });

  it("waits for exit and escalates a stuck native host from TERM to KILL", async () => {
    const process = new StubbornProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 5,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    await client.close();

    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("answers one exactly correlated dynamic tool request", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });
    client.handleServerRequest("item/tool/call", async (params) => ({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(params),
        },
      ],
    }));

    const initialized = client.initialize();
    await nextLine(process.stdin);
    send(process, { id: 1, result: {} });
    await initialized;
    await nextLine(process.stdin);

    send(process, {
      id: "tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "farol_next",
        tool: "workspace_read",
        arguments: { workspaceId: "workspace-1", path: "README.md" },
      },
    });

    expect(await nextLine(process.stdin)).toEqual({
      id: "tool-1",
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "call-1",
              namespace: "farol_next",
              tool: "workspace_read",
              arguments: {
                workspaceId: "workspace-1",
                path: "README.md",
              },
            }),
          },
        ],
      },
    });
    await client.close();
  });

  it("delivers bounded server notifications to an exact method handler", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });
    const completed = new Promise<unknown>((resolve) => {
      client.handleNotification("turn/completed", resolve);
    });

    send(process, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      },
    });

    await expect(completed).resolves.toEqual({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await client.close();
  });

  it("fails pending requests when the native host exits", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    const pending = client.request("model/list", {});
    await nextLine(process.stdin);
    process.emit("exit", 7, null);

    await expect(pending).rejects.toThrow("CODEX_APP_SERVER_EXITED");
  });

  it("keeps native RPC error text out of application errors", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    const pending = client.request("turn/start", {});
    await nextLine(process.stdin);
    send(process, {
      id: 1,
      error: {
        code: -32000,
        message: "sensitive provider response must not cross the boundary",
      },
    });

    await expect(pending).rejects.toThrow("CODEX_APP_SERVER_RPC_-32000");
    await expect(pending).rejects.not.toThrow("sensitive provider response");
    await client.close();
  });

  it("keeps a buffered request correlated when the pipe applies backpressure", async () => {
    const process = new BackpressuredProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    const pending = client.request("model/list", {});
    expect(await nextLine(process.stdin)).toEqual({
      id: 1,
      method: "model/list",
      params: {},
    });
    send(process, { id: 1, result: { data: [] } });

    await expect(pending).resolves.toEqual({ data: [] });
    await client.close();
  });

  it("fails closed on an oversized protocol frame", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient(process, {
      requestTimeoutMs: 1_000,
      maxFrameBytes: 64,
      clientInfo: { name: "farol-next", version: "0.1.0" },
    });

    const pending = client.request("model/list", {});
    await nextLine(process.stdin);
    process.stdout.write(`{\"padding\":\"${"x".repeat(100)}\"}\n`);

    await expect(pending).rejects.toThrow("CODEX_APP_SERVER_FRAME_TOO_LARGE");
    expect(process.killed).toBe(true);
  });
});

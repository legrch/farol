import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  SharedCodexProxyHost,
  CodexProxyFailure,
} from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { HandoffNotSubmittedError } from "../../src/modules/chat/app/service/persistent-codex-handoff";

// Real HTTP parser and WebSocket framing over in-memory pipes; no listen/connect.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Mode =
  | "normal"
  | "accept-mismatch"
  | "redirect"
  | "upgrade-timeout"
  | "oversize"
  | "fragment-oversize"
  | "close"
  | "child-exit"
  | "pipe-end"
  | "binary"
  | "bad-frame"
  | "fragment-ping";

function fixture(mode: Mode = "normal") {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => {
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    }),
  });
  const socket = Duplex.from({ readable: child.stdin, writable: child.stdout });
  socket.on("error", () => {}); // Expected when a refused Upgrade is torn down.
  const http = createServer();
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  const requests: Array<{ id?: number; method: string; params?: unknown }> = [];
  const upgrades: string[] = [];
  const pongs: Buffer[] = [];
  http.on("clientError", () => socket.destroy());
  http.on("upgrade", (request, peer, head) => {
    upgrades.push(request.url!);
    if (mode === "accept-mismatch") {
      peer.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
      );
      return;
    }
    if (mode === "redirect") {
      peer.write(
        "HTTP/1.1 302 Found\r\nLocation: ws://never-connect.invalid/rpc\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    if (mode === "upgrade-timeout") return;
    server.handleUpgrade(request, peer, head, (ws) => {
      ws.on("error", () => {});
      ws.on("pong", (data) => pongs.push(data));
      ws.on("message", (data, binary) => {
        expect(binary).toBe(false);
        const message = JSON.parse(data.toString()) as {
          id?: number;
          method: string;
        };
        requests.push(message);
        if (message.method === "initialize")
          ws.send(
            JSON.stringify({
              id: message.id,
              result: {
                codexHome: "/fixture/home",
                platformFamily: "unix",
                platformOs: "macos",
                userAgent: "fixture",
              },
            }),
          );
        else if (message.id !== undefined) {
          switch (mode) {
            case "oversize":
              ws.send("x".repeat(8 * 1024 * 1024 + 1));
              return;
            case "fragment-oversize":
              ws.send("x".repeat(8 * 1024 * 1024), { fin: false });
              ws.send("x", { fin: true });
              return;
            case "close":
              ws.close(1008, "private provider close reason");
              return;
            case "child-exit":
              child.exitCode = 7;
              child.emit("exit", 7, null);
              socket.destroy();
              return;
            case "pipe-end":
              child.stdout.end();
              return;
            case "binary":
              ws.send(
                Buffer.from(
                  JSON.stringify({
                    id: message.id,
                    result: { mustNotBeAccepted: true },
                  }),
                ),
              );
              return;
            case "bad-frame":
              peer.write(Buffer.from([0x83, 0x00]));
              return;
            case "fragment-ping": {
              const text = JSON.stringify({
                id: message.id,
                result: { ok: true },
              });
              ws.send(text.slice(0, 7), { fin: false });
              ws.ping("bounded-ping");
              ws.once("pong", () => ws.send(text.slice(7), { fin: true }));
              return;
            }
            default:
              ws.send(JSON.stringify({ id: message.id, result: { ok: true } }));
          }
        }
      });
    });
  });
  http.emit("connection", socket);
  const launch = vi.fn(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  const host = new SharedCodexProxyHost(launch, "/fixture/home", 300);
  cleanups.push(async () => {
    expect(await host.closeAndWait()).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    socket.destroy();
    for (const client of server.clients) client.terminate();
    server.close();
    http.close();
  });
  return { host, child, requests, upgrades, launch, pongs };
}

it("upgrades /rpc before masked JSON initialize on the same proxy pipes", async () => {
  const f = fixture();
  expect(await f.host.request("project/list", {})).toEqual({ ok: true });
  expect(f.upgrades).toEqual(["/rpc"]);
  expect(f.requests).toEqual([
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "farol-shared-handoff", version: "1" } },
    },
    { method: "initialized", params: {} },
    { id: 2, method: "project/list", params: {} },
  ]);
  expect(f.launch).toHaveBeenCalledTimes(1);
});

it.each(["accept-mismatch", "redirect", "upgrade-timeout"] as const)(
  "%s never sends initialize, retries, or launches a second proxy",
  async (mode) => {
    const f = fixture(mode);
    const error = await f.host
      .request("thread/start", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HandoffNotSubmittedError);
    expect(f.host.terminalDiagnostic()).toEqual({
      phase: "initialize",
      method: "initialize",
      result: mode === "upgrade-timeout" ? "timeout" : "invalid_protocol",
    });
    await expect(f.host.request("thread/start", {})).rejects.toBeInstanceOf(
      HandoffNotSubmittedError,
    );
    expect(f.upgrades).toEqual(["/rpc"]);
    expect(f.requests).toEqual([]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["oversize", "invalid_protocol"],
  ["fragment-oversize", "invalid_protocol"],
  ["close", "closed"],
  ["child-exit", "exited"],
  ["pipe-end", "pipe_failed"],
  ["binary", "invalid_protocol"],
  ["bad-frame", "invalid_protocol"],
] as const)(
  "%s after send remains unknown with no replay",
  async (mode, result) => {
    const f = fixture(mode);
    const error = await f.host
      .request("turn/start", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexProxyFailure);
    expect(error).not.toBeInstanceOf(HandoffNotSubmittedError);
    expect((error as CodexProxyFailure).diagnostic).toEqual({
      phase: "request",
      method: "turn/start",
      result,
    });
    expect(JSON.stringify(error)).not.toContain("private");
    await expect(f.host.request("turn/start", {})).rejects.toBeInstanceOf(
      HandoffNotSubmittedError,
    );
    expect(f.requests.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
    ]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  },
);

it("accepts a fragmented text response with a ping between fragments", async () => {
  const f = fixture("fragment-ping");
  expect(await f.host.request("project/list", {})).toEqual({ ok: true });
  expect(f.pongs.map((data) => data.toString())).toEqual(["bounded-ping"]);
});

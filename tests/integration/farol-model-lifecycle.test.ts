import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FarolModelLifecycle,
  type FarolModelLifecycleOptions,
} from "../../src/apps/desktop/farol-model-lifecycle";

const roots: string[] = [];
const lifecycles: FarolModelLifecycle[] = [];

// The one model the endpoint serves (main.ts passes ROUTE_B_MODEL).
const MODEL = "farol-next/mind";

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function disposableStateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-model-lifecycle-"),
  );
  roots.push(root);
  return path.join(root, "model-endpoint");
}

function newLifecycle(
  stateRoot: string,
  handler?: FarolModelLifecycleOptions["handler"],
  extra: Partial<
    Omit<FarolModelLifecycleOptions, "stateRoot" | "handler">
  > = {},
): FarolModelLifecycle {
  const lifecycle = new FarolModelLifecycle({
    stateRoot,
    model: MODEL,
    ...(handler ? { handler } : {}),
    ...extra,
  });
  lifecycles.push(lifecycle);
  return lifecycle;
}

/** Exactly the request shape an ordinary Codex host sends to `/responses`. */
function codexRequest(model: string = MODEL) {
  return {
    model,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "say hi" }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: "0199c0de-0000-7000-8000-00000000d001",
      thread_id: "0199c0de-0000-7000-8000-00000000d001",
      turn_id: "turn-lifecycle-1",
      root_turn_id: "turn-lifecycle-1",
    },
  };
}

async function postTurn(
  port: number,
  token: string | undefined,
  body: unknown = codexRequest(),
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * A silent occupant: accepts connections and never answers. Its accepted
 * sockets are tracked so the test can close it promptly afterwards — an
 * aborted probe leaves its socket open on the occupant's side, and
 * `server.close()` waits for every connection otherwise.
 */
async function occupyPort(
  port: number,
): Promise<net.Server & { closeNow: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const sockets = new Set<net.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve(
        Object.assign(server, {
          closeNow: () => {
            for (const socket of sockets) socket.destroy();
            return closeServer(server);
          },
        }),
      ),
    );
  });
}

/** Something that is not Farol: an HTTP server that answers every request 200. */
async function occupyPortWithForeignHttp(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hello from something else");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const emptyTurn: NonNullable<
  FarolModelLifecycleOptions["handler"]
> = async () => ({
  ok: true,
  events: [],
});

describe("Farol Model endpoint lifecycle", () => {
  it("reports not_running before start(), with nothing listening", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);
    expect(lifecycle.status()).toEqual({ state: "not_running" });
    expect(await lifecycle.checkStatus()).toEqual({ state: "not_running" });
    expect(lifecycle.endpoint).toBeUndefined();
  });

  it("starts and stops with the caller's own lifecycle, never autospawning in between", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);

    await lifecycle.start();
    const listening = lifecycle.status();
    expect(listening.state).toBe("listening");
    if (
      listening.state !== "not_running" &&
      listening.state !== "port_conflict"
    ) {
      expect(listening.port).toBeGreaterThan(0);
    }
    expect(await lifecycle.checkStatus()).toEqual(listening);

    await lifecycle.stop();
    expect(lifecycle.status()).toEqual({ state: "not_running" });

    // Stopped means stopped: nothing is listening on the persisted port.
    const port = await lifecycle.runtimeState.persistedPort();
    expect(port).toBeDefined();
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: port! });
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("expected the port to be closed"));
        });
        socket.once("error", () => resolve(undefined));
      }),
    ).resolves.toBeUndefined();
  });

  it("hands the endpoint the one model it serves", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    expect(lifecycle.endpoint?.servedModel).toBe(MODEL);

    const token = await lifecycle.runtimeState.currentToken();
    const port = lifecycleExpectedPort(lifecycle);
    const mismatch = await postTurn(port, token, codexRequest("farol-model"));
    expect(mismatch.status).toBe(422);
    await mismatch.text();
    expect(lifecycle.status().state).toBe("listening");
  });

  it("reports a port conflict as a readable status instead of silently rebinding, and identifies the other Farol on check", async () => {
    const stateRoot = await disposableStateRoot();
    const first = newLifecycle(stateRoot);
    await first.start();
    const port = lifecycleExpectedPort(first);

    const second = newLifecycle(stateRoot);
    await second.start();
    expect(second.status()).toEqual({
      state: "port_conflict",
      port,
      occupant: "unprobed",
    });
    expect(second.endpoint).toBeUndefined();

    // The identity probe with this state root's token is answered by the
    // first instance: the port is held by another Farol, not by a stranger.
    expect(await second.checkStatus()).toEqual({
      state: "port_conflict",
      port,
      occupant: "farol",
    });

    // The first instance is unaffected and still on its own port; the
    // probe was not counted as a served turn.
    expect(lifecycleExpectedPort(first)).toBe(port);
    expect(first.status().state).toBe("listening");
  });

  it("tells a port held by something that is not this Farol from one that has since been vacated", async () => {
    const stateRoot = await disposableStateRoot();
    const warm = newLifecycle(stateRoot);
    await warm.start();
    const port = lifecycleExpectedPort(warm);
    await warm.stop();

    const occupier = await occupyPortWithForeignHttp(port);
    try {
      const lifecycle = newLifecycle(stateRoot, undefined, {
        probeTimeoutMs: 500,
      });
      await lifecycle.start();
      expect(lifecycle.status()).toEqual({
        state: "port_conflict",
        port,
        occupant: "unprobed",
      });
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "foreign",
      });

      await closeServer(occupier);
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "vacated",
      });
      // Read-only: the check never rebinds on its own.
      expect(lifecycle.endpoint).toBeUndefined();
    } finally {
      await closeServer(occupier).catch(() => undefined);
    }
  });

  it("reports a silent occupant that accepts the connection but never answers as not this Farol", async () => {
    const stateRoot = await disposableStateRoot();
    const warm = newLifecycle(stateRoot);
    await warm.start();
    const port = lifecycleExpectedPort(warm);
    await warm.stop();

    const occupier = await occupyPort(port);
    try {
      const lifecycle = newLifecycle(stateRoot, undefined, {
        probeTimeoutMs: 300,
      });
      await lifecycle.start();
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "foreign",
      });
    } finally {
      await occupier.closeNow();
    }
  });

  it("turns connected only once the endpoint has actually served a request", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    expect(lifecycle.status().state).toBe("listening");

    const token = await lifecycle.runtimeState.currentToken();
    const port = lifecycleExpectedPort(lifecycle);
    const response = await postTurn(port, token);
    expect(response.status).toBe(200);
    await response.text();

    expect(lifecycle.status().state).toBe("connected");
  });

  it("rotates the token on demand: the old token stops authenticating at once, the new one works (P2-1)", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    const port = lifecycleExpectedPort(lifecycle);
    const before = await lifecycle.runtimeState.currentToken();
    expect(before).toBeDefined();

    const rotated = await lifecycle.rotateToken();
    expect(rotated).not.toBe(before);
    expect(await lifecycle.runtimeState.currentToken()).toBe(rotated);

    const stale = await postTurn(port, before);
    expect(stale.status).toBe(401);
    await stale.text();
    const fresh = await postTurn(port, rotated);
    expect(fresh.status).toBe(200);
    await fresh.text();
    // No restart happened: same endpoint, same port.
    expect(lifecycleExpectedPort(lifecycle)).toBe(port);
  });

  it("start() is idempotent while already running", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);
    await lifecycle.start();
    const first = lifecycleExpectedPort(lifecycle);
    await lifecycle.start();
    expect(lifecycleExpectedPort(lifecycle)).toBe(first);
  });
});

function lifecycleExpectedPort(lifecycle: FarolModelLifecycle): number {
  const status = lifecycle.status();
  if (status.state !== "listening" && status.state !== "connected") {
    throw new Error(`expected a listening lifecycle, got ${status.state}`);
  }
  return status.port;
}

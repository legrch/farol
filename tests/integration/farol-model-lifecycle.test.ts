import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FarolModelLifecycle } from "../../src/apps/desktop/farol-model-lifecycle";

const roots: string[] = [];
const lifecycles: FarolModelLifecycle[] = [];

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
  handler?: ConstructorParameters<typeof FarolModelLifecycle>[0]["handler"],
): FarolModelLifecycle {
  const lifecycle = new FarolModelLifecycle({
    stateRoot,
    ...(handler ? { handler } : {}),
  });
  lifecycles.push(lifecycle);
  return lifecycle;
}

async function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe("Farol Model endpoint lifecycle", () => {
  it("reports not_running before start(), with nothing listening", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);
    expect(lifecycle.status()).toEqual({ state: "not_running" });
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

  it("reports a port conflict as a readable status instead of silently rebinding", async () => {
    const stateRoot = await disposableStateRoot();
    const first = newLifecycle(stateRoot);
    await first.start();
    const port = lifecycleExpectedPort(first);

    const second = newLifecycle(stateRoot);
    await second.start();
    expect(second.status()).toEqual({ state: "port_conflict", port });
    expect(second.endpoint).toBeUndefined();

    // The first instance is unaffected and still on its own port.
    expect(lifecycleExpectedPort(first)).toBe(port);
  });

  it("reports a port conflict against an unrelated process holding the persisted port", async () => {
    const stateRoot = await disposableStateRoot();
    const warm = newLifecycle(stateRoot);
    await warm.start();
    const port = lifecycleExpectedPort(warm);
    await warm.stop();

    const occupier = await occupyPort(port);
    try {
      const lifecycle = newLifecycle(stateRoot);
      await lifecycle.start();
      expect(lifecycle.status()).toEqual({ state: "port_conflict", port });
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });

  it("turns connected only once the endpoint has actually served a request", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, async () => ({
      ok: true,
      events: [],
    }));
    await lifecycle.start();
    expect(lifecycle.status().state).toBe("listening");

    const token = await lifecycle.runtimeState.currentToken();
    const port = lifecycleExpectedPort(lifecycle);
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(lifecycle.status().state).toBe("connected");
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

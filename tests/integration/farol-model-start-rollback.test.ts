import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FAROL_MODEL_RESPONSES_PATH,
  FarolModelEndpoint,
  type FarolModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelLifecycle } from "../../src/apps/desktop/farol-model-lifecycle";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

// Starting the owned loopback endpoint acquires one thing that outlives the
// method when it fails: an HTTP listener on a real port. `start()` binds,
// then persists the port, then writes the liveness marker, and only the bind
// is undone by anything. A failure in either durable step therefore used to
// leave a socket accepting turns for an endpoint the lifecycle never
// retained, never reported as running, and could not stop.
//
// These tests fail after each acquired resource rather than before `listen`,
// and they ask the port itself — `status()` cannot see a listener nobody
// owns, so `status()` alone would have agreed with the defect.

const MODEL = "farol-next/mind";

const roots: string[] = [];
const endpoints: FarolModelEndpoint[] = [];

afterEach(async () => {
  await Promise.all(
    endpoints
      .splice(0)
      .map((endpoint) => endpoint.stop().catch(() => undefined)),
  );
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-model-rollback-"),
  );
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

function countingHandler(): {
  handler: FarolModelTurnHandler;
  invocations: () => number;
} {
  let invocations = 0;
  return {
    handler: async () => {
      invocations += 1;
      return {
        ok: true,
        events: [
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: { status: "completed" },
            },
          },
        ],
      };
    },
    invocations: () => invocations,
  };
}

function trackedEndpoint(
  state: FarolModelRuntimeState,
  handler: FarolModelTurnHandler,
): FarolModelEndpoint {
  const endpoint = new FarolModelEndpoint({ state, model: MODEL, handler });
  endpoints.push(endpoint);
  return endpoint;
}

type TurnAttempt = Readonly<{
  reached: "endpoint" | "nothing";
  status?: number | undefined;
}>;

/** Exactly the turn an authenticated Codex host would send to the port. */
function attemptTurn(port: number, token: string): Promise<TurnAttempt> {
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ],
  });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: FAROL_MODEL_RESPONSES_PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ reached: "endpoint", status: response.statusCode }),
        );
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      // Nothing is listening: the only answer a rolled-back start may give.
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        resolve({ reached: "nothing" });
        return;
      }
      reject(error);
    });
    request.end(body);
  });
}

describe("Farol Model endpoint failed-start rollback", () => {
  it("serves nothing on a port whose persistPort never committed", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const turn = countingHandler();
    const endpoint = trackedEndpoint(state, turn.handler);
    let boundPort: number | undefined;
    vi.spyOn(state, "persistPort").mockImplementation(async (port: number) => {
      boundPort = port;
      throw new Error("PERSIST_PORT_FAILED");
    });

    await expect(endpoint.start()).rejects.toThrow("PERSIST_PORT_FAILED");

    expect(boundPort).toBeTypeOf("number");
    const token = await state.currentToken();
    expect(token).toBeTypeOf("string");
    // The decisive question is what the socket does, not what status says.
    expect(await attemptTurn(boundPort as number, token as string)).toEqual({
      reached: "nothing",
    });
    expect(turn.invocations()).toBe(0);
    expect(endpoint.port).toBeUndefined();
    // A startup that did not finish may never be revived on this instance.
    expect(endpoint.isSealed).toBe(true);
  });

  it("serves nothing on a persisted port whose liveness never committed", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const first = trackedEndpoint(state, countingHandler().handler);
    const { port } = await first.start();
    await first.stop();
    expect(await state.persistedPort()).toBe(port);

    const turn = countingHandler();
    const endpoint = trackedEndpoint(state, turn.handler);
    vi.spyOn(state, "markLive").mockRejectedValue(
      new Error("MARK_LIVE_FAILED"),
    );

    await expect(endpoint.start()).rejects.toThrow("MARK_LIVE_FAILED");

    const token = await state.currentToken();
    expect(await attemptTurn(port, token as string)).toEqual({
      reached: "nothing",
    });
    expect(turn.invocations()).toBe(0);
    expect(await state.readLiveness()).toBeUndefined();
    expect(endpoint.isSealed).toBe(true);
  });

  it("records the cleanup it still owes when rollback itself fails", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const turn = countingHandler();
    const endpoint = trackedEndpoint(state, turn.handler);
    let boundPort: number | undefined;
    vi.spyOn(state, "persistPort").mockImplementation(async (port: number) => {
      boundPort = port;
      throw new Error("PERSIST_PORT_FAILED");
    });
    vi.spyOn(state, "clearLiveness").mockRejectedValue(
      new Error("CLEAR_LIVENESS_FAILED"),
    );

    // The caller still learns why startup failed, not why cleanup did.
    await expect(endpoint.start()).rejects.toThrow("PERSIST_PORT_FAILED");

    const token = await state.currentToken();
    expect(await attemptTurn(boundPort as number, token as string)).toEqual({
      reached: "nothing",
    });
    expect(turn.invocations()).toBe(0);
    // The failure is recorded rather than swallowed: the obligation is
    // readable, and the seal is what makes the endpoint safe meanwhile.
    expect(endpoint.isSealed).toBe(true);
    expect(endpoint.failedStartCleanupError?.message).toBe(
      "CLEAR_LIVENESS_FAILED",
    );
  });

  it("leaves the lifecycle owning nothing that still answers", async () => {
    const root = await stateRoot();
    const turn = countingHandler();
    const lifecycle = new FarolModelLifecycle({
      stateRoot: root,
      model: MODEL,
      handler: turn.handler,
    });
    const state = lifecycle.runtimeState;
    let boundPort: number | undefined;
    vi.spyOn(state, "persistPort").mockImplementation(async (port: number) => {
      boundPort = port;
      throw new Error("PERSIST_PORT_FAILED");
    });

    await expect(lifecycle.start()).rejects.toThrow("PERSIST_PORT_FAILED");

    // What main.ts sees after catching that error, and what the port agrees.
    expect(lifecycle.endpoint).toBeUndefined();
    expect(lifecycle.status()).toEqual({ state: "not_running" });
    const token = await state.currentToken();
    expect(await attemptTurn(boundPort as number, token as string)).toEqual({
      reached: "nothing",
    });
    expect(turn.invocations()).toBe(0);
    await lifecycle.stop();
  });
});

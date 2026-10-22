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
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

// Where a request is admitted, stated from the contract this endpoint
// already carries.
//
// `seal()` promises that "nothing authenticates against this endpoint
// again", synchronously and whatever the token file holds; `stop()`
// separately promises that requests already in flight are allowed to
// finish. Together those name the admission point: a request is admitted
// the moment its bearer token is verified against the token current then.
// A seal taken before that verification must refuse it; a seal taken after
// it belongs to the drain policy, and aborting an admitted turn would be a
// claim that cancelling HTTP undoes what the turn already did.
//
// The seal is checked before the token file is read, and then the read is
// awaited. These tests hold the endpoint inside each await and ask what the
// product handler actually saw.

const MODEL = "legacy-route/mind";

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
    path.join(os.tmpdir(), "farol-model-admission-"),
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Yield past the microtask queue, so the endpoint has resumed from its
 * token read and run every synchronous step that follows it. Resolving the
 * token promise only queues that continuation; a test that acts in the same
 * microtask turn would still be acting before authentication completed.
 */
function afterAuthenticationCompleted(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const turnBody = JSON.stringify({
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

type Answer = Readonly<{ status: number; body: string }>;

/**
 * Send a turn whose body is written in two halves, so the endpoint can be
 * held between authentication and dispatch. `bodySent` resolves once the
 * first half is on the wire; the second is written by `finishBody`.
 */
function splitBodyTurn(
  port: number,
  token: string,
): {
  answer: Promise<Answer>;
  finishBody: () => void;
} {
  const head = turnBody.slice(0, 20);
  const tail = turnBody.slice(20);
  const request = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: FAROL_MODEL_RESPONSES_PATH,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(turnBody),
      authorization: `Bearer ${token}`,
    },
  });
  const answer = new Promise<Answer>((resolve, reject) => {
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    request.on("error", reject);
  });
  request.write(head);
  return { answer, finishBody: () => request.end(tail) };
}

function wholeTurn(port: number, token: string): Promise<Answer> {
  const { answer, finishBody } = splitBodyTurn(port, token);
  finishBody();
  return answer;
}

describe("Farol Model endpoint seal and rotation admission point", () => {
  it("refuses a request sealed while its own token read was pending", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const turn = countingHandler();
    const endpoint = new FarolModelEndpoint({
      state,
      model: MODEL,
      handler: turn.handler,
    });
    endpoints.push(endpoint);
    const { port } = await endpoint.start();
    const token = (await state.currentToken()) as string;

    const entered = deferred<void>();
    const held = deferred<string | undefined>();
    vi.spyOn(state, "currentToken").mockImplementation(() => {
      entered.resolve();
      return held.promise;
    });

    const answer = wholeTurn(port, token);
    await entered.promise;
    // The seal lands while this request is inside the token read: it has
    // not authenticated, so it is not admitted.
    endpoint.seal();
    held.resolve(token);

    const received = await answer;
    expect(received.status).toBe(401);
    // Indistinguishable from an endpoint that has no token at all.
    expect(JSON.parse(received.body)).toEqual({
      error: { code: "unauthorized" },
    });
    expect(turn.invocations()).toBe(0);
  });

  it("refuses a request whose token read resolved a rotated-away literal", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const turn = countingHandler();
    const endpoint = new FarolModelEndpoint({
      state,
      model: MODEL,
      handler: turn.handler,
    });
    endpoints.push(endpoint);
    const { port } = await endpoint.start();
    const token = (await state.currentToken()) as string;

    const entered = deferred<void>();
    const held = deferred<string | undefined>();
    vi.spyOn(state, "currentToken").mockImplementation(() => {
      entered.resolve();
      return held.promise;
    });

    const answer = wholeTurn(port, token);
    await entered.promise;
    endpoint.seal();
    // The read resolves the literal that was current when it began. A seal
    // is terminal whatever the token file now holds.
    held.resolve(token);

    expect((await answer).status).toBe(401);
    expect(turn.invocations()).toBe(0);
  });

  it("lets an already-authenticated turn finish when the seal lands mid-body", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const turn = countingHandler();
    const endpoint = new FarolModelEndpoint({
      state,
      model: MODEL,
      handler: turn.handler,
    });
    endpoints.push(endpoint);
    const { port } = await endpoint.start();
    const token = (await state.currentToken()) as string;

    const authenticated = deferred<void>();
    const realToken = state.currentToken.bind(state);
    vi.spyOn(state, "currentToken").mockImplementation(async () => {
      const value = await realToken();
      authenticated.resolve();
      return value;
    });

    const { answer, finishBody } = splitBodyTurn(port, token);
    await authenticated.promise;
    await afterAuthenticationCompleted();
    // Admitted before the seal: the drain policy owns it from here, and
    // refusing it now would pretend that dropping HTTP undoes a turn.
    endpoint.seal();
    finishBody();

    expect((await answer).status).toBe(200);
    expect(turn.invocations()).toBe(1);
  });

  it("lets an already-authenticated turn finish when the token rotates mid-body", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const turn = countingHandler();
    const endpoint = new FarolModelEndpoint({
      state,
      model: MODEL,
      handler: turn.handler,
    });
    endpoints.push(endpoint);
    const { port } = await endpoint.start();
    const token = (await state.currentToken()) as string;

    const authenticated = deferred<void>();
    const realToken = state.currentToken.bind(state);
    vi.spyOn(state, "currentToken").mockImplementation(async () => {
      const value = await realToken();
      authenticated.resolve();
      return value;
    });

    const { answer, finishBody } = splitBodyTurn(port, token);
    await authenticated.promise;
    await afterAuthenticationCompleted();
    const rotated = await state.rotateToken();
    expect(rotated).not.toBe(token);
    finishBody();

    expect((await answer).status).toBe(200);
    expect(turn.invocations()).toBe(1);
    // The rotation still takes effect from the next request on.
    expect((await wholeTurn(port, token)).status).toBe(401);
    expect(turn.invocations()).toBe(1);
  });
});

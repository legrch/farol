import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAROL_MODEL_IDENTITY_PATH,
  FAROL_MODEL_MAX_BODY_BYTES,
  FarolModelEndpoint,
  FarolModelEndpointPortConflictError,
  isFarolModelIdentity,
  isLoopbackAddress,
  type FarolModelEndpointOptions,
  type FarolModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

const roots: string[] = [];
const endpoints: FarolModelEndpoint[] = [];

// The one model the endpoint serves in these tests (the Route B model in
// production; main.ts passes ROUTE_B_MODEL).
const MODEL = "farol-next/mind";

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.stop()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-model-endpoint-"),
  );
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

function trackedEndpoint(
  state: FarolModelRuntimeState,
  handler?: FarolModelTurnHandler,
  extra: Partial<Omit<FarolModelEndpointOptions, "state" | "handler">> = {},
): FarolModelEndpoint {
  const endpoint = new FarolModelEndpoint({
    state,
    model: MODEL,
    ...(handler === undefined ? {} : { handler }),
    ...extra,
  });
  endpoints.push(endpoint);
  return endpoint;
}

const syntheticHandler: FarolModelTurnHandler = async () => ({
  ok: true,
  events: [
    { event: "response.created", data: { type: "response.created" } },
    {
      event: "response.completed",
      data: { type: "response.completed", response: { status: "completed" } },
    },
  ],
});

/** Exactly the request shape an ordinary Codex host sends to `/responses`. */
function codexRequest(model: string = MODEL, text = "say hi") {
  return {
    model,
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
      session_id: "0199c0de-0000-7000-8000-00000000c001",
      thread_id: "0199c0de-0000-7000-8000-00000000c001",
      turn_id: "turn-endpoint-1",
      root_turn_id: "turn-endpoint-1",
    },
  };
}

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
  route = "/responses",
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function started(
  handler: FarolModelTurnHandler = syntheticHandler,
  extra: Partial<Omit<FarolModelEndpointOptions, "state" | "handler">> = {},
): Promise<{
  endpoint: FarolModelEndpoint;
  state: FarolModelRuntimeState;
  port: number;
  token: string;
}> {
  const state = new FarolModelRuntimeState(await stateRoot());
  const endpoint = trackedEndpoint(state, handler, extra);
  const { port } = await endpoint.start();
  const token = await state.currentToken();
  if (!token) throw new Error("FAROL_MODEL_TOKEN_MISSING_IN_TEST");
  return { endpoint, state, port, token };
}

describe("Farol Model loopback endpoint", () => {
  it("binds an ephemeral port on first start and persists it", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const endpoint = trackedEndpoint(state, syntheticHandler);
    const { port } = await endpoint.start();
    expect(port).toBeGreaterThan(0);
    expect(await state.persistedPort()).toBe(port);
  });

  it("reuses the persisted port across launches and reports a real conflict", async () => {
    const root = await stateRoot();
    const first = trackedEndpoint(
      new FarolModelRuntimeState(root),
      syntheticHandler,
    );
    const { port } = await first.start();

    const second = trackedEndpoint(
      new FarolModelRuntimeState(root),
      syntheticHandler,
    );
    await expect(second.start()).rejects.toBeInstanceOf(
      FarolModelEndpointPortConflictError,
    );

    await first.stop();
    const third = trackedEndpoint(
      new FarolModelRuntimeState(root),
      syntheticHandler,
    );
    expect((await third.start()).port).toBe(port);
  });

  it("serves an authenticated request in the ordinary Codex shape and records the evidence", async () => {
    const { endpoint, port, token } = await started();

    const response = await post(port, codexRequest(), {
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.completed");

    const evidence = endpoint.evidence();
    expect(evidence.requestsAccepted).toBe(1);
    expect(evidence.lastAcceptedAtIso).toBeDefined();
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("refuses a request without a token: 401, a generic body, and the precise reason only in the evidence", async () => {
    const { endpoint, port } = await started();

    const response = await post(port, codexRequest(), {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const body = await response.text();
    expect(body).not.toMatch(/farol/iu);
    expect(body).not.toContain("FAROL_");
    expect(endpoint.evidence().requestsRejected).toBe(1);
    expect(endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_TOKEN_MISSING",
    );
  });

  it("refuses a wrong token, a token off by one character, and an empty bearer, all with the same generic 401", async () => {
    const { endpoint, port, token } = await started();

    for (const presented of [
      "Bearer not-the-token",
      `Bearer ${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
      `Bearer ${token}x`,
      "Bearer ",
      token,
    ]) {
      const response = await post(port, codexRequest(), {
        authorization: presented,
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toMatch(/farol/iu);
    }
    expect(endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_TOKEN_INVALID",
    );
    expect(endpoint.evidence().requestsAccepted).toBe(0);
  });

  it("authenticates before any route is dispatched: an anonymous caller learns nothing about which routes exist", async () => {
    const { endpoint, port, token } = await started();

    for (const [method, route] of [
      ["POST", "/nope"],
      ["GET", FAROL_MODEL_IDENTITY_PATH],
      ["GET", "/"],
      ["DELETE", "/responses"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toMatch(/farol/iu);
    }

    // Authenticated, the missing route is a precise 404.
    const authenticated = await post(
      port,
      codexRequest(),
      {
        authorization: `Bearer ${token}`,
      },
      "/nope",
    );
    expect(authenticated.status).toBe(404);
    const payload = (await authenticated.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("FAROL_MODEL_ROUTE_NOT_FOUND");
    expect(endpoint.evidence().requestsAccepted).toBe(0);
  });

  it("refuses any request that carries an Origin header with 403, even with a valid token", async () => {
    let handled = 0;
    const { endpoint, port, token } = await started(async () => {
      handled += 1;
      return syntheticHandler({ body: undefined, headers: {} });
    });

    const response = await post(port, codexRequest(), {
      authorization: `Bearer ${token}`,
      origin: "http://127.0.0.1:5173",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/farol/iu);
    expect(handled).toBe(0);
    expect(endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_ORIGIN_PRESENT",
    );
  });

  it("answers with a precise, content-free error when the turn route is unavailable", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    // No handler given: defaults to the unavailable route.
    const endpoint = trackedEndpoint(state);
    const { port } = await endpoint.start();
    const token = await state.currentToken();

    const response = await post(port, codexRequest(), {
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("FAROL_MODEL_ROUTE_UNAVAILABLE");
    // Content-free: no upstream detail, no stack, no internal path.
    expect(JSON.stringify(payload)).not.toMatch(/\/(Users|home)\//u);
  });

  it("refuses any model but the one it serves with 422 FAROL_MODEL_MODEL_MISMATCH that names the required value (P1-1)", async () => {
    let handled = 0;
    const { endpoint, port, token } = await started(async () => {
      handled += 1;
      return syntheticHandler({ body: undefined, headers: {} });
    });

    for (const body of [
      codexRequest("farol-model"),
      codexRequest("gpt-5"),
      { ...codexRequest(), model: undefined },
      {},
    ]) {
      const response = await post(port, body, {
        authorization: `Bearer ${token}`,
      });
      expect(response.status).toBe(422);
      const payload = (await response.json()) as {
        error: { code: string; expected_model: string; message: string };
      };
      expect(payload.error.code).toBe("FAROL_MODEL_MODEL_MISMATCH");
      expect(payload.error.expected_model).toBe(MODEL);
      expect(payload.error.message).toContain(`"${MODEL}"`);
    }
    expect(handled).toBe(0);
    expect(endpoint.evidence().requestsAccepted).toBe(0);
    expect(endpoint.servedModel).toBe(MODEL);

    // A body that is not JSON at all is a 400, not a mismatch.
    const notJson = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect(
      ((await notJson.json()) as { error: { code: string } }).error.code,
    ).toBe("FAROL_MODEL_BODY_INVALID");
  });

  it("requires a model at construction", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    expect(() => new FarolModelEndpoint({ state, model: "" })).toThrow(
      "FAROL_MODEL_ENDPOINT_MODEL_REQUIRED",
    );
  });

  it("bounds the request body at 1 MiB: a declared oversize is refused up front", async () => {
    let handled = 0;
    const { port, token } = await started(async () => {
      handled += 1;
      return syntheticHandler({ body: undefined, headers: {} });
    });
    expect(FAROL_MODEL_MAX_BODY_BYTES).toBe(1024 * 1024);

    const padded = {
      ...codexRequest(),
      padding: "x".repeat(FAROL_MODEL_MAX_BODY_BYTES),
    };
    const response = await post(port, padded, {
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("FAROL_MODEL_BODY_TOO_LARGE");
    expect(handled).toBe(0);
  });

  it("refuses a streamed oversize body while it is still arriving, before buffering completes", async () => {
    let handled = 0;
    const { port, token } = await started(async () => {
      handled += 1;
      return syntheticHandler({ body: undefined, headers: {} });
    });

    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const totalChunks = 64; // 4 MiB, four times the bound.
    // Paced so the 413 (due after the 17th chunk) is observed while the
    // upload is demonstrably still in progress, not raced against loopback.
    const paceMs = 5;
    let sent = 0;
    let sentAtResponse: number | undefined;
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/responses",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          sentAtResponse = sent;
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", (error) => {
        // Once the server has answered, a write error on the remainder is
        // the connection being dropped, which is the expected outcome.
        if (sentAtResponse === undefined) reject(error);
      });
      const pump = () => {
        if (sent >= totalChunks) {
          request.end();
          return;
        }
        sent += 1;
        request.write(chunk, () => setTimeout(pump, paceMs));
      };
      pump();
    });
    expect(status).toBe(413);
    expect(sentAtResponse).toBeDefined();
    expect(sentAtResponse!).toBeLessThan(totalChunks);
    expect(sentAtResponse!).toBeGreaterThanOrEqual(16);
    expect(handled).toBe(0);
  });

  it("closes a connection that never finishes its headers (headersTimeout) and rejects inverted timeouts", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    expect(
      () =>
        new FarolModelEndpoint({
          state,
          model: MODEL,
          timeouts: { headersTimeoutMs: 500, requestTimeoutMs: 100 },
        }),
    ).toThrow("FAROL_MODEL_ENDPOINT_TIMEOUTS_INVALID");

    const { port } = await started(syntheticHandler, {
      timeouts: {
        headersTimeoutMs: 200,
        requestTimeoutMs: 400,
        connectionsCheckingIntervalMs: 50,
      },
    });
    let received = "";
    const closedWithin = await new Promise<number>((resolve, reject) => {
      const startedAt = Date.now();
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.write("POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      });
      // Read what the server sends: a paused socket would sit on its
      // unread 408 and never reach `close`.
      socket.on("data", (data: Buffer) => {
        received += data.toString("utf8");
      });
      socket.on("close", () => resolve(Date.now() - startedAt));
      socket.on("error", () => undefined);
      setTimeout(() => reject(new Error("socket was not closed")), 4_000);
    });
    expect(closedWithin).toBeLessThan(4_000);
    expect(received.startsWith("HTTP/1.1 408 ")).toBe(true);
  });

  it("treats an empty or unparsable token file as no token: never authenticates `Bearer ` and re-mints on demand", async () => {
    const { endpoint, state, port, token } = await started();
    const tokenFile = path.join(
      (state as unknown as { root: string }).root,
      "model-endpoint-token",
    );

    for (const damaged of ["", "\n", "not a token\n", `${token}\n`]) {
      await fs.writeFile(tokenFile, damaged, { mode: 0o600 });
      expect(await state.currentToken()).toBeUndefined();
      const empty = await post(port, codexRequest(), {
        authorization: "Bearer ",
      });
      expect(empty.status).toBe(401);
      const stale = await post(port, codexRequest(), {
        authorization: `Bearer ${token}`,
      });
      expect(stale.status).toBe(401);
      expect(endpoint.evidence().lastRejectedReason).toBe(
        "FAROL_MODEL_TOKEN_UNSET",
      );
    }

    const minted = await state.ensureToken();
    expect(minted).not.toBe(token);
    const served = await post(port, codexRequest(), {
      authorization: `Bearer ${minted}`,
    });
    expect(served.status).toBe(200);
    await served.text();
  });

  it("answers the authenticated identity probe with its own instance nonce, without counting it as a served turn", async () => {
    const { endpoint, port, token } = await started();

    const response = await fetch(
      `http://127.0.0.1:${port}${FAROL_MODEL_IDENTITY_PATH}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const identity: unknown = await response.json();
    expect(isFarolModelIdentity(identity)).toBe(true);
    if (isFarolModelIdentity(identity)) {
      expect(identity.instance).toBe(endpoint.instanceNonce);
      expect(identity.pid).toBe(process.pid);
      expect(identity.port).toBe(port);
    }
    expect(endpoint.evidence().requestsAccepted).toBe(0);
    expect(JSON.stringify(identity)).not.toContain(token);

    // A second endpoint instance has a different nonce.
    const other = trackedEndpoint(
      new FarolModelRuntimeState(await stateRoot()),
      syntheticHandler,
    );
    expect(other.instanceNonce).not.toBe(endpoint.instanceNonce);
  });

  it("classifies loopback addresses precisely (the guard's decision function)", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  // S35-TA-2: the seal is the endpoint's terminal state. It is what a
  // caller takes when it can no longer say what the token file holds, so
  // it must hold with the socket still bound, with the token file still
  // carrying a usable literal, and with no I/O of its own that could fail.
  it("S35-TA-2 a sealed endpoint refuses the very token its own state file still carries, on the still-bound port", async () => {
    const { endpoint, port, token } = await started();

    const before = await post(port, codexRequest(), {
      authorization: `Bearer ${token}`,
    });
    expect(before.status).toBe(200);
    await before.text();

    endpoint.seal();
    expect(endpoint.isSealed).toBe(true);

    // Still listening, the token file untouched — and every request
    // refused with the same anonymous 401 an endpoint with no token gives.
    const after = await post(port, codexRequest(), {
      authorization: `Bearer ${token}`,
    });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toBe("Bearer");
    expect(await after.json()).toEqual({ error: { code: "unauthorized" } });
    expect(endpoint.evidence().lastRejectedReason).toBe("FAROL_MODEL_SEALED");

    // The authenticated identity probe is behind the same check, so a
    // sealed endpoint does not identify itself either.
    const identity = await fetch(
      `http://127.0.0.1:${port}${FAROL_MODEL_IDENTITY_PATH}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(identity.status).toBe(401);
    await identity.text();
  });

  // S35-TA-17 (U2c). Two different internal reasons — the endpoint is
  // sealed, and the token file holds nothing — must be ONE fact to a caller
  // that has not authenticated: it was refused. Asserting a 401 on each
  // separately does not prove that; a status code is the part hardest to
  // get wrong. This compares the two responses byte for byte and counts
  // provider dispatches for both, because the response could be identical
  // while one of them had already reached the turn handler.
  it("S35-TA-17 a sealed endpoint and one with no token refuse identically, and neither reaches the provider", async () => {
    let dispatches = 0;
    const counting: FarolModelTurnHandler = async (request) => {
      dispatches += 1;
      return syntheticHandler(request);
    };

    // Sealed, with a usable token still in its state file.
    const sealed = await started(counting);
    const sealedProbe = await post(sealed.port, codexRequest(), {
      authorization: `Bearer ${sealed.token}`,
    });
    expect(sealedProbe.status).toBe(200);
    await sealedProbe.text();
    expect(dispatches).toBe(1);
    sealed.endpoint.seal();

    const sealedRefusal = await post(sealed.port, codexRequest(), {
      authorization: `Bearer ${sealed.token}`,
    });
    const sealedBody = await sealedRefusal.text();

    // A second endpoint whose token has been cleared: a different internal
    // reason, the same caller-visible situation.
    const unset = await started(counting);
    await unset.state.clearToken();
    const unsetRefusal = await post(unset.port, codexRequest(), {
      authorization: `Bearer ${unset.token}`,
    });
    const unsetBody = await unsetRefusal.text();

    // Byte for byte: status, the headers a caller can read, and the body.
    expect(sealedRefusal.status).toBe(unsetRefusal.status);
    expect(sealedRefusal.status).toBe(401);
    expect(sealedRefusal.headers.get("www-authenticate")).toBe(
      unsetRefusal.headers.get("www-authenticate"),
    );
    expect(sealedRefusal.headers.get("www-authenticate")).toBe("Bearer");
    expect(sealedRefusal.headers.get("content-type")).toBe(
      unsetRefusal.headers.get("content-type"),
    );
    expect(sealedBody).toBe(unsetBody);
    expect(JSON.parse(sealedBody)).toEqual({ error: { code: "unauthorized" } });

    // No FAROL_* reason, no token, no hint of which check refused: the
    // internal reason stays in evidence() for the owner.
    for (const body of [sealedBody, unsetBody]) {
      expect(body).not.toContain("FAROL");
      expect(body).not.toContain("SEALED");
      expect(body).not.toContain("TOKEN");
      expect(body).not.toContain(sealed.token);
    }
    expect(sealed.endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_SEALED",
    );
    expect(unset.endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_TOKEN_UNSET",
    );

    // Neither refusal reached the turn handler: still the one dispatch the
    // pre-seal probe made, and none from the other endpoint at all.
    //
    // Honest about what this half proves. It CANNOT be reddened on its own
    // in today's design: the only way to reach the handler is to not refuse,
    // and removing the seal check makes the status assertion above fail
    // first (measured — that mutant dies on "expected 200 to be 401"). So
    // the counter is not independently decisive today. It is here for the
    // refactor where refusal and dispatch could diverge — a telemetry hook,
    // a pre-warm, a handler consulted before the credential — because then
    // a response could stay byte-identical while the provider had already
    // been reached, and nothing else in this file would notice.
    //
    // (Also measured: dropping just the `return` after the sealed refusal
    // does NOT produce a dispatch, so that is not the mutant for this row.)
    expect(dispatches).toBe(1);
    expect(sealed.endpoint.evidence().requestsAccepted).toBe(1);
    expect(unset.endpoint.evidence().requestsAccepted).toBe(0);
  });

  it("S35-TA-2 a sealed endpoint cannot be restarted, and seals stay set across a stop", async () => {
    const { endpoint, port, token } = await started();
    endpoint.seal();
    await endpoint.stop();

    await expect(endpoint.start()).rejects.toThrow(
      "FAROL_MODEL_ENDPOINT_SEALED",
    );
    expect(endpoint.isSealed).toBe(true);
    // Nothing on the port any more, and nothing that could put it back.
    await expect(
      post(port, codexRequest(), { authorization: `Bearer ${token}` }),
    ).rejects.toThrow();
  });

  it("S35-TA-2 stop() resolves only once the port has actually stopped accepting connections", async () => {
    const { endpoint, port } = await started();

    await endpoint.stop();

    // The moment `stop()` resolved, a fresh connection must be refused —
    // not merely "the endpoint says it stopped".
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("the port was still accepting connections"));
        });
        socket.once("error", () => resolve(undefined));
      }),
    ).resolves.toBeUndefined();
    expect(endpoint.port).toBeUndefined();
    // Idempotent: a second stop is a no-op, not a second close.
    await expect(endpoint.stop()).resolves.toBeUndefined();
  });

  it("binds only 127.0.0.1, so a real external connection cannot reach it", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const endpoint = trackedEndpoint(state, syntheticHandler);
    const { port } = await endpoint.start();
    // A connection attempt to a non-loopback local interface must fail to
    // even connect, which is the primary boundary; the per-request
    // isLoopbackAddress check above is the defense-in-depth backstop for
    // any transport that could otherwise proxy a remote peer in.
    const interfaces = Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined &&
          candidate.family === "IPv4" &&
          !candidate.internal,
      );
    if (interfaces.length === 0) return;
    const externalAddress = interfaces[0]!.address;
    await expect(
      fetch(`http://${externalAddress}:${port}/responses`, {
        method: "POST",
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow();
  });
});

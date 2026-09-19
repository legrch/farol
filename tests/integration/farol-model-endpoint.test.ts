import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FarolModelEndpoint,
  FarolModelEndpointPortConflictError,
  isLoopbackAddress,
  type FarolModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

const roots: string[] = [];
const endpoints: FarolModelEndpoint[] = [];

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
): FarolModelEndpoint {
  const endpoint = new FarolModelEndpoint(
    handler === undefined ? { state } : { state, handler },
  );
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

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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

  it("serves an authenticated request and records the evidence", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const endpoint = trackedEndpoint(state, syntheticHandler);
    const { port } = await endpoint.start();
    const token = await state.currentToken();

    const response = await post(
      port,
      { model: "farol" },
      {
        authorization: `Bearer ${token}`,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.completed");

    const evidence = endpoint.evidence();
    expect(evidence.requestsAccepted).toBe(1);
    expect(evidence.lastAcceptedAtIso).toBeDefined();
  });

  it("refuses a request without a token", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const endpoint = trackedEndpoint(state, syntheticHandler);
    const { port } = await endpoint.start();

    const response = await post(port, {}, {});
    expect(response.status).toBe(401);
    expect(endpoint.evidence().requestsRejected).toBe(1);
    expect(endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_TOKEN_MISSING",
    );
  });

  it("refuses a request with the wrong token", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const endpoint = trackedEndpoint(state, syntheticHandler);
    const { port } = await endpoint.start();

    const response = await post(
      port,
      {},
      { authorization: "Bearer not-the-token" },
    );
    expect(response.status).toBe(401);
    expect(endpoint.evidence().lastRejectedReason).toBe(
      "FAROL_MODEL_TOKEN_INVALID",
    );
  });

  it("answers with a precise, content-free error when the turn route is unavailable", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    // No handler given: defaults to the unavailable route.
    const endpoint = trackedEndpoint(state);
    const { port } = await endpoint.start();
    const token = await state.currentToken();

    const response = await post(port, {}, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("FAROL_MODEL_ROUTE_UNAVAILABLE");
    // Content-free: no upstream detail, no stack, no internal path.
    expect(JSON.stringify(payload)).not.toMatch(/\/(Users|home)\//u);
  });

  it("classifies loopback addresses precisely (the guard's decision function)", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
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

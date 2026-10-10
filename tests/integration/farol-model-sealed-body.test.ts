import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FarolModelEndpoint } from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

// Real loopback endpoint with a disposable private state root and controlled
// handlers. No Electron, account, Codex host, or external provider is exercised.
it.each(["/responses", "/responses/compact"])(
  "refuses %s when a seal lands after authentication but before the body finishes",
  async (route) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-sealed-body-"));
    const state = new FarolModelRuntimeState(path.join(root, "endpoint"));
    const dispatches: string[] = [];
    const endpoint = new FarolModelEndpoint({
      state,
      model: "farol-next/mind",
      handler: async () => {
        dispatches.push("turn");
        return { ok: true, events: [] };
      },
      compactionHandler: async () => {
        dispatches.push("compaction");
        return { ok: true, status: 200, body: "{}" };
      },
    });
    let request: http.ClientRequest | undefined;
    try {
      const { port } = await endpoint.start();
      const token = await state.currentToken();
      let authenticated: (() => void) | undefined;
      const tokenRead = new Promise<void>((resolve) => {
        authenticated = resolve;
      });
      const originalTokenRead = state.currentToken.bind(state);
      state.currentToken = async () => {
        const value = await originalTokenRead();
        authenticated!();
        return value;
      };
      const body = JSON.stringify({ model: "farol-next/mind", input: [] });
      const response = new Promise<{
        status: number | undefined;
        body: string;
      }>((resolve, reject) => {
        request = http.request(
          {
            host: "127.0.0.1",
            port,
            path: route,
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (reply) => {
            let text = "";
            reply.setEncoding("utf8");
            reply.on("data", (chunk: string) => {
              text += chunk;
            });
            reply.once("end", () =>
              resolve({ status: reply.statusCode, body: text }),
            );
            reply.once("error", reject);
          },
        );
        request.once("error", reject);
        request.write(body.slice(0, 1));
      });
      await tokenRead;
      // Let the handler finish authentication and enter its pending body read.
      // The remaining bytes are deliberately withheld, with no timing sleep.
      await new Promise<void>((resolve) => setImmediate(resolve));
      endpoint.seal();
      request!.end(body.slice(1));
      const refused = await response;
      expect(refused).toEqual({
        status: 401,
        body: JSON.stringify({ error: { code: "unauthorized" } }),
      });
      expect(dispatches).toEqual([]);
      expect(endpoint.evidence()).toMatchObject({
        requestsAccepted: 0,
        requestsRejected: 1,
        lastRejectedReason: "FAROL_MODEL_SEALED",
      });
    } finally {
      request?.destroy();
      await endpoint.stop();
      await fs.rm(root, { recursive: true });
    }
  },
);

it.each(["/responses", "/responses/compact"])(
  "retains the original %s outcome when a seal lands after dispatch",
  async (route) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-sealed-turn-"));
    const state = new FarolModelRuntimeState(path.join(root, "endpoint"));
    let dispatches = 0;
    let dispatched: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let complete: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const observeDispatch = async () => {
      dispatches++;
      dispatched!();
      await pending;
    };
    const endpoint = new FarolModelEndpoint({
      state,
      model: "farol-next/mind",
      handler: async () => {
        await observeDispatch();
        return { ok: true, events: [] };
      },
      compactionHandler: async () => {
        await observeDispatch();
        return { ok: true, status: 200, body: "{}" };
      },
    });
    try {
      const { port } = await endpoint.start();
      const token = await state.currentToken();
      const response = fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "farol-next/mind", input: [] }),
      });
      await entered;
      endpoint.seal();
      complete!();
      const retained = await response;
      expect(retained.status).toBe(200);
      expect(await retained.text()).toBe(
        route === "/responses/compact" ? "{}" : "",
      );
      expect(dispatches).toBe(1);
      expect(endpoint.evidence()).toMatchObject({
        requestsAccepted: 1,
        requestsRejected: 0,
      });
    } finally {
      complete!();
      await endpoint.stop();
      await fs.rm(root, { recursive: true });
    }
  },
);

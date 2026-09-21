import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAROL_MODEL_RESPONSES_PATH,
  FarolModelEndpoint,
  routeBModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

// Where the Farol Model bridge stops being a stream.
//
// The inner Route B provider writes `response.created` and its output
// deltas as they are produced. The outer adapter reads the inner answer
// with `await response.text()`, which by specification consumes the whole
// body, builds the event array, and only then returns -- so the outer HTTP
// response is not even opened until the inner turn has finished. A
// one-frame fixture cannot tell the two apart; a two-phase upstream behind
// a barrier can, and that is what this pins.
//
// This is a characterisation test, not a defect claim: the boundary is
// deliberate today and the buffered adapter has real properties the
// streaming one must keep (a body that fails mid-read is a refusal, never
// an empty successful answer). It exists so that making the bridge stream
// is a deliberate edit here, with the first-frame assertion inverted, and
// never an accident.

const MODEL = "farol-next/mind";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-stream-"));
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * An inner Route B upstream in two phases: the first frame is written and
 * flushed at once, the rest waits for `release()`. `firstFrameFlushed`
 * resolves from the write callback, so it means the bytes left this
 * process, not merely that `write` was called.
 */
async function twoPhaseUpstream(): Promise<{
  baseUrl: string;
  token: string;
  firstFrameFlushed: Promise<void>;
  release: () => void;
}> {
  let flushed: () => void = () => undefined;
  const firstFrameFlushed = new Promise<void>((resolve) => {
    flushed = resolve;
  });
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200).end("pong");
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseFrame("response.created", { type: "response.created" }),
        () => flushed(),
      );
      void barrier.then(() => {
        response.write(
          sseFrame("response.completed", {
            type: "response.completed",
            response: { status: "completed" },
          }),
        );
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "inner-route-b-token",
    firstFrameFlushed,
    release,
  };
}

/** Prove the event loop has serviced socket I/O in both directions. */
async function upstreamRoundTrip(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/ping`);
  expect(await response.text()).toBe("pong");
}

describe("Farol Model bridge to Route B", () => {
  it("opens its own response only once the inner turn has completed", async () => {
    const upstream = await twoPhaseUpstream();
    const state = new FarolModelRuntimeState(await stateRoot());
    const endpoint = new FarolModelEndpoint({
      state,
      model: MODEL,
      handler: routeBModelTurnHandler(() => ({
        baseUrl: upstream.baseUrl,
        token: upstream.token,
      })),
    });
    closers.push(() => endpoint.stop());
    const { port } = await endpoint.start();
    const token = (await state.currentToken()) as string;

    let outerResponseOpened = false;
    let outerBody = "";
    const body = JSON.stringify({ model: MODEL, stream: true, store: false });
    const answered = new Promise<number>((resolve, reject) => {
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
          outerResponseOpened = true;
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (outerBody += chunk));
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end(body);
    });

    // The inner turn has produced its first frame and the loop has since
    // carried a whole request and answer to that same upstream, so nothing
    // is merely waiting to be scheduled.
    await upstream.firstFrameFlushed;
    await upstreamRoundTrip(upstream.baseUrl);
    expect(outerResponseOpened).toBe(false);
    expect(outerBody).toBe("");

    upstream.release();
    expect(await answered).toBe(200);
    // Every frame, in order, once the inner turn is over.
    expect(outerBody).toContain("event: response.created");
    expect(outerBody).toContain("event: response.completed");
    expect(outerBody.indexOf("response.created")).toBeLessThan(
      outerBody.indexOf("response.completed"),
    );
  });
});

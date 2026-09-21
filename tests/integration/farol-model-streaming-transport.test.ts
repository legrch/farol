import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAROL_MODEL_RESPONSES_COMPACT_PATH,
  FAROL_MODEL_RESPONSES_PATH,
  FarolModelEndpoint,
  routeBModelCompactionHandler,
  routeBModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

// S35 transport parity between the outer Farol Model endpoint and the inner
// Route B provider: frames relayed as they arrive, failures relayed as
// failures, a dead upstream never dressed up as a completed or an empty
// success, and the compaction route carried to the same provider with
// exactly one forwarded header. Every inner here is a synthetic HTTP server
// that scripts one behaviour; the real inner provider is exercised by the
// parity rows beside this file.

const MODEL = "farol-next/mind";
const INNER_TOKEN = "inner-route-b-token";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-relay-"));
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type InnerScript = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body: string,
) => void;

async function inner(script: InnerScript): Promise<{
  baseUrl: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
}> {
  const requests: Array<{ path: string; headers: http.IncomingHttpHeaders }> =
    [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", headers: request.headers });
      script(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function outer(
  baseUrl: string,
): Promise<{ port: number; token: string }> {
  const state = new FarolModelRuntimeState(await stateRoot());
  const target = () => ({ baseUrl, token: INNER_TOKEN });
  const endpoint = new FarolModelEndpoint({
    state,
    model: MODEL,
    handler: routeBModelTurnHandler(target),
    compactionHandler: routeBModelCompactionHandler(target),
  });
  closers.push(() => endpoint.stop());
  const { port } = await endpoint.start();
  return { port, token: (await state.currentToken()) as string };
}

function post(
  port: number,
  token: string,
  requestPath: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; body: string; contentType: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: text,
            contentType: String(response.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const events = (body: string) =>
  body
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => block.slice("event: ".length, block.indexOf("\n")));

describe("S35 transport parity: the outer Farol Model relays Route B truthfully", () => {
  it("relays an inner response.failed as a failure, never as completed", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseFrame("response.created", { type: "response.created" }),
      );
      response.end(
        sseFrame("response.failed", {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "ROUTE_B_THREAD_BUSY" },
          },
        }),
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(200);
    expect(events(answer.body)).toEqual([
      "response.created",
      "response.failed",
    ]);
    expect(answer.body).toContain("ROUTE_B_THREAD_BUSY");
    expect(answer.body).not.toContain("response.completed");
    expect(upstream.requests).toHaveLength(1);
  });

  it("ends an already-open stream with response.failed when the inner dies, and never completes it", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseFrame("response.created", { type: "response.created" }),
        () => response.socket?.destroy(),
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(200);
    expect(events(answer.body)).toEqual([
      "response.created",
      "response.failed",
    ]);
    expect(answer.body).toContain('"code":"FAROL_MODEL_ROUTE_UNREACHABLE"');
    expect(answer.body).not.toContain("response.completed");
    // Exactly one upstream request: the death was not retried.
    expect(upstream.requests).toHaveLength(1);
  });

  it("refuses a 200 that ends before its first frame instead of answering an empty success", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end();
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body).error.code).toBe(
      "FAROL_MODEL_ROUTE_UNREACHABLE",
    );
    expect(upstream.requests).toHaveLength(1);
  });

  it("forwards x-codex-turn-metadata on /responses and nothing else of the caller's", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sseFrame("response.completed", {
          type: "response.completed",
          response: { status: "completed" },
        }),
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {
        "x-codex-turn-metadata": '{"conversation_id":"c-1"}',
        "x-farol-caller": "no",
      },
      { model: MODEL },
    );
    expect(answer.status).toBe(200);
    const seen = upstream.requests[0]?.headers ?? {};
    expect(seen["x-codex-turn-metadata"]).toBe('{"conversation_id":"c-1"}');
    expect(seen["x-farol-caller"]).toBeUndefined();
    expect(seen.authorization).toBe(`Bearer ${INNER_TOKEN}`);
    expect(seen.origin).toBeUndefined();
  });

  it("carries /responses/compact to the same provider and relays its unary answer verbatim", async () => {
    const upstream = await inner((request, response) => {
      if (request.url !== "/responses/compact") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ replacement: ["history"], epoch: 2 }));
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_COMPACT_PATH,
      { "x-codex-turn-metadata": '{"conversation_id":"c-2"}' },
      { model: MODEL, input: [] },
    );
    expect(answer.status).toBe(200);
    expect(answer.contentType).toContain("application/json");
    expect(JSON.parse(answer.body)).toEqual({
      replacement: ["history"],
      epoch: 2,
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.path).toBe("/responses/compact");
    expect(upstream.requests[0]?.headers["x-codex-turn-metadata"]).toBe(
      '{"conversation_id":"c-2"}',
    );
    expect(upstream.requests[0]?.headers.authorization).toBe(
      `Bearer ${INNER_TOKEN}`,
    );
  });

  it("relays the inner compaction refusal with its status and code, not a synthesized one", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "FAROL_NEXT_COMPACTION_IDENTITY_MISMATCH" },
        }),
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_COMPACT_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.body).error.code).toBe(
      "FAROL_NEXT_COMPACTION_IDENTITY_MISMATCH",
    );
  });

  it("still checks the caller's model and token on the compaction route", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const { port, token } = await outer(upstream.baseUrl);
    const wrongModel = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_COMPACT_PATH,
      {},
      {
        model: "other/model",
      },
    );
    expect(wrongModel.status).toBe(422);
    expect(JSON.parse(wrongModel.body).error.code).toBe(
      "FAROL_MODEL_MODEL_MISMATCH",
    );
    const wrongToken = await post(
      port,
      "not-the-token",
      FAROL_MODEL_RESPONSES_COMPACT_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(wrongToken.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses a redirecting inner with one request and never follows it off-provider", async () => {
    const elsewhere = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" }).end();
    });
    const upstream = await inner((_request, response) => {
      response.writeHead(307, { location: `${elsewhere.baseUrl}/responses` });
      response.end();
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body).error.code).toBe(
      "FAROL_MODEL_ROUTE_UNREACHABLE",
    );
    expect(upstream.requests).toHaveLength(1);
    expect(elsewhere.requests).toHaveLength(0);
    const compact = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_COMPACT_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(compact.status).toBe(502);
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("parses CRLF framing, a CRLF split across chunks, and repeated data lines", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // The CR of the first CRLF blank line ends one chunk; its LF opens the
      // next. A second frame carries its JSON over two `data:` lines.
      response.write(
        'event: response.created\r\ndata: {"type":"response.created"}\r\n\r',
        () => {
          response.write(
            '\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"hi"}\r\n\r\n',
            () => {
              response.end(
                'event: response.completed\rdata: {"type":"response.completed"}\r\r',
              );
            },
          );
        },
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(answer.status).toBe(200);
    expect(events(answer.body)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(answer.body).toContain('"delta":"hi"');
    expect(answer.body).not.toContain("\r");
  });

  it("does not add a second failure when the inner already rendered its terminal frame", async () => {
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseFrame("response.created", { type: "response.created" }),
      );
      response.write(
        sseFrame("response.failed", {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "ROUTE_B_THREAD_BUSY" },
          },
        }),
        () => response.socket?.destroy(),
      );
    });
    const { port, token } = await outer(upstream.baseUrl);
    const answer = await post(
      port,
      token,
      FAROL_MODEL_RESPONSES_PATH,
      {},
      {
        model: MODEL,
      },
    );
    expect(events(answer.body)).toEqual([
      "response.created",
      "response.failed",
    ]);
    expect(answer.body).not.toContain("FAROL_MODEL_ROUTE_UNREACHABLE");
  });

  it("drains the inner turn to its end after the caller leaves mid-stream, without a retry", async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let innerFinished = false;
    const upstream = await inner((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseFrame("response.created", { type: "response.created" }),
      );
      void barrier.then(() => {
        response.end(
          sseFrame("response.completed", {
            type: "response.completed",
            response: { status: "completed" },
          }),
          () => {
            innerFinished = true;
          },
        );
      });
    });
    const { port, token } = await outer(upstream.baseUrl);
    const body = JSON.stringify({ model: MODEL });
    const firstFrame = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
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
            response.once("data", () => resolve(response));
          },
        );
        request.on("error", reject);
        request.end(body);
      },
    );
    // The caller goes away after the first frame while the inner turn is
    // still held behind the barrier.
    firstFrame.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const deadline = Date.now() + 5_000;
    while (!innerFinished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(innerFinished).toBe(true);
    expect(upstream.requests).toHaveLength(1);
  });
});

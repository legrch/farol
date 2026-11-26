import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  authorized,
  json,
  readBody,
  refusal,
  startStream,
  writeChunk,
  writeEvent,
} from "./http";

function fakeResponse(options: { accept?: boolean } = {}) {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const head: { status?: number; headers?: Record<string, unknown> } = {};
  const response = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    written,
    head,
    body: "",
    flushed: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      head.status = status;
      head.headers = headers;
    },
    flushHeaders() {
      response.flushed = true;
    },
    write(value: string) {
      written.push(value);
      return options.accept ?? true;
    },
    end(value: string) {
      response.body = value;
      response.writableEnded = true;
    },
  });
  return response;
}

function asResponse(value: unknown): ServerResponse {
  return value as ServerResponse;
}

function request(chunks: readonly (string | Buffer)[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

describe("provider http", () => {
  it("compares the bearer token without accepting near matches", () => {
    const withHeader = (authorization?: string) =>
      ({ headers: { authorization } }) as unknown as IncomingMessage;
    expect(authorized(withHeader("Bearer tok"), "tok")).toBe(true);
    expect(authorized(withHeader("Bearer toK"), "tok")).toBe(false);
    expect(authorized(withHeader("Bearer tok "), "tok")).toBe(false);
    expect(authorized(withHeader(undefined), "tok")).toBe(false);
  });

  it("answers JSON with a byte length and no caching", () => {
    const response = fakeResponse();
    json(asResponse(response), 201, { name: "é" });
    expect(response.head.status).toBe(201);
    expect(response.head.headers).toEqual({
      "cache-control": "no-store",
      "content-length": Buffer.byteLength('{"name":"é"}'),
      "content-type": "application/json; charset=utf-8",
    });
    expect(response.body).toBe('{"name":"é"}');
  });

  it("refuses with a coded error body", () => {
    const response = fakeResponse();
    refusal(asResponse(response), 403, "NOPE");
    expect(response.head.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "NOPE" } });
  });

  it("reads a JSON body and refuses an oversized or unreadable one", async () => {
    await expect(
      readBody(request(['{"a":', Buffer.from("1}")])),
    ).resolves.toEqual({ a: 1 });
    await expect(readBody(request(["{broken"]))).rejects.toThrow(
      "FAROL_REQUEST_INVALID",
    );
    await expect(
      readBody(request([Buffer.alloc(1_024 * 1_024 + 1)])),
    ).rejects.toThrow("FAROL_REQUEST_TOO_LARGE");
    await expect(
      readBody(request([Buffer.alloc(1_024 * 1_024, "x")])),
    ).rejects.toThrow("FAROL_REQUEST_INVALID");
  });

  it("opens an event stream with the buffering headers off", () => {
    const response = fakeResponse();
    startStream(asResponse(response));
    expect(response.head.status).toBe(200);
    expect(response.head.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    expect(response.flushed).toBe(true);
  });

  it("writes one event frame", async () => {
    const response = fakeResponse();
    await writeEvent(asResponse(response), "tick", { n: 1 });
    expect(response.written).toEqual(['event: tick\ndata: {"n":1}\n\n']);
  });

  it("fails a write to a closed response as lost delivery", async () => {
    const response = fakeResponse();
    response.destroyed = true;
    await expect(writeChunk(asResponse(response), "x")).rejects.toThrow(
      "FAROL_HOST_DELIVERY_LOST",
    );
    expect(response.written).toEqual([]);
  });

  it("waits for drain under backpressure and fails when the peer closes", async () => {
    const draining = fakeResponse({ accept: false });
    const pending = writeChunk(asResponse(draining), "x");
    draining.emit("drain");
    await expect(pending).resolves.toBeUndefined();

    const closing = fakeResponse({ accept: false });
    const lost = writeChunk(asResponse(closing), "x");
    closing.emit("close");
    await expect(lost).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
  });
});

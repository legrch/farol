import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";

// The provider's HTTP plumbing: bearer check, JSON and refusal replies, the
// bounded request-body read and the server-sent-event stream writes. None of
// it knows what a turn is.

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;

export function authorized(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const supplied = Buffer.from(request.headers.authorization ?? "", "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

export function refusal(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  json(response, status, { error: { code } });
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("FAROL_REQUEST_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("FAROL_REQUEST_INVALID");
  }
}

export async function writeChunk(
  response: ServerResponse,
  value: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error("FAROL_HOST_DELIVERY_LOST");
  }
  if (response.write(value)) return;
  await Promise.race([
    once(response, "drain"),
    once(response, "close").then(() => {
      throw new Error("FAROL_HOST_DELIVERY_LOST");
    }),
  ]);
}

export async function writeEvent(
  response: ServerResponse,
  event: string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeChunk(
    response,
    `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`,
  );
}

export function startStream(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

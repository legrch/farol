import type { ServerResponse } from "node:http";

/** One SSE frame of an OpenAI Responses API stream. */
export type FarolModelSseEvent = Readonly<{
  event: string;
  data: unknown;
}>;

export const SSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
});

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export function isTerminalFrame(frame: FarolModelSseEvent): boolean {
  return TERMINAL_EVENTS.has(frame.event);
}

export function sseFrame(frame: FarolModelSseEvent): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/**
 * The one frame that ends an open outer stream whose upstream died before it
 * stated its own outcome: the host contract's shape for a turn this process
 * cannot vouch for, never a `response.completed` it did not receive.
 */
export function relayFailureFrame(model: string): FarolModelSseEvent {
  return {
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        model,
        status: "failed",
        error: { code: "FAROL_MODEL_ROUTE_UNREACHABLE" },
      },
    },
  };
}

/**
 * Frames parsed as the inner body arrives: each complete `event/data` block
 * is yielded as soon as its terminating blank line is in, so the caller can
 * relay it before the upstream turn has finished. A read failure propagates
 * to the consumer, which decides what a death before or after the first
 * frame means.
 */
export async function* sseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<FarolModelSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // SSE line endings are LF, CRLF or a lone CR. Everything is normalised to
  // LF before blocks are cut, and a CR at the very end of a chunk is held
  // back until the next chunk shows whether an LF follows it, so a CRLF
  // split across two reads is still one line ending.
  let carry = "";
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let raw = carry + decoder.decode(value, { stream: true });
      carry = "";
      if (raw.endsWith("\r")) {
        carry = "\r";
        raw = raw.slice(0, -1);
      }
      buffered += raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const event = parseSseBlock(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 2);
        if (event) yield event;
        boundary = buffered.indexOf("\n\n");
      }
    }
    buffered += (carry + decoder.decode())
      .replace(/\r\n/gu, "\n")
      .replace(/\r/gu, "\n");
    for (const block of buffered.split("\n\n")) {
      const tail = parseSseBlock(block);
      if (tail) yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): FarolModelSseEvent | null {
  if (block.trim().length === 0) return null;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = sseFieldValue(line, "event:");
    else if (line.startsWith("data:")) data.push(sseFieldValue(line, "data:"));
  }
  if (event === undefined || data.length === 0) return null;
  // Repeated `data:` lines are one value joined by LF (the SSE contract).
  const rawData = data.join("\n");
  try {
    return { event, data: JSON.parse(rawData) };
  } catch {
    return { event, data: rawData };
  }
}

function sseFieldValue(line: string, field: string): string {
  const value = line.slice(field.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

/**
 * One frame onto the socket. `write` returning false means the kernel
 * buffer is full: wait for `drain` (or for the peer to go, in which case
 * nothing more is written and the caller keeps draining the upstream).
 */
export function writeFrame(
  response: ServerResponse,
  frame: FarolModelSseEvent,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) return Promise.resolve();
  if (response.write(sseFrame(frame)) || isClosed()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      response.off("error", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
    response.once("error", done);
  });
}

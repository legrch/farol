import { describe, expect, it } from "vitest";
import {
  isTerminalFrame,
  relayFailureFrame,
  sseEventStream,
  sseFrame,
  writeFrame,
} from "./sse";

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const frame of sseEventStream(bodyOf(chunks))) out.push(frame);
  return out;
}

describe("sse frames", () => {
  it("renders event and JSON data with a blank-line terminator", () => {
    expect(sseFrame({ event: "e", data: { a: 1 } })).toBe(
      'event: e\ndata: {"a":1}\n\n',
    );
  });
  it("knows the three terminal events", () => {
    for (const event of [
      "response.completed",
      "response.failed",
      "response.incomplete",
    ])
      expect(isTerminalFrame({ event, data: {} })).toBe(true);
    expect(isTerminalFrame({ event: "response.created", data: {} })).toBe(
      false,
    );
  });
  it("builds the relay failure frame", () => {
    expect(relayFailureFrame("m")).toEqual({
      event: "response.failed",
      data: {
        type: "response.failed",
        response: {
          model: "m",
          status: "failed",
          error: { code: "FAROL_MODEL_ROUTE_UNREACHABLE" },
        },
      },
    });
  });
});

describe("sseEventStream", () => {
  it("parses frames split across chunks and a CRLF split across reads", async () => {
    expect(
      await collect([
        "event: a\r",
        '\ndata: {"x":1}\r\n\r',
        "\nevent: b\ndata: t\n\n",
      ]),
    ).toEqual([
      { event: "a", data: { x: 1 } },
      { event: "b", data: "t" },
    ]);
  });
  it("joins repeated data lines and flushes an unterminated tail", async () => {
    expect(
      await collect(["event: a\ndata: 1\ndata: 2\n\nevent: b\ndata: 3"]),
    ).toEqual([
      { event: "a", data: "1\n2" },
      { event: "b", data: 3 },
    ]);
  });
  it("drops blocks missing event or data", async () => {
    expect(await collect(["data: 1\n\nevent: a\n\n: c\n\n"])).toEqual([]);
  });
});

describe("writeFrame", () => {
  it("writes nothing once the peer is gone", async () => {
    const written: string[] = [];
    const response = { write: (s: string) => (written.push(s), true) };
    await writeFrame(response as never, { event: "e", data: 1 }, () => true);
    expect(written).toEqual([]);
    await writeFrame(response as never, { event: "e", data: 1 }, () => false);
    expect(written).toEqual(["event: e\ndata: 1\n\n"]);
  });
});

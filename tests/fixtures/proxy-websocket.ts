import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Writable } from "node:stream";

export const websocketFixturePrelude = `
const fixtureTransport = require(${JSON.stringify(fileURLToPath(new URL("./proxy-websocket.cjs", import.meta.url)))}).serve(process.stdin, process.stdout);
const fixtureInput = fixtureTransport.input;
const fixtureOutput = fixtureTransport.output;
`;

/** Decode actual masked client frames, independent of production adapter code. */
export function clientMessages(chunks: Array<Uint8Array | string>): unknown[] {
  const { Receiver } = createRequire(import.meta.url)("ws") as {
    Receiver: new (options: { isServer: true; maxPayload: number }) => Writable;
  };
  const receiver = new Receiver({
    isServer: true,
    maxPayload: 8 * 1024 * 1024,
  });
  const messages: unknown[] = [];
  receiver.on("message", (data: Buffer) =>
    messages.push(JSON.parse(data.toString())),
  );
  for (const chunk of chunks) receiver.write(chunk);
  receiver.end();
  return messages;
}

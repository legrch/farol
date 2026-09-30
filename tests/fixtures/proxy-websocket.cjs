const { createServer } = require("node:http");
const { Duplex, PassThrough, Writable } = require("node:stream");
const { WebSocketServer } = require("ws");

// Test-only application shim. The real child pipes carry HTTP Upgrade and WS
// frames; only the existing fixture's in-process application uses JSON lines.
exports.serve = (readable, writable) => {
  const input = new PassThrough();
  let peer;
  let pending = Buffer.alloc(0);
  const output = new Writable({
    write(chunk, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        const message = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        peer.send(message, { binary: false });
      }
      done();
    },
  });
  const stream = new Duplex({
    read() {
      readable.resume();
    },
    write(chunk, encoding, done) {
      writable.write(chunk, encoding, done);
    },
  });
  readable.on("data", (chunk) => {
    if (!stream.push(chunk)) readable.pause();
  });
  readable.on("end", () => stream.push(null));
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("clientError", () => stream.destroy());
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/rpc") throw new Error("FIXTURE_WRONG_WS_PATH");
    ws.handleUpgrade(request, socket, head, (client) => {
      peer = client;
      peer.on("error", () => {});
      peer.on("message", (data, binary) => {
        if (binary) throw new Error("FIXTURE_BINARY_RPC");
        input.write(Buffer.concat([data, Buffer.from("\n")]));
      });
    });
  });
  server.emit("connection", stream);
  return {
    input,
    output,
    get peer() {
      return peer;
    },
  };
};

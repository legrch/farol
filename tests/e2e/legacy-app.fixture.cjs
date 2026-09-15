"use strict";

const { createServer } = require("node:http");
const { app } = require("electron");

app.setName("Farol Legacy Lifecycle Fixture");

let server = null;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  app.quit();
}

async function main() {
  await app.whenReady();
  server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/synthetic/read") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("legacy-fixture-read-ok\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LEGACY_FIXTURE_ADDRESS_INVALID");
  }
  process.send?.({
    kind: "legacy-fixture.ready",
    pid: process.pid,
    port: address.port,
  });
  process.on("message", (message) => {
    if (message === "shutdown") void stop();
  });
  app.on("before-quit", () => {
    stopping = true;
    server?.close();
  });
}

void main().catch((error) => {
  process.stderr.write(
    `legacy lifecycle fixture failed: ${error?.stack ?? error}\n`,
  );
  app.exit(1);
});

"use strict";

// Instrument only the disposable tunnel fixture, never the production runtime.
// The sibling is copied from tunnel-client.fixture.cjs. No remote tunnel or
// provider is contacted and the supplied MCP command is never executed.
if (process.argv[2] === "run") {
  const fs = require("node:fs");
  const path = require("node:path");
  const http = require("node:http");
  const { randomUUID } = require("node:crypto");
  const root = process.env.TUNNEL_CLIENT_STATE_DIR;
  if (!root || !path.isAbsolute(root)) process.exit(64);
  const id = randomUUID();
  const file = path.join(root, `daily-tunnel-${id}.json`);
  const receipt = {
    schema: "farol.daily-tunnel-fixture/1",
    id,
    pid: process.pid,
    parentPid: process.ppid,
    startedAt: new Date().toISOString(),
    phase: "running",
    healthRequests: 0,
    termRequested: false,
    exitCode: null,
  };
  // A separate bounded journal distinguishes signal delivery/exit from a
  // receipt rename interrupted by group escalation. Synthetic fixture only.
  const journal = [];
  function trace(event) {
    if (journal.length >= 32) process.exit(66);
    journal.push({
      event,
      at: new Date().toISOString(),
      monotonicNs: String(process.hrtime.bigint()),
    });
    const traceFile = `${file}.trace.json`;
    fs.writeFileSync(`${traceFile}.tmp`, JSON.stringify(journal) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(`${traceFile}.tmp`, traceFile);
  }
  function record() {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(receipt) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  }
  trace("started");
  record();
  process.once("SIGTERM", () => {
    trace("term-received");
    receipt.termRequested = true;
  });
  process.once("exit", (code) => {
    trace("exit-started");
    receipt.phase = "exited";
    receipt.exitCode = code;
    trace("exit-receipt-write-started");
    record();
    trace("exit-receipt-written");
  });
  const createServer = http.createServer;
  http.createServer = (listener) =>
    createServer((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        if (++receipt.healthRequests > 256) process.exit(65);
        record();
      }
      listener(request, response);
    });
}
require("./tunnel-client.fixture.cjs");

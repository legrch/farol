"use strict";

// Disposable child instrumentation only. Reuse the existing probe/init/doctor/
// run fixture; never execute its MCP command or contact a hosted control plane.
if (process.argv[2] === "run") {
  const fs = require("node:fs");
  const path = require("node:path");
  const http = require("node:http");
  const { randomUUID } = require("node:crypto");
  const root = process.env.TUNNEL_CLIENT_STATE_DIR;
  if (!root || !path.isAbsolute(root)) process.exit(64);
  const id = randomUUID();
  const file = path.join(root, `polling-tunnel-${id}.json`);
  const controlFile = path.join(root, "polling-control.json");
  const record = {
    id,
    pid: process.pid,
    parentPid: process.ppid,
    phase: "running",
    readyRequests: 0,
    metricsRequests: 0,
    aborted: 0,
    lastMode: null,
    exitCode: null,
  };
  const save = () => {
    fs.writeFileSync(file + ".tmp", JSON.stringify(record) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(file + ".tmp", file);
  };
  const mode = () => {
    try {
      const data = fs.readFileSync(controlFile);
      if (data.length > 1024) return "missing";
      const value = JSON.parse(data).mode;
      return [
        "recent",
        "stale",
        "no_success",
        "missing",
        "http503",
        "http504",
        "hold",
      ].includes(value)
        ? value
        : "missing";
    } catch {
      return "recent";
    }
  };
  save();
  process.once("exit", (code) => {
    record.phase = "exited";
    record.exitCode = code;
    save();
  });
  const create = http.createServer;
  http.createServer = (listener) =>
    create((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        if (++record.readyRequests > 512) process.exit(65);
        save();
      }
      if (request.method !== "GET" || request.url !== "/metrics")
        return listener(request, response);
      if (++record.metricsRequests > 32) process.exit(66);
      const selected = mode();
      record.lastMode = selected;
      save();
      if (selected === "hold") {
        response.once("close", () => {
          record.aborted++;
          save();
        });
        return;
      }
      if (selected.startsWith("http"))
        return response
          .writeHead(Number(selected.slice(4)))
          .end("synthetic hosted-like failure");
      if (selected === "missing")
        return response.writeHead(200).end("unrelated_metric 1\n");
      const last =
        selected === "no_success"
          ? 0
          : Math.floor(Date.now() / 1000) - (selected === "stale" ? 120 : 0);
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        "cache-control": "no-store",
      });
      response.end(
        `commands_poll_cycles_total 10\ncommands_poll_errors_total ${selected === "stale" ? 3 : 0}\ncommands_poll_last_successful_timestamp_seconds ${last}\n`,
      );
    });
}
require("./tunnel-client.fixture.cjs");

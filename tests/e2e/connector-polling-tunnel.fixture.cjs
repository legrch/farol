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
  // Synthetic producer history only; the actual child/pipe lifecycle remains
  // separately recorded. These timestamps do not prove any upstream poll.
  const healthStarted = Date.now() - 3600000;
  const healthControl = path.join(root, "health-control.json");
  const file = path.join(root, `polling-tunnel-${id}.json`);
  const controlFile = path.join(root, "polling-control.json");
  const networkControl = path.join(root, "network-control.json");
  const record = {
    id,
    pid: process.pid,
    parentPid: process.ppid,
    phase: "running",
    readyRequests: 0,
    metricsRequests: 0,
    healthRequests: 0,
    healthCompleted: 0,
    healthAborted: 0,
    lastHealthSettlement: null,
    lastHealthMode: null,
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
  const healthMode = () => {
    try {
      const bytes = fs.readFileSync(healthControl);
      if (bytes.length > 1024) return "malformed";
      const mode = JSON.parse(bytes).mode;
      return [
        "recent",
        "future-failure",
        "stale",
        "first-poll",
        "backpressure",
        "http503",
        "http504",
        "auth401",
        "malformed",
        "unsupported",
        "missing",
        "hold",
      ].includes(mode)
        ? mode
        : "malformed";
    } catch {
      return "recent";
    }
  };
  const health = (request, response) => {
    if (++record.healthRequests > 128) process.exit(67);
    const selected = healthMode();
    const sequence = record.healthRequests;
    const started = process.hrtime.bigint();
    const settle = (outcome) => {
      record[outcome === "completed" ? "healthCompleted" : "healthAborted"]++;
      if ((record.lastHealthSettlement?.sequence ?? 0) <= sequence)
        record.lastHealthSettlement = {
          sequence,
          mode: selected,
          outcome,
          durationMillis: Number(
            (process.hrtime.bigint() - started) / 1000000n,
          ),
        };
      save();
    };
    response.once("finish", () => settle("completed"));
    response.once("close", () => {
      if (!response.writableFinished) settle("aborted");
    });
    record.lastHealthMode = selected;
    save();
    if (selected === "hold") return;
    if (selected === "missing") return response.writeHead(404).end();
    if (selected === "malformed")
      return response.writeHead(200).end("not-json");
    const now = Date.now(),
      at = (value) => new Date(value).toISOString();
    const pending = selected === "first-poll" || selected === "backpressure";
    const failed = selected.startsWith("http") || selected === "auth401";
    const lastSuccess = selected === "stale" ? now - 120000 : now - 1000;
    const observed = pending ? now - 60000 : now;
    const details = {
      last_attempt: at(pending ? now - 60000 : now - 1000),
      ...(pending ? {} : { last_success: at(lastSuccess) }),
      consecutive_failures: failed ? 1 : 0,
      current_poll_age_seconds: selected === "first-poll" ? 60 : 0,
      configured_wait_seconds: 120,
      effective_wait_seconds: 120,
      deadline_seconds: 180,
      ...(selected === "future-failure"
        ? { failure_category: "future_error" }
        : {}),
      ...(failed
        ? {
            last_error: at(now),
            next_retry: at(now + 5000),
            failure_category: "http_error",
            http_status:
              selected === "auth401" ? 401 : Number(selected.slice(4)),
          }
        : {}),
    };
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        schema_version: selected === "unsupported" ? 99 : 1,
        live: true,
        ready: true,
        snapshot_at: at(now),
        runtime: {
          instance_id: id,
          started_at: at(healthStarted),
          lifecycle: "running",
        },
        components: {
          "control-plane": {
            status: failed ? "degraded" : pending ? "unknown" : "ok",
            state: failed
              ? "backoff"
              : selected === "first-poll"
                ? "polling"
                : selected === "backpressure"
                  ? "backpressured"
                  : "idle",
            observed_at: at(observed),
            limited: false,
            details,
          },
          "response-delivery": {
            status: "unknown",
            state: "not_observed",
            limited: false,
            details: {
              in_progress: 0,
              attempts: 0,
              retries: 0,
              accepted: 0,
              completed: 0,
              terminal_failures: 0,
              disposition: "not_observed",
            },
          },
        },
      }),
    );
  };
  save();
  process.once("exit", (code) => {
    record.phase = "exited";
    record.exitCode = code;
    save();
  });
  // Connection-level loss of this helper's loopback transport. A lost transport
  // closes the socket without any HTTP response; it never answers 5xx. The
  // loss ledger appears in the receipt only after the first lost connection, so
  // every other mode leaves the receipt shape unchanged.
  const lost = () => {
    try {
      const data = fs.readFileSync(networkControl);
      return data.length <= 1024 && JSON.parse(data).mode === "lost";
    } catch {
      return false;
    }
  };
  const note = (label) => {
    const loss = (record.loss ??= {
      connections: 0,
      requests: 0,
      readyz: 0,
      health: 0,
      metrics: 0,
      other: 0,
      log: [],
    });
    if (label === null) loss.connections++;
    else {
      loss.requests++;
      loss[
        label === "GET /readyz"
          ? "readyz"
          : label === "GET /health?details=true"
            ? "health"
            : label === "GET /metrics"
              ? "metrics"
              : "other"
      ]++;
    }
    if (loss.log.length < 256)
      loss.log.push({ at: Date.now(), kind: label ?? "connection" });
    save();
  };
  // The request line classifies the attempt; the socket is then closed with no
  // HTTP response at all.
  const refuse = (socket, label) => {
    note(label);
    socket.destroy();
  };
  const create = http.createServer;
  http.createServer = (listener) => {
    const server = create((request, response) => {
      if (lost())
        return refuse(
          request.socket,
          `${request.method} ${request.url}`.slice(0, 64),
        );
      // After the first lost connection the ledger also stamps requests that
      // were served, so a harness can place the first healthy probe in time.
      if (record.loss && record.loss.log.length < 256)
        record.loss.log.push({
          at: Date.now(),
          kind: `ok ${request.method} ${request.url}`.slice(0, 64),
        });
      if (request.method === "GET" && request.url === "/readyz") {
        if (++record.readyRequests > 512) process.exit(65);
        save();
      }
      if (request.method === "GET" && request.url === "/health?details=true")
        return health(request, response);
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
    server.on("connection", (socket) => {
      if (lost()) note(null);
    });
    return server;
  };
}
require("./tunnel-client.fixture.cjs");

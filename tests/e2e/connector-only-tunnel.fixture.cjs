"use strict";

// Root-local synthetic tunnel only. Reuse canonical probe/init/doctor/run and
// loopback readiness. Never execute the supplied MCP command or dial a provider.
if (process.argv[2] === "run") {
  const fs = require("node:fs");
  const path = require("node:path");
  const { randomUUID } = require("node:crypto");
  const root = process.env.TUNNEL_CLIENT_STATE_DIR;
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root)
    process.exit(64);
  const id = randomUUID();
  const file = path.join(root, `connector-only-${id}.json`);
  const stopFile = path.join(root, `connector-only-stop-${id}.json`);
  const record = {
    id,
    pid: process.pid,
    parentPid: process.ppid,
    executable: __filename,
    argv: process.argv.slice(2),
    phase: "running",
    stopConsumed: false,
    exitCode: null,
  };
  const save = () => {
    fs.writeFileSync(file + ".tmp", JSON.stringify(record) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(file + ".tmp", file);
  };
  save();
  process.once("exit", (code) => {
    record.phase = "exited";
    record.exitCode = code;
    save();
  });
  // A single nonce-bound local request settles this exact fixture after the
  // anchor's loss. The harness never signals an orphan by numeric PID. Missing
  // receipts/timeouts remain unknown; no automatic retry or timed success.
  const timer = setInterval(() => {
    let fd;
    try {
      fd = fs.openSync(
        stopFile,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const before = fs.fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 1024 ||
        before.uid !== process.getuid() ||
        (before.mode & 0o777) !== 0o600
      )
        throw new Error("CONNECTOR_FIXTURE_STOP_UNSAFE");
      const request = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (
        request.id !== id ||
        request.pid !== process.pid ||
        request.action !== "stop" ||
        Object.keys(request).sort().join(",") !== "action,id,pid"
      )
        throw new Error("CONNECTOR_FIXTURE_STOP_MISMATCH");
      clearInterval(timer);
      record.stopConsumed = true;
      save();
      // Canonical tunnel fixture owns its SIGTERM handler and terminal code.
      process.kill(process.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }, 50);
}
require("./tunnel-client.fixture.cjs");

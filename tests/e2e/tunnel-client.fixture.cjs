"use strict";

// Synthetic stand-in for the owner's real `tunnel-client` executable — the
// OpenAI secure-MCP tunnel client that Farol probes, configures,
// doctors, and supervises through `SecureMcpConnectorRuntime` once
// `FAROL_E2E_TUNNEL_CLIENT` names it (see
// vnext/src/apps/desktop/secure-mcp-connector-runtime.ts and
// vnext/src/apps/desktop/tunnel-client-probe.ts). It speaks only to
// 127.0.0.1 and never spawns a child, dials the `--mcp-command` it is
// handed, or reaches any control plane. It exists to prove that Farol's
// own probe/configure/doctor/start/stop state machine reacts correctly to
// a well-behaved local child, and — on request — to one that fails; it
// proves nothing about a real tunnel, provider, or MCP session, none of
// which this file has ever contacted.
//
// The harness that runs this fixture (vnext/tests/e2e/preview.e2e.mjs's
// `startTunnelClientFixture()`) reads this source as plain text and
// prepends its own `#!${process.execPath}\n` shebang before writing the
// runnable copy, so this file must stay valid CommonJS starting on line 1
// — do not add a shebang here.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// Every literal below is copied from the two files this fixture stands in
// for, not guessed:
//
// - `REQUIRED_FLAGS` mirrors `requiredSurfaces` in
//   vnext/src/apps/desktop/tunnel-client-probe.ts. The reviewed client exposes
//   doctor's flags through `doctor --help`; `help doctor` is prose and is not
//   a compatibility surface. Init and run retain `help <subcommand>`.
// - The exact argv shapes documented on each `run*` function below are
//   what `SecureMcpConnectorRuntime`
//   (vnext/src/apps/desktop/secure-mcp-connector-runtime.ts) actually
//   sends for `init` (:251-268), `doctor` (:282-290), and `run` (:322-338).
//   Note `init`'s `--health-listen-addr` (hyphen) and `run`'s
//   `--health.listen-addr` (dot) are genuinely different flag names in
//   that source, not a typo here.
const REQUIRED_FLAGS = {
  init: [
    "--profile",
    "--profile-dir",
    "--tunnel-id",
    "--control-plane-api-key-ref",
    "--health-listen-addr",
    "--mcp-command",
  ],
  doctor: ["--profile", "--profile-dir", "--json", "--explain"],
  run: [
    "--profile",
    "--profile-dir",
    "--health.listen-addr",
    "--health.url-file",
    "--pid.file",
  ],
};

// Flags this fixture's own argv parser treats as valueless switches. Every
// other `--flag` token consumes the argv element right after it as its
// value. This only has to cover what the real runtime ever sends — see the
// argv shapes cited above.
const BOOLEAN_FLAGS = new Set(["--force", "--json", "--explain"]);

// The reviewed binary emits one bare SemVer line for `--version`. The probe
// rejects prefixes, suffixes, multiple lines, and mixed stdout/stderr.
const VERSION = "1.0.0";

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    if (BOOLEAN_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    index += 1;
    flags.set(token, argv[index]);
  }
  return flags;
}

// Writes `content` by creating a sibling temp file and renaming it onto
// `targetPath`. `readHealthBaseUrl()`
// (secure-mcp-connector-runtime.ts:479-522) polls the health-url file
// straight off disk while `run` below is starting up; a plain write would
// let it observe a half-written value. The strict shape checks in that
// function throw a plain `Error` (`CONNECTOR_RUNTIME_UNSAFE`), which is
// neither the `ENOENT` nor the `TypeError` its own catch swallows, so a
// torn read would surface as an uncaught rejection out of `start()` rather
// than a harmless retry. A rename within the same directory is atomic on a
// local filesystem, so every reader sees either the previous content
// (absent, the first time) or the whole new value, never a fragment.
function writeFileAtomic(targetPath, content) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

function helpText(subcommand) {
  const lines = [`Usage: tunnel-client ${subcommand} [flags]`, "", "Flags:"];
  for (const flag of REQUIRED_FLAGS[subcommand]) {
    lines.push(`  ${flag}${BOOLEAN_FLAGS.has(flag) ? "" : " <value>"}`);
  }
  return `${lines.join("\n")}\n`;
}

// `init` — SecureMcpConnectorRuntime.configure()
// (secure-mcp-connector-runtime.ts:249-270) sends:
//   init --force --sample sample_mcp_stdio_local --profile <profile>
//        --profile-dir <dir> --tunnel-id <id>
//        --control-plane-api-key-ref <ref> --health-listen-addr 127.0.0.1:0
//        --mcp-command <command>
// and only awaits the call — it never reads stdout/stderr — so this only
// has to exit 0 and, per this fixture's own E2E contract, record its argv.
// Where this invocation should leave its argv record. The harness cannot
// pass `FAROL_E2E_TUNNEL_RECORD` through to `init`: `commandBase()`
// (secure-mcp-connector-runtime.ts:398-416) gives every tunnel-client
// invocation a fixed environment of its own, so the harness variable is
// dropped before this process starts. `TUNNEL_CLIENT_STATE_DIR` is in that
// fixed set and points inside the app's own state root, which the harness
// knows the path of, so that is the channel back. The variable is still
// honoured when it does arrive, which is what makes this file testable on
// its own from a shell.
function initRecordPath() {
  if (process.env.FAROL_E2E_TUNNEL_RECORD) {
    return process.env.FAROL_E2E_TUNNEL_RECORD;
  }
  const stateDir = process.env.TUNNEL_CLIENT_STATE_DIR;
  return stateDir ? path.join(stateDir, "farol-e2e-tunnel-init.json") : null;
}

function runInit(argv) {
  const recordPath = initRecordPath();
  if (recordPath) {
    // Preserve argv exactly, in order, including the `--mcp-command` value
    // as one element — preview.e2e.mjs's n09-connector case reads this
    // back and asserts `--tunnel-id` is immediately followed by the
    // tunnel id it typed into Settings.
    // Recording is evidence for the harness, never a reason to fail the
    // invocation the product is waiting on.
    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
      writeFileAtomic(recordPath, JSON.stringify(argv));
    } catch {
      // The product's own `init` still succeeded; the harness will say so.
    }
  }
  process.stdout.write("tunnel-client: init ok\n");
  process.exit(0);
}

// `doctor` — SecureMcpConnectorRuntime.doctor()
// (secure-mcp-connector-runtime.ts:276-296) sends:
//   doctor --profile <profile> --profile-dir <dir> --json --explain
// and, like configure(), never reads the resolved stdout/stderr — it only
// awaits the call and turns any rejection (non-zero exit, spawn failure)
// into CONNECTOR_DOCTOR_FAILED. The JSON printed below is shaped like a
// real doctor report for a human running this fixture by hand; nothing in
// the product parses it.
function runDoctor() {
  if (process.env.FAROL_E2E_TUNNEL_FAIL === "doctor") {
    process.stderr.write(
      "tunnel-client: doctor check failed (synthetic E2E failure)\n",
    );
    process.exit(1);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, checks: [], explain: [] })}\n`,
  );
  process.exit(0);
}

// `run` — SecureMcpConnectorRuntime.start()
// (secure-mcp-connector-runtime.ts:322-338) spawns this as a long-lived
// child with:
//   run --profile <profile> --profile-dir <dir>
//       --health.listen-addr 127.0.0.1:0 --health.url-file <file>
//       --pid.file <file> --log.format json --log.level info
// stdio is fully "ignore"d (startProcess(), same file :149-155), so
// nothing this prints is ever read; readiness is decided purely by
// polling GET <health base url>/readyz (getReady(), :184-196) against the
// URL this fixture writes to --health.url-file.
function runRun(argv) {
  if (process.env.FAROL_E2E_TUNNEL_FAIL === "run") {
    process.stderr.write(
      "tunnel-client: run failed to start (synthetic E2E failure)\n",
    );
    process.exit(1);
    return;
  }

  const flags = parseFlags(argv);
  const healthUrlFile = flags.get("--health.url-file");
  const pidFile = flags.get("--pid.file");
  if (typeof healthUrlFile !== "string" || typeof pidFile !== "string") {
    process.stderr.write(
      "tunnel-client: run requires --health.url-file and --pid.file\n",
    );
    process.exit(64);
    return;
  }

  let requestedPort = 0;
  const listenAddr = flags.get("--health.listen-addr");
  if (typeof listenAddr === "string") {
    const separator = listenAddr.lastIndexOf(":");
    const parsedPort = Number(listenAddr.slice(separator + 1));
    if (Number.isInteger(parsedPort) && parsedPort >= 0) {
      requestedPort = parsedPort;
    }
  }

  // Recorded as soon as the process exists, independent of whether the
  // health server below ever binds. Nothing in the runtime reads this
  // file back today, but a real client would not wait on its own health
  // listener to know its own PID.
  writeFileAtomic(pidFile, `${process.pid}\n`);

  // This is the one loopback surface this fixture serves. Farol's
  // `readHealthBaseUrl()` requires exactly this shape — http, host
  // "127.0.0.1", no userinfo/query/hash, a bare "/" path — so the URL
  // written below is built from a hardcoded scheme and host, never from
  // whatever `--health.listen-addr` said, to guarantee it always parses.
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/readyz") {
      const body = JSON.stringify({ status: "ok", pid: process.pid });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });

  server.on("error", (error) => {
    process.stderr.write(
      `tunnel-client: run failed: ${error && error.stack ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  });

  server.listen(requestedPort, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      process.stderr.write(
        "tunnel-client: run could not read back its own loopback port\n",
      );
      process.exit(1);
      return;
    }
    writeFileAtomic(healthUrlFile, `http://127.0.0.1:${address.port}/\n`);
    process.stdout.write(
      `tunnel-client: run ready on 127.0.0.1:${address.port}\n`,
    );
  });

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    process.exit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
    return;
  }
  if (argv[0] === "doctor" && argv[1] === "--help") {
    process.stdout.write(helpText("doctor"));
    process.exit(0);
    return;
  }
  if (argv[0] === "help" && argv[1] === "doctor") {
    process.stdout.write("Run diagnostics for a tunnel profile.\n");
    process.exit(0);
    return;
  }
  if (argv[0] === "help" && (argv[1] === "init" || argv[1] === "run")) {
    process.stdout.write(helpText(argv[1]));
    process.exit(0);
    return;
  }
  if (argv[0] === "init") {
    runInit(argv);
    return;
  }
  if (argv[0] === "doctor") {
    runDoctor();
    return;
  }
  if (argv[0] === "run") {
    runRun(argv);
    return;
  }
  process.stderr.write(
    `tunnel-client: unrecognized invocation: ${argv.join(" ")}\n`,
  );
  process.exit(64);
}

main();

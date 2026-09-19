#!/usr/bin/env node
// Farol Model credential helper.
//
// Prints the current Farol Model endpoint token to stdout and exits 0, or
// exits non-zero with a single readable reason line on stderr. It reads
// Farol's private runtime state directly (the same files
// `farol-model-runtime-state.ts` writes) — it never reads the token from an
// environment variable, and it never starts Farol.
//
// See Decisions.md N04, item 2. A GUI Codex has no shell to receive an
// environment variable from, so the managed config is meant to point a
// credential-retrieval field at this executable. As of codex-cli 0.153.4,
// `model_providers.<name>` (`ModelProviderInfo`) has no such field — only
// `env_key` (a static environment-variable name read once at process
// start) and `experimental_bearer_token` (a literal). This helper is still
// useful standalone (a shell can call it to populate that env var before
// invoking `codex`), but codex itself cannot invoke it as part of a
// GUI-launched, shell-less request. See the packet N04 report for the
// escalation this confirms.
//
// Usage: farol-model-credential-helper.mjs --state-root <private-state-dir>

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN_FILE = "model-endpoint-token";
const LIVENESS_FILE = "model-endpoint-liveness";

function fail(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const index = argv.indexOf("--state-root");
  if (index === -1 || argv[index + 1] === undefined) {
    return undefined;
  }
  return argv[index + 1];
}

async function assertPrivateFile(target) {
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("unsafe file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("file is not private");
  }
  return info;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function main() {
  const stateRoot = parseArgs(process.argv.slice(2));
  if (!stateRoot || !path.isAbsolute(stateRoot)) {
    fail("farol-model-credential-helper: missing --state-root <absolute-path>");
    return;
  }

  let livenessRaw;
  try {
    await assertPrivateFile(path.join(stateRoot, LIVENESS_FILE));
    livenessRaw = await fs.readFile(
      path.join(stateRoot, LIVENESS_FILE),
      "utf8",
    );
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail(
        "Farol is not running: no liveness marker at the configured state root",
      );
    } else {
      fail(
        `Farol is not running: liveness marker unreadable (${error?.message ?? error})`,
      );
    }
    return;
  }

  let liveness;
  try {
    liveness = JSON.parse(livenessRaw);
  } catch {
    fail("Farol is not running: liveness marker is not valid JSON");
    return;
  }
  if (
    typeof liveness?.pid !== "number" ||
    typeof liveness?.port !== "number" ||
    !processIsAlive(liveness.pid)
  ) {
    fail("Farol is not running: the recorded process is not alive");
    return;
  }

  let token;
  try {
    await assertPrivateFile(path.join(stateRoot, TOKEN_FILE));
    token = await fs.readFile(path.join(stateRoot, TOKEN_FILE), "utf8");
  } catch (error) {
    fail(`Farol is running but has no token yet (${error?.message ?? error})`);
    return;
  }
  if (!token) {
    fail("Farol is running but has no token yet");
    return;
  }

  process.stdout.write(token);
}

main().catch((error) => {
  fail(
    `farol-model-credential-helper: unexpected failure (${error?.message ?? error})`,
  );
});

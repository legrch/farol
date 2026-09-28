import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const options = process.argv.slice(2);
assert(
  options.length === 0 || (options.length === 1 && options[0] === "--packaged"),
);
let failure;
try {
  await promisify(execFile)(
    process.execPath,
    [
      path.resolve("tests/e2e/codex-task-mcp.e2e.mjs"),
      ...options,
      "--callback-failure",
    ],
    { cwd: process.cwd(), env: process.env, maxBuffer: 4 * 1024 * 1024 },
  );
} catch (error) {
  failure = error;
}
assert(failure, "Injected failure unexpectedly succeeded");
assert.equal(failure.code, 1);
assert.equal(failure.signal, null);
assert.equal(failure.killed, false);
assert.match(
  failure.stderr,
  /AssertionError.*FIXTURE_TASK_DISCOVERY_CALLBACK_FAILURE/,
);
assert.match(
  failure.stdout,
  /PASS: injected callback failure unwound awaited teardown; disposable servers\/sockets\/root removed\./,
);
process.stdout.write(
  "PASS: exact injected callback assertion exited 1 after awaited fixture teardown; no native descendant claim.\n",
);

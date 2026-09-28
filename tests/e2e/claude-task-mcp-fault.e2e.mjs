import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const options = process.argv.slice(2);
assert(options.every((value) => value === "--packaged") && options.length <= 1);
const child = spawn(
  process.execPath,
  ["tests/e2e/claude-task-mcp.e2e.mjs", ...options, "--reconnect-failure"],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk.toString();
  });
let timer;
let killed = false;
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
  timer = setTimeout(() => {
    killed = true;
    child.kill("SIGTERM");
  }, 60000);
});
clearTimeout(timer);
assert.deepEqual(result, { code: 1, signal: null }, output);
assert.equal(killed, false, output);
assert.match(output, /CLAUDE_FIXTURE_RECONNECT_FAILURE/u);
assert.match(
  output,
  /CLAUDE_RECONNECT_FIRST_ERROR_CURRENT_CHILD_EXIT_ROOT_REMOVED/u,
);
assert.doesNotMatch(output, /FIXTURE_ROOT_RETAINED|SECONDARY_CLEANUP_FAILURE/u);
console.log(
  JSON.stringify({
    status: "PASS",
    fault: "owned-new-MCP-child-before-failed-reconnect",
    primaryExit: 1,
    signal: null,
    killed: false,
    cleanup: "both-current-child-exits-and-owned-root-removal-proven",
    nativeClaude: "NOT_QUALIFIED",
  }),
);

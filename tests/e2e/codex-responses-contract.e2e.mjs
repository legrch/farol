import { productName } from "../../tooling/harness-identity.ts";
// Explicit native compatibility observation, outside the ordinary suite.
// This is a test-side Responses peer: no product, Go or business delivery ACK.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForOwnedSecondary } from "./owned-background-secondary.mjs";

function argument(name) {
  const found = process.argv.slice(2).filter((v) => v.startsWith(name + "="));
  assert.equal(found.length, 1, "Exactly one " + name + " is required");
  return found[0].slice(name.length + 1);
}
assert.equal(process.platform, "darwin");
const binary = await fs.realpath(argument("--binary"));
const expectedDigest = argument("--sha256");
const version = argument("--version");
const sourceCommit = argument("--source-commit");
assert.match(sourceCommit, /^[a-f0-9]{40}$/u);
const digest = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(digest(await fs.readFile(binary)), expectedDigest);
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-codex-contract-")),
);
const home = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(workspace, { mode: 0o700 });
const reportPath = path.resolve(
  "_output/evidence/codex-responses-contract-" + randomUUID() + ".json",
);
const report = {
  status: "FAIL",
  binary,
  expectedDigest,
  expectedVersion: version,
  sourceCommit,
  sourceIdentity: "caller-selected commit; witness bytes independently hashed",
  witnessSHA256: digest(await fs.readFile(fileURLToPath(import.meta.url))),
  root,
  startedAt: new Date().toISOString(),
  limits: `Synthetic HTTP peer only; no ${productName}, Go, provider or business ACK`,
  requests: [],
  runs: [],
};
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
const answers = ["Synthetic first answer.", "Synthetic second answer."];
const prompts = [
  "Return the first synthetic answer.",
  "Return the second synthetic answer.",
];
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/containment") {
      res.end("loopback-allowed");
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/responses");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size <= 256 * 1024, "Request exceeds capture bound");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const index = report.requests.length;
    assert.ok(index < 2, "Unexpected request or retry");
    // Never retain request headers. Only the empty disposable workspace is
    // available to the CLI; no private source or owner configuration is read.
    report.requests.push({ body, bytes: size });
    const id = "resp_contract_" + (index + 1);
    const item = {
      id: "msg_contract_" + (index + 1),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answers[index], annotations: [] }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) =>
      res.write(
        "event: " +
          type +
          "\ndata: " +
          JSON.stringify({ type, ...data }) +
          "\n\n",
      );
    emit("response.created", {
      response: { id, object: "response", status: "in_progress", output: [] },
    });
    emit("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    emit("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: answers[index],
    });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  } catch (error) {
    report.endpointError = String(error);
    if (!res.headersSent) res.writeHead(400);
    res.end("Synthetic contract violation");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const node = await fs.realpath(process.execPath);
// realpath needs metadata on ancestors of the disposable root. This grants no
// ancestor contents, enumeration, owner configuration, or extra writable root.
const ancestors = [];
for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
  ancestors.push(parent);
  if (parent === path.dirname(parent)) break;
}
const profile = [
  "(version 1)",
  '(import "dyld-support.sb")',
  "(deny default)",
  "(allow process-fork)",
  "(allow signal (target self))",
  "(allow sysctl-read)",
  "(allow mach-lookup)",
  '(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")',
  '  (subpath "/private/etc") (subpath "/opt/homebrew")',
  '  (literal "/etc")',
  '  (literal "/dev/null") (literal "/dev/urandom")',
  '  (literal (param "BINARY")) (subpath (param "ROOT")))',
  "(allow file-read-metadata " +
    ancestors
      .map((_, index) => '(literal (param "ANCESTOR_' + index + '"))')
      .join(" ") +
    ")",
  '(allow process-exec (literal (param "BINARY")) (literal (param "NODE")))',
  '(allow file-write* (subpath (param "ROOT")) (literal "/dev/null")',
  '  (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
  "(deny network*)",
  // Seatbelt accepts "localhost", not a numeric IP, in this address form.
  '(allow network-outbound (remote ip "localhost:' + port + '"))',
].join("\n");
report.containmentProfileSha256 = digest(profile);
const environment = {
  HOME: os.homedir(),
  CODEX_HOME: home,
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "dumb",
  NO_COLOR: "1",
};
async function run(label, executable, childArgs) {
  const record = {
    label,
    executable,
    args: childArgs,
    pid: null,
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
  };
  report.runs.push(record);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-D",
      "BINARY=" + binary,
      "-D",
      "NODE=" + node,
      "-D",
      "ROOT=" + root,
      ...ancestors.flatMap((parent, index) => [
        "-D",
        "ANCESTOR_" + index + "=" + parent,
      ]),
      "-p",
      profile,
      executable,
      ...childArgs,
    ],
    { cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  record.pid = child.pid ?? null;
  const terminal = waitForOwnedSecondary(child, {
    timeoutMs: 30_000,
    cleanupTimeoutMs: 2_000,
    onObservation: (value) => {
      (record.observations ??= []).push(value);
    },
  });
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (chunk) => {
      if (Buffer.byteLength(record[name]) + chunk.length > 256 * 1024) {
        record.outputLimit = true;
      } else {
        record[name] += chunk.toString("utf8");
      }
    });
  }
  child.stdin.end();
  record.cleanup = await terminal;
  record.code = record.cleanup.terminal ? record.cleanup.exit : null;
  record.signal = record.cleanup.terminal ? record.cleanup.signal : null;
  record.timeout = record.cleanup.timedOut;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  assert.equal(
    record.cleanup.terminal,
    true,
    "Original child terminal unknown; preserve and do not retry",
  );
  assert.equal(record.code, 0, label + " failed; retained receipt, no retry");
  assert.equal(record.signal, null);
  assert.ok(!record.timeout && !record.outputLimit);
  return record;
}
try {
  // Probe only a known public source file, never an actual credential file.
  // The same deny-default profile excludes the owner's entire state tree.
  const deniedFile = path.resolve("AGENTS.md");
  assert.ok((await fs.stat(deniedFile)).isFile());
  const probe = [
    'const net = await import("node:net");',
    'const fs = await import("node:fs/promises");',
    'const assert = (await import("node:assert/strict")).default;',
    'const result = await fetch("http://127.0.0.1:' + port + '/containment");',
    'assert.equal(await result.text(), "loopback-allowed");',
    "await new Promise((resolve, reject) => {",
    '  const s = net.connect({host:"192.0.2.1",port:443});',
    '  s.setTimeout(1000, () => { s.destroy(); reject(Error("containment timeout")); });',
    '  s.on("connect", () => { s.destroy(); reject(Error("network escaped")); });',
    '  s.on("error", e => { try { assert.ok(["EPERM","EACCES"].includes(e.code)); resolve(); } catch(e) { reject(e); } });',
    "});",
    "try { await fs.readFile(" +
      JSON.stringify(deniedFile) +
      '); throw Error("owner tree readable"); }',
    'catch(e) { assert.ok(["EPERM","EACCES"].includes(e.code)); }',
    'console.log("loopback allowed; external network and owner tree denied");',
  ].join("\n");
  await run("containment", node, ["--input-type=module", "-e", probe]);
  const verifiedVersion = await run("version", binary, ["--version"]);
  assert.equal(verifiedVersion.stdout.trim(), version);
  assert.equal(
    verifiedVersion.stderr,
    "",
    "Version preflight must not hide setup failures",
  );
  report.version = verifiedVersion.stdout.trim();
  const config = [
    'model_provider="farol"',
    'model="chatgpt"',
    `model_providers.farol.name="${productName} synthetic contract"`,
    'model_providers.farol.base_url="http://127.0.0.1:' + port + '"',
    'model_providers.farol.wire_api="responses"',
    "model_providers.farol.requires_openai_auth=false",
    "model_providers.farol.request_max_retries=0",
    "model_providers.farol.stream_max_retries=0",
    "model_providers.farol.stream_idle_timeout_ms=10000",
    "check_for_update_on_startup=false",
  ].flatMap((value) => ["-c", value]);
  const common = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "-C",
    workspace,
    ...config,
  ];
  const first = await run("create", binary, [
    ...common,
    "--skip-git-repo-check",
    prompts[0],
  ]);
  const events = first.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const threadId = events.find(
    (event) => event.type === "thread.started",
  )?.thread_id;
  assert.match(threadId, /^[0-9a-f-]{36}$/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "item.completed" && event.item?.text === answers[0],
    ),
  );
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.equal(report.requests.length, 1);
  const second = await run("resume", binary, [
    ...common,
    "resume",
    "--skip-git-repo-check",
    threadId,
    prompts[1],
  ]);
  const follow = second.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    follow.find((event) => event.type === "thread.started")?.thread_id,
    threadId,
  );
  assert.ok(
    follow.some(
      (event) =>
        event.type === "item.completed" && event.item?.text === answers[1],
    ),
  );
  assert.ok(follow.some((event) => event.type === "turn.completed"));
  assert.equal(report.requests.length, 2);
  assert.equal(report.endpointError, undefined);
  assert.equal(digest(await fs.readFile(binary)), expectedDigest);
  report.threadId = threadId;
  report.status = "PASS";
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  // Retain synthetic session evidence and all failures. No uncertain operation
  // is repeated or cleaned merely because this process reached finally.
  console.log(
    JSON.stringify({
      status: report.status,
      reportPath,
      root,
      requests: report.requests.length,
      error: report.error,
    }),
  );
}

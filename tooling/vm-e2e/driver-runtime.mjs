// In-guest result protocol for bundled product vm-e2e drivers (farol.vm-e2e/1).
// Keep this module free of anything but node: builtins so it can be inlined
// into a self-contained driver bundle that runs inside a guest with no
// node_modules. Durability ordering mirrors tooling/vm-smoke.py
// write_durable_json: the temp file is fsynced before the atomic replace and
// the directory entry is fsynced after it, so a result is either absent or
// fully published after a crash.
//
// Prototype scope: this proves the bundled-result shape only. It is NOT guest
// evidence, NOT network containment evidence, and claims no VM qualification.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RESULT_FILE = "result.json";

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  (fs.constants.O_NOFOLLOW ?? 0);

export function resultDirectory() {
  const override = process.env.VM_E2E_RESULT_DIR;
  return override && override.length > 0 ? override : "results";
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Unbound writes remain available for standalone infrastructure probes. Only
// a bound result can be admitted by Runner; neither form qualifies product E2E.
function requireResult(condition, code) {
  if (!condition) throw Error(code);
}

function exactKeys(value, keys, code) {
  requireResult(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === keys.slice().sort().join(","),
    code,
  );
}

function readBoundContext(file) {
  requireResult(
    typeof file === "string" && file.length > 0,
    "E2E_CONTEXT_FILE_REQUIRED",
  );
  // Reject unexpected FIFOs via fstat instead of blocking forever on open.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
  );
  let bytes;
  try {
    const s = fs.fstatSync(fd);
    requireResult(
      s.isFile() && s.nlink === 1 && s.size > 0 && s.size <= 65536,
      "E2E_CONTEXT_FILE_INVALID",
    );
    bytes = Buffer.alloc(65537);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    requireResult(count === s.size, "E2E_CONTEXT_FILE_CHANGED");
    bytes = bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
  const context = JSON.parse(bytes.toString("utf8"));
  exactKeys(
    context,
    [
      "schema",
      "runId",
      "scenario",
      "selection",
      "evidenceClass",
      "bundleSha256",
      "artifact",
    ],
    "E2E_CONTEXT_FIELDS_INVALID",
  );
  requireResult(
    context.schema === "farol.vm-e2e.context/1" &&
      typeof context.runId === "string" &&
      /^run-[a-f0-9]{32}$/.test(context.runId) &&
      typeof context.scenario === "string" &&
      /^[a-z][a-z0-9-]{0,127}$/.test(context.scenario) &&
      ["infrastructure", "diagnostic"].includes(context.evidenceClass),
    "E2E_CONTEXT_INVALID",
  );
  const selection = context.selection;
  requireResult(
    Array.isArray(selection) &&
      selection.length > 0 &&
      selection.length <= 64 &&
      selection.every(
        (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(id),
      ) &&
      new Set(selection).size === selection.length,
    "E2E_SELECTION_INVALID",
  );
  exactKeys(
    context.artifact,
    ["sourceCommit", "buildId", "artifactSha256", "archiveSha256"],
    "E2E_ARTIFACT_INVALID",
  );
  requireResult(
    typeof context.artifact.sourceCommit === "string" &&
      /^[a-f0-9]{40}$/.test(context.artifact.sourceCommit),
    "E2E_ARTIFACT_INVALID",
  );
  for (const hash of [
    context.bundleSha256,
    context.artifact.buildId,
    context.artifact.artifactSha256,
    context.artifact.archiveSha256,
  ]) {
    requireResult(
      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
      "E2E_DIGEST_INVALID",
    );
  }
  return {
    context,
    contextSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function bindResult(value, file) {
  const { context, contextSha256 } = readBoundContext(file);
  requireResult(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "E2E_RESULT_INVALID",
  );
  requireResult(value.scenario === context.scenario, "E2E_SCENARIO_MISMATCH");
  for (const key of [
    "schema",
    "runId",
    "selection",
    "evidenceClass",
    "bundleSha256",
    "artifact",
    "contextSha256",
  ]) {
    requireResult(!Object.hasOwn(value, key), "E2E_CONTEXT_OVERRIDE_FORBIDDEN");
  }
  const cases = value.cases;
  requireResult(
    Array.isArray(cases) && cases.length === context.selection.length,
    "E2E_CASES_INCOMPLETE",
  );
  for (const [i, item] of cases.entries()) {
    exactKeys(item, ["id", "status"], "E2E_CASE_INVALID");
    requireResult(
      item.id === context.selection[i] &&
        ["PASS", "FAIL", "NOT_RUN", "REPORTED"].includes(item.status),
      "E2E_CASE_INVALID",
    );
  }
  const reason = value.reason ?? null;
  requireResult(
    reason === null ||
      (typeof reason === "string" &&
        reason.length > 0 &&
        reason.length <= 2048),
    "E2E_REASON_INVALID",
  );
  if (value.status === "PASS") {
    requireResult(
      context.evidenceClass === "infrastructure" &&
        reason === null &&
        cases.every((item) => item.status === "PASS"),
      "E2E_PASS_UNSUPPORTED",
    );
  } else if (value.status === "REPORTED") {
    requireResult(
      context.evidenceClass === "diagnostic" &&
        reason === null &&
        cases.every((item) => item.status === "REPORTED"),
      "E2E_REPORTED_INVALID",
    );
  } else if (value.status === "FAIL") {
    requireResult(
      reason !== null || cases.some((item) => item.status === "FAIL"),
      "E2E_FAIL_WITHOUT_FAILURE",
    );
  } else {
    throw Error("E2E_STATUS_UNSUPPORTED");
  }
  const details = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["scenario", "status", "cases", "reason"].includes(key),
    ),
  );
  return {
    schema: "farol.vm-e2e.result/1",
    runId: context.runId,
    scenario: context.scenario,
    selection: context.selection,
    evidenceClass: context.evidenceClass,
    bundleSha256: context.bundleSha256,
    artifact: context.artifact,
    contextSha256,
    status: value.status,
    cases,
    reason,
    details,
  };
}

export function writeResult(value) {
  const contextFile = process.env.VM_E2E_CONTEXT_FILE;
  const output =
    contextFile === undefined ? value : bindResult(value, contextFile);
  const encoded = JSON.stringify(output) + "\n";
  if (contextFile !== undefined)
    requireResult(Buffer.byteLength(encoded) <= 262144, "E2E_RESULT_TOO_LARGE");
  const directory = resultDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, RESULT_FILE);
  const temp = path.join(
    directory,
    "." + crypto.randomBytes(16).toString("hex") + ".tmp",
  );
  let handle;
  try {
    handle = fs.openSync(temp, WRITE_FLAGS, 0o600);
    fs.writeFileSync(handle, encoded);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp entry may already be gone; residue-free failure is the goal.
    }
    throw error;
  }
  fsyncDirectory(directory);
  return target;
}

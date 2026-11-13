// Guest-only Dev-app entry. Never launches or reads host product profiles,
// uses an arbitrary shell, imports credentials, or writes MCP stdout.
// Build-only source and native VM custody stay with their existing owners.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productName } from "./harness-identity.ts";
import {
  assembleVMDev,
  archiveVMDev,
  VM_DEV_APP,
  VM_DEV_ARCHIVE,
  VM_DEV_IDENTITY,
  VM_DEV_IDENTITY_ENV,
} from "./vm-dev-artifact.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const SHA = /^[a-f0-9]{64}$/u;
const DERIVATIVE = "farol.vm-dev-artifact/1";

export class VMDevRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "VMDevRefusal";
  }
}
function requireVM(ok, code) {
  if (!ok) throw new VMDevRefusal(code);
}
export function parseVMDevOptions(argv) {
  const result = {
    visible: false,
    artifact: null,
    receipt: null,
    expectedReceiptSHA256: null,
    config: null,
    goInputs: null,
  };
  const keys = {
    "--artifact": "artifact",
    "--receipt": "receipt",
    "--expected-receipt-sha256": "expectedReceiptSHA256",
    "--config": "config",
    "--go-inputs": "goInputs",
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--visible") {
      requireVM(!result.visible, "VM_DEV_OPTIONS_INVALID");
      result.visible = true;
    } else {
      const equalsGoInputs = token.startsWith("--go-inputs=");
      const key = keys[equalsGoInputs ? "--go-inputs" : token];
      requireVM(
        key !== undefined && result[key] === null,
        "VM_DEV_OPTIONS_INVALID",
      );
      const value = equalsGoInputs
        ? token.slice("--go-inputs=".length)
        : argv[++i];
      requireVM(
        typeof value === "string" &&
          value.length > 0 &&
          !value.startsWith("--"),
        "VM_DEV_OPTIONS_INVALID",
      );
      result[key] = value;
    }
  }
  const provided = ["artifact", "receipt", "expectedReceiptSHA256"].filter(
    (key) => result[key] !== null,
  );
  requireVM(
    provided.length === 0 || provided.length === 3,
    "VM_DEV_OPTIONS_INVALID",
  );
  if (provided.length === 3)
    requireVM(
      SHA.test(result.expectedReceiptSHA256),
      "VM_DEV_RECEIPT_UNQUALIFIED",
    );
  requireVM(
    result.goInputs === null ||
      (result.artifact === null &&
        path.isAbsolute(result.goInputs) &&
        path.normalize(result.goInputs) === result.goInputs &&
        !result.goInputs.includes("\0")),
    "VM_DEV_GO_INPUTS_INVALID",
  );
  if (result.config !== null) {
    requireVM(
      result.config.startsWith("/") &&
        path.normalize(result.config) === result.config &&
        !result.config.includes("\0"),
      "VM_DEV_CONFIG_INVALID",
    );
  }
  return result;
}

async function sourceFile(file, limit) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    requireVM(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.getuid()) &&
        before.size > 0 &&
        before.size <= BigInt(limit) &&
        (before.mode & 0o077n) === 0n,
      "VM_DEV_INPUT_UNSAFE",
    );
    const buffer = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    requireVM(
      buffer.length === Number(before.size) &&
        [
          "dev",
          "ino",
          "mode",
          "uid",
          "nlink",
          "size",
          "mtimeNs",
          "ctimeNs",
        ].every((key) => before[key] === after[key]),
      "VM_DEV_INPUT_CHANGED",
    );
    return buffer;
  } finally {
    await fd.close();
  }
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/// Explicit already-built data must come from this source checkout's private
/// _output/vm-dev/<run>/, never a caller-selected host profile or arbitrary ZIP.
export async function existingDevInputs(root, opts) {
  const artifact = path.resolve(opts.artifact);
  const receipt = path.resolve(opts.receipt);
  const output = path.dirname(artifact);
  const expectedParent = path.join(root, "_output/vm-dev");
  requireVM(
    path.dirname(output) === expectedParent &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(path.basename(output)) &&
      artifact === path.join(output, VM_DEV_ARCHIVE) &&
      receipt === path.join(output, "vm-dev-artifact.json") &&
      opts.artifact === artifact &&
      opts.receipt === receipt,
    "VM_DEV_ARTIFACT_PATH_INVALID",
  );
  for (const dir of [
    root,
    path.join(root, "_output"),
    expectedParent,
    output,
  ]) {
    const info = await fs.lstat(dir);
    requireVM(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        (info.mode & 0o022) === 0 &&
        (await fs.realpath(dir)) === dir,
      "VM_DEV_ARTIFACT_PATH_INVALID",
    );
  }
  const bytes = await sourceFile(receipt, 16_384);
  requireVM(
    sha256(bytes) === opts.expectedReceiptSHA256,
    "VM_DEV_RECEIPT_CHANGED",
  );
  let selected;
  try {
    selected = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new VMDevRefusal("VM_DEV_RECEIPT_INVALID");
  }
  requireVM(
    selected &&
      selected.schema === DERIVATIVE &&
      selected.kind === "local-dev-derivative" &&
      selected.appName === VM_DEV_APP &&
      selected.bundleId === VM_DEV_IDENTITY.bundleId &&
      selected.environment === "dev" &&
      selected.officialRelease === false &&
      selected.hostLaunch === false &&
      selected.profileImport === false &&
      SHA.test(selected.artifactSha256) &&
      selected.artifactPath === path.join(output, VM_DEV_APP),
    "VM_DEV_RECEIPT_INVALID",
  );
  // The conductor's prepare_dev_session independently revalidates ZIP members,
  // full tree hash, launcher, signatures/policy and accepted binding at staging.
  // This is only a cheap pre-clone rejection of missing/changed bytes.
  // Never allocate a potentially 2-GiB ZIP in this cheap preflight. Open a
  // no-follow descriptor, check its identity and bounded header, then let the
  // conductor-owned producer perform full archive/tree/signature validation.
  const zipped = await fs.open(
    artifact,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await zipped.stat({ bigint: true });
    requireVM(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o077n) === 0n &&
        before.size > 0 &&
        before.size <= BigInt(2 * 1024 ** 3),
      "VM_DEV_ARTIFACT_UNAVAILABLE",
    );
    const marker = Buffer.alloc(4);
    const read = await zipped.read(marker, 0, 4, 0);
    requireVM(
      read.bytesRead === 4 &&
        marker.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      "VM_DEV_ARCHIVE_INVALID",
    );
    const after = await zipped.stat({ bigint: true });
    requireVM(
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
      ].every((key) => before[key] === after[key]),
      "VM_DEV_ARTIFACT_CHANGED",
    );
  } finally {
    await zipped.close();
  }
  return {
    artifact,
    receipt,
    expectedReceiptSHA256: opts.expectedReceiptSHA256,
    artifactSHA256: selected.artifactSha256,
  };
}

// This is the SAME exact-source compiler as task package's first step, with
// packaging/host launch omitted. No dev.mjs, npm install or host profile reads.
export function requireBuildSuccess(
  run,
  executable,
  root,
  env,
  goInputs = path.join(root, "_output/go-build-inputs.json"),
) {
  const outcome = run(
    executable,
    [path.join(root, "tooling/build.mjs"), `--go-inputs=${goInputs}`],
    {
      cwd: root,
      env,
      stdio: ["ignore", 2, 2],
    },
  );
  // Do not impose an arbitrary timeout that kills a still-building candidate
  // and then mislabels the (possibly partial) output as a clean rejection.
  requireVM(
    outcome && !outcome.error && outcome.signal == null,
    "VM_DEV_BUILD_OUTCOME_UNKNOWN",
  );
  requireVM(outcome.status === 0, "VM_DEV_BUILD_UNQUALIFIED");
}

const OWNED_OUTPUT = /^run-[a-f0-9]{32}$/u;

// Remove exactly the _output/vm-dev/run-* directory THIS process created.
// It must still be a physical owned directory directly under _output/vm-dev;
// anything else is left in place and reported. fs.rm never follows links.
export async function removeOwnedOutput(root, output) {
  const parent = path.join(root, "_output/vm-dev");
  if (
    path.dirname(output) !== parent ||
    !OWNED_OUTPUT.test(path.basename(output))
  )
    return false;
  try {
    const info = await fs.lstat(output);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (await fs.realpath(output)) !== output
    )
      return false;
    await fs.rm(output, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function buildDevInputs(root, injected = {}) {
  const id = "run-" + randomUUID().replaceAll("-", "");
  const output = path.join(root, "_output/vm-dev", id);
  requireBuildSuccess(
    injected.run ?? spawnSync,
    injected.executable ?? process.execPath,
    root,
    injected.env ?? process.env,
    injected.goInputs ?? path.join(root, "_output/go-build-inputs.json"),
  );
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  try {
    return { ...(await assembleDevInputs(root, output, injected)), output };
  } catch (error) {
    // Host-only assembly/archive output with no VM effect: remove it.
    await removeOwnedOutput(root, output);
    throw error;
  }
}

async function assembleDevInputs(root, output, injected) {
  const assemble = injected.assemble ?? assembleVMDev;
  const archive = injected.archive ?? archiveVMDev;
  const receipt = await assemble(root, output);
  requireVM(
    receipt &&
      receipt.schema === DERIVATIVE &&
      receipt.hostLaunch === false &&
      receipt.profileImport === false &&
      receipt.officialRelease === false,
    "VM_DEV_DERIVATIVE_UNQUALIFIED",
  );
  // Select the digest of the exact locally attested derivative BEFORE building
  // its ZIP. It is NOT a stable-release publisher signature.
  const receiptPath = path.join(output, "vm-dev-artifact.json");
  const bytes = await sourceFile(receiptPath, 16_384);
  const expectedReceiptSHA256 = sha256(bytes);
  const archived = await archive(root, output, expectedReceiptSHA256, false);
  requireVM(
    archived &&
      archived.schema === "farol.vm-dev-archive/1" &&
      archived.archiveName === VM_DEV_ARCHIVE &&
      archived.receiptSHA256 === expectedReceiptSHA256 &&
      archived.officialRelease === false,
    "VM_DEV_ARCHIVE_UNQUALIFIED",
  );
  return existingDevInputs(root, {
    artifact: path.join(output, VM_DEV_ARCHIVE),
    receipt: receiptPath,
    expectedReceiptSHA256,
  });
}

export function pythonDevArguments(inputs, options) {
  return [
    "-I",
    "-B",
    path.join(ROOT, "tooling/vm-dev-session.py"),
    "--artifact",
    inputs.artifact,
    "--receipt",
    inputs.receipt,
    "--expected-receipt-sha256",
    inputs.expectedReceiptSHA256,
    ...(options.visible ? ["--visible"] : []),
    ...(options.config ? ["--config", options.config] : []),
  ];
}

export async function runVMDev(argv, injected = {}) {
  const options = parseVMDevOptions(argv);
  const root = injected.root ?? ROOT;
  requireVM(
    root === path.resolve(root) && root === (await fs.realpath(root)),
    "VM_DEV_SOURCE_ROOT_UNSAFE",
  );
  const env = {
    ...Object.fromEntries(
      ["HOME", "USER", "TMPDIR", "PATH"]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    ),
    FAROL_VM_TESTING_DIRECTORY: productName + " Testing",
    ...VM_DEV_IDENTITY_ENV,
    ...(options.config
      ? { FAROL_VM_CONFIG: options.config }
      : process.env.FAROL_VM_CONFIG
        ? { FAROL_VM_CONFIG: process.env.FAROL_VM_CONFIG }
        : {}),
  };
  const inputs =
    options.artifact === null
      ? await buildDevInputs(root, {
          run: injected.run,
          executable: injected.executable,
          env,
          assemble: injected.assemble,
          archive: injected.archive,
          goInputs: options.goInputs,
        })
      : await existingDevInputs(root, options);
  const python = injected.python ?? spawnSync;
  const result = python(
    "/usr/bin/python3",
    pythonDevArguments(inputs, options),
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  const known =
    result &&
    result.error == null &&
    result.signal == null &&
    Number.isInteger(result.status);
  // The session exits 0 (closed and removed) or 1 (refused, nothing retained
  // beyond its private evidence). Only then is this run's built output plain
  // host output; otherwise it is evidence of what was staged and is kept.
  // An explicitly selected --artifact directory is never removed.
  if (inputs.output) {
    const removable = known && (result.status === 0 || result.status === 1);
    if (!(removable && (await removeOwnedOutput(root, inputs.output))))
      diagnose(
        injected.stderr ?? process.stderr,
        "VM_DEV_OUTPUT_RETAINED " + inputs.output,
      );
  }
  requireVM(known, "VM_DEV_SESSION_OUTCOME_UNKNOWN");
  return result.status;
}

// Best-effort diagnostic: the agent host may have closed stderr. A failed
// write never changes the exit status or the retention decision.
function diagnose(stream, line) {
  try {
    stream.write(line + "\n");
  } catch {
    // ignored by design
  }
}

// 1 is a classified refusal; an outcome-unknown build or session (including a
// signal-killed child) or an unclassified error exits 2, never 1.
export function vmDevRefusalExit(code) {
  return /^VM_DEV_[A-Z_]+$/.test(code) &&
    code !== "VM_DEV_UNCLASSIFIED" &&
    !code.endsWith("_OUTCOME_UNKNOWN")
    ? 1
    : 2;
}

const entry = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entry && import.meta.url === entry) {
  // An EPIPE on a closed stderr is reported asynchronously; never let it
  // crash the process and replace the session's exit status.
  process.stderr.on("error", () => {});
  try {
    process.exitCode = await runVMDev(process.argv.slice(2));
  } catch (error) {
    // MCP stdout MUST be protocol-only, including on preflight failures.
    const code =
      error instanceof VMDevRefusal ? error.message : "VM_DEV_UNCLASSIFIED";
    process.exitCode = vmDevRefusalExit(code);
    diagnose(process.stderr, code);
  }
}

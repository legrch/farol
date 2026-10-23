// Two pinned artifacts, direct live Go helper, disposable native home only.
// Importing this module performs no IO, allocation, native launch or networking.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";
import {
  candidatePaths,
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "../../../tooling/candidate-contract.mjs";
import { assertBuildIdentity } from "../../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  bridgeEntrySets,
  verifyBuildEntries,
  verifyInputManifest,
} from "../../../tooling/build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "../../../tooling/go-core-artifact.mjs";
import {
  TREE_DIGEST_VERSION,
  treeDigest,
} from "../../../tooling/artifact-digest.mjs";
import { sourceIdentity } from "../../../tooling/source-identity.mjs";
import {
  desktopAppDataPath,
  desktopIdentity,
  productBundleName,
} from "../../../tooling/harness-identity.ts";
import {
  readQuitObservation,
  beginQuitObservation,
  assertFreshQuit,
} from "./native-quit-observation.mjs";
import {
  E2E_WINDOW_LIFETIME_SCHEMA,
  collectWindowObservation,
  assertWindowSnapshot,
  assertWindowLifetime,
} from "./native-window-observation.mjs";
import {
  readRunMarker,
  readProcessStart,
  currentBootTimeMs,
  sameBoot,
} from "../../../src/apps/desktop/run-marker.ts";

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const OPERATION = /^[a-f0-9]{32}$/u;
const code = (name) => new Error(`OWNER_BETA_${name}`);
const check = (condition, name) => {
  if (!condition) throw code(name);
};
export const LIMITS = Object.freeze({
  frame: 4096,
  request: 16384,
  ackMs: 180000,
  terminalMs: 610000,
  quitMs: 60000,
});
export const NOT_RUN = Object.freeze({
  recovery: "NOT RUN: the live recovery contract requires relaunch:true",
  launchServices:
    "NOT RUN: direct hidden startup only; relaunch:false throughout",
  normalDesktopUpdater:
    "NOT RUN: direct Go CLI bypasses the installed updater owner-home locator",
  production:
    "NOT RUN: disposable signed-out home only; no owner installation, live authentication or full CP2 acceptance",
});

function absolute(value) {
  check(
    typeof value === "string" &&
      path.isAbsolute(value) &&
      !value.includes("\0") &&
      path.resolve(value) === value,
    "PATH_INVALID",
  );
  return value;
}
function keys(value, wanted) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...wanted].sort())
  );
}
function pin(info) {
  return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
}
function samePin(a, b) {
  return isDeepStrictEqual(pin(a), pin(b));
}
async function physicalDirectory(directory, privateMode = false) {
  absolute(directory);
  const info = await fs.lstat(directory);
  check(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await fs.realpath(directory)) === directory,
    "DIRECTORY_UNSAFE",
  );
  if (privateMode)
    check(
      info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700,
      "DIRECTORY_UNSAFE",
    );
  return pin(info);
}
// Bounded, no-follow reads cannot block on a substituted pipe/device. Compare
// named and opened identities through completion before accepting any bytes.
export async function readBounded(file, maximum) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    check(
      before.isFile() && before.nlink === 1 && before.size <= maximum,
      "FILE_UNSAFE",
    );
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await fs.lstat(file);
    check(
      samePin(before, after) &&
        samePin(before, named) &&
        before.size === bytesRead &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "FILE_CHANGED",
    );
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
async function json(file, maximum = 65536) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readBounded(file, maximum),
    ),
  );
}

export function parseArguments(args) {
  check(args[0] === "--check" || args[0] === "--run-native", "ARGUMENTS");
  const selected = {};
  const names = [
    "source-root",
    "source-sha",
    "source-build-id",
    "source-artifact-sha",
    "target-root",
    "target-sha",
    "target-build-id",
    "target-artifact-sha",
  ];
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]?.slice(2);
    check(
      args[index]?.startsWith("--") &&
        names.includes(name) &&
        !(name in selected) &&
        typeof args[index + 1] === "string",
      "ARGUMENTS",
    );
    selected[name] = args[index + 1];
  }
  check(Object.keys(selected).length === names.length, "ARGUMENTS");
  const candidate = (prefix) => ({
    root: selected[`${prefix}-root`],
    sourceSHA: selected[`${prefix}-sha`],
    buildId: selected[`${prefix}-build-id`],
    artifactSha256: selected[`${prefix}-artifact-sha`],
  });
  const result = {
    mode: args[0],
    source: candidate("source"),
    target: candidate("target"),
  };
  validateSelection(result);
  return result;
}
function validateSelection(selection) {
  check(
    selection?.mode === "--check" || selection?.mode === "--run-native",
    "ARGUMENTS",
  );
  for (const value of [selection.source, selection.target]) {
    check(
      keys(value, ["root", "sourceSHA", "buildId", "artifactSha256"]),
      "CANDIDATE_SELECTION",
    );
    absolute(value.root);
    check(
      SHA40.test(value.sourceSHA) &&
        SHA64.test(value.buildId) &&
        SHA64.test(value.artifactSha256),
      "CANDIDATE_SELECTION",
    );
  }
  check(
    selection.source.root !== selection.target.root &&
      selection.source.buildId !== selection.target.buildId &&
      selection.source.artifactSha256 !== selection.target.artifactSha256,
    "PAIR_NOT_DISTINCT",
  );
}

export async function checkCandidate(expected, provenance = sourceIdentity) {
  await physicalDirectory(expected.root);
  const { appPath, artifactFile } = candidatePaths(expected.root);
  await physicalDirectory(path.dirname(artifactFile));
  await physicalDirectory(appPath);
  const artifact = await json(artifactFile);
  check(
    artifact.schema === 7 && artifact.treeDigestVersion === TREE_DIGEST_VERSION,
    "ARTIFACT_SCHEMA",
  );
  assertCanonicalArtifactPath(expected.root, artifact);
  check(
    artifact.artifactPath === appPath &&
      artifact.sourceCommit === expected.sourceSHA &&
      artifact.buildId === expected.buildId &&
      artifact.artifactSha256 === expected.artifactSha256,
    "CANDIDATE_PIN_MISMATCH",
  );
  // Canonical owner uses ONLY fixed read-only /usr/bin/git provenance commands,
  // GIT_OPTIONAL_LOCKS=0, no global/system config and a non-secret allowlist.
  const current = provenance(expected.root);
  assertExactSourceIdentity(current, artifact);
  const resources = path.join(appPath, "Contents/Resources/app");
  await physicalDirectory(resources);
  const build = assertBuildIdentity(
    await json(path.join(resources, "build-identity.json")),
  );
  assertExactSourceIdentity(current, build);
  check(
    build.buildId === expected.buildId &&
      build.updateChannel === "github-owner-beta" &&
      artifact.updateChannel === build.updateChannel &&
      artifact.version === build.version &&
      artifact.bundleId === build.bundleId &&
      artifact.product === build.product,
    "BUILD_MISMATCH",
  );
  const manifest = await json(
    path.join(resources, "build-manifest.json"),
    1024 * 1024,
  );
  check(
    manifest.schema === 4 &&
      manifest.inputExact === true &&
      manifest.sourceMode === "head-exact" &&
      manifest.dirty === false &&
      manifest.sourceCommit === build.sourceCommit &&
      manifest.sourceTreeDigest === build.sourceTreeDigest &&
      manifest.buildId === build.buildId,
    "BUILD_MANIFEST",
  );
  const entrySets = bridgeEntrySets([...BUILD_ENTRIES, ...GO_CORE_ENTRIES]);
  check(
    entrySets.some((entries) =>
      isDeepStrictEqual([...manifest.entries].sort(), entries),
    ),
    "BUILD_ENTRIES",
  );
  await verifyBuildEntries(resources, manifest.entrySha256, manifest.entries);
  await verifyInputManifest(resources, manifest);
  await verifyGoCoreArtifact(resources, manifest.core, build);
  const executable = path.join(resources, "farol-backend");
  const binary = await readBounded(executable, 128 * 1024 * 1024);
  for (const command of [
    "run-live-release-helper",
    "publish-installed-slot-binding",
    "farol.installed-update-handoff/1",
    "farol.installed-update/1",
    build.buildId,
  ])
    check(binary.includes(Buffer.from(command)), "HELPER_PROTOCOL_UNSUPPORTED");
  // Refuse older packages before allocation. These are source/build capability
  // checks, never a claim that this code has executed successfully on the host.
  const desktop = (
    await readBounded(path.join(resources, "main.cjs"), 32 * 1024 * 1024)
  ).toString("utf8");
  const seam = (
    await readBounded(
      path.join(expected.root, "src/apps/desktop/desktop-environment.ts"),
      128 * 1024,
    )
  ).toString("utf8");
  check(
    /function assertNativeE2EAppData\d*\(/u.test(desktop) &&
      seam.includes("function assertNativeE2EAppData("),
    "E2E_SEAM_UNSUPPORTED",
  );
  check(
    desktop.includes("__farolE2EWindowLifetime") &&
      desktop.includes(E2E_WINDOW_LIFETIME_SCHEMA),
    "EARLY_WINDOW_OBSERVER_UNSUPPORTED",
  );
  const helper = (
    await readBounded(
      path.join(expected.root, "boot/releasehelperlive.go"),
      128 * 1024,
    )
  ).toString("utf8");
  for (const token of [
    "r.Predecessor == nil",
    "r.InstallLocation != nil",
    'r.Action == "rollback"',
    "protocolapp.WaitingForExit",
  ])
    check(helper.includes(token), "HELPER_PROTOCOL_UNSUPPORTED");
  check(
    (await treeDigest(appPath)) === expected.artifactSha256,
    "ARTIFACT_TREE_MISMATCH",
  );
  // A concurrent source edit during the tree measurement invalidates admission.
  assertExactSourceIdentity(provenance(expected.root), artifact);
  return {
    ...expected,
    appPath,
    resources,
    executable,
    build,
    core: manifest.core,
  };
}
export async function checkPair(selection, provenance = sourceIdentity) {
  validateSelection(selection);
  const source = await checkCandidate(selection.source, provenance);
  const target = await checkCandidate(selection.target, provenance);
  return { source, target };
}
// Native effects are a separate capability invoked only AFTER both complete
// preflights. Tests inject inert counters here; the CLI supplies the real runner.
export async function executePacket(
  selection,
  { provenance = sourceIdentity, native = runNativePair } = {},
) {
  const pair = await checkPair(selection, provenance);
  if (selection.mode === "--check")
    return {
      status: "checked",
      native: "NOT RUN",
      source: pair.source.build.buildId,
      target: pair.target.build.buildId,
      notRun: NOT_RUN,
    };
  return native(pair);
}

export function bounded(promise, milliseconds, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(code(name)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
// Exactly one LF-terminated JSON object. Byte limits, UTF-8, duplicate keys and
// extra frames are rejected. Re-encoding parsed key tokens detects escaped
// aliases too; nested builds are closed independently by parseACK.
export function parseFrame(bytes, maximum = LIMITS.frame) {
  check(
    bytes.length > 1 && bytes.length <= maximum && bytes.at(-1) === 10,
    "FRAME_SIZE_OR_DELIMITER",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  check(!text.slice(0, -1).includes("\n"), "FRAME_MULTIPLE");
  const tokens = text.match(/"(?:[^"\\]|\\.)*"\s*:/gu) ?? [];
  const names = tokens.map((token) =>
    JSON.parse(token.slice(0, token.lastIndexOf(":")).trim()),
  );
  // The only repeated keys in the live protocol are the three build fields,
  // once per source/target object. Compare the complete structural token count.
  const value = JSON.parse(text);
  const countKeys = (item) =>
    item !== null && typeof item === "object"
      ? Object.entries(item).reduce(
          (sum, [, entry]) => sum + 1 + countKeys(entry),
          0,
        )
      : 0;
  check(names.length === countKeys(value), "FRAME_DUPLICATE_KEYS");
  return value;
}
export function parseACK(bytes, request) {
  const value = parseFrame(bytes);
  const refused = value.phase === "refused";
  const fields = [
    "schema",
    "phase",
    "operationId",
    "action",
    "source",
    "target",
    "pid",
    "processStart",
    ...(refused ? ["error"] : []),
  ];
  check(
    keys(value, fields) &&
      value.schema === "farol.installed-update-handoff/1" &&
      (value.phase === "waiting_for_exit" || refused),
    "ACK_MALFORMED",
  );
  for (const field of [
    "operationId",
    "action",
    "source",
    "target",
    "pid",
    "processStart",
  ])
    check(isDeepStrictEqual(value[field], request[field]), "ACK_CORRELATION");
  check(
    keys(value.source, ["digest", "version", "buildId"]) &&
      keys(value.target, ["digest", "version", "buildId"]),
    "ACK_BUILD",
  );
  if (refused)
    check(/^[a-z][a-z0-9_]{0,79}$/u.test(value.error), "ACK_MALFORMED");
  return value;
}
export function classifyTerminal(
  bytes,
  request,
  exit,
  ack,
  protocolError = null,
) {
  let terminal = null;
  try {
    terminal = parseFrame(bytes);
    check(
      keys(terminal, [
        "phase",
        "operationId",
        ...(terminal.error === undefined ? [] : ["error"]),
      ]) &&
        terminal.operationId === request.operationId &&
        /^[a-z_]{1,40}$/u.test(terminal.phase) &&
        (terminal.error === undefined ||
          /^[a-z][a-z0-9_]{0,79}$/u.test(terminal.error)),
      "TERMINAL_MALFORMED",
    );
  } catch {
    protocolError ??= "terminal_malformed";
    terminal = null;
  }
  let status = "outcome_unknown";
  if (!protocolError && exit.signal === null && terminal && ack) {
    if (
      ack.phase === "refused" &&
      exit.code === 70 &&
      terminal.phase === "refused" &&
      terminal.error === ack.error
    )
      status = "refused";
    if (
      ack.phase === "waiting_for_exit" &&
      exit.code === 0 &&
      terminal.error === undefined &&
      terminal.phase ===
        (request.action === "apply" ? "verified" : "rolled_back")
    )
      status = "passed";
  }
  return { status, ...exit, terminal, protocolError };
}
export function slotBinding(request) {
  const build = (value) => ({
    buildId: value.buildId,
    digest: value.digest,
    version: value.version,
  });
  return Buffer.from(
    JSON.stringify({
      installLocation: "legacy",
      operationId: request.operationId,
      schema: "farol.installed-operation-slot/1",
      source: build(request.source),
      target: build(request.target),
    }) + "\n",
  );
}

function retainChild(child, receipt) {
  receipt.pid = child.pid ?? null;
  receipt.terminal = null;
  receipt.processError = false;
  child.on("error", () => {
    receipt.processError = true;
  });
  const terminal = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      receipt.terminal = { code, signal };
      resolve(receipt.terminal);
    });
  });
  child.stdout?.on("error", () => {
    receipt.processError = true;
  });
  return { child, terminal, receipt };
}
function releaseObservers(owner) {
  owner?.child.unref();
  for (const stream of owner?.child.stdio ?? []) stream?.unref?.();
}
function collect(stream, maximum, onFailure) {
  let bytes = Buffer.alloc(0);
  let error = null;
  const ended = new Promise((resolve) => {
    stream.on("data", (chunk) => {
      if (error) return;
      if (bytes.length + chunk.length > maximum) {
        error = "oversized";
        onFailure(error);
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    stream.once("error", () => {
      error ??= "channel_error";
      onFailure(error);
      resolve();
    });
    let end = false;
    stream.once("end", () => {
      end = true;
      resolve();
    });
    stream.once("close", () => {
      if (!end) {
        error ??= "channel_closed";
        onFailure(error);
      }
      resolve();
    });
  });
  return {
    ended,
    get bytes() {
      return bytes;
    },
    get error() {
      return error;
    },
  };
}
function validateRequest(request) {
  check(
    keys(request, [
      "schema",
      "action",
      "home",
      "installLocation",
      "operationId",
      "source",
      "target",
      "drain",
      "pid",
      "processStart",
      "waitSeconds",
      "relaunch",
    ]) &&
      request.schema === "farol.installed-update/1" &&
      ["apply", "rollback"].includes(request.action) &&
      request.relaunch === false &&
      request.installLocation === "legacy" &&
      OPERATION.test(request.operationId) &&
      Number.isSafeInteger(request.pid) &&
      request.pid > 1 &&
      typeof request.processStart === "string" &&
      request.processStart.length > 0 &&
      request.processStart.length <= 128 &&
      request.waitSeconds === 120,
    "REQUEST_INVALID",
  );
  absolute(request.home);
  for (const build of [request.source, request.target])
    check(
      keys(build, ["buildId", "digest", "version"]) &&
        SHA64.test(build.buildId) &&
        SHA64.test(build.digest) &&
        /^[0-9]+\.[0-9]+\.[0-9]+-owner\.beta\.[0-9]+$/u.test(build.version),
      "REQUEST_BUILD",
    );
  check(
    request.source.digest !== request.target.digest &&
      isDeepStrictEqual(request.drain, {
        status: "reconciled",
        acceptedSource: request.source.buildId,
        acceptedTarget: request.target.buildId,
      }),
    "REQUEST_DRAIN",
  );
}
// Test injection owns only the spawn operation. Production always passes the
// independently attested target binary; no shell, locator or fallback exists.
export function startLiveHelper(executable, request, receipt, launch = spawn) {
  absolute(executable);
  validateRequest(request);
  request = structuredClone(request);
  const data = Buffer.from(JSON.stringify(request) + "\n");
  check(data.length <= LIMITS.request, "REQUEST_OVERSIZED");
  receipt.attempted = true;
  receipt.command = "run-live-release-helper";
  receipt.requestSent = false;
  receipt.ack = null;
  receipt.protocolError = null;
  const child = launch(executable, ["run-live-release-helper"], {
    cwd: "/",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"],
  });
  const owner = retainChild(child, receipt);
  const deadlineAt = Date.now() + LIMITS.terminalMs;
  const failure = (reason) => {
    receipt.protocolError ??= reason;
  };
  const output = collect(child.stdout, LIMITS.frame, failure);
  const ack = collect(child.stdio[4], LIMITS.frame, failure);
  child.stdio[3].on("error", () => failure("request_write_unknown"));
  const ready = bounded(ack.ended, LIMITS.ackMs, "ACK_TIMEOUT")
    .then(() => {
      check(
        !receipt.processError && !receipt.protocolError && receipt.requestSent,
        "ACK_CHANNEL_UNKNOWN",
      );
      receipt.ack = parseACK(ack.bytes, request);
      return receipt.ack;
    })
    .catch((error) => {
      failure("ack_refused_or_unknown");
      throw error;
    });
  // A late ACK is diagnostic only; callers never retry Quit or start a replacement.
  ready.catch(() => {});
  const completed = owner.terminal.then(async (exit) => {
    await Promise.all([output.ended, ack.ended]);
    return (receipt.result = classifyTerminal(
      output.bytes,
      request,
      exit,
      receipt.ack,
      receipt.protocolError ?? (receipt.processError ? "process_error" : null),
    ));
  });
  child.once("spawn", () => {
    receipt.pid = child.pid ?? null;
    receipt.requestSent = true;
    child.stdio[3].end(data);
  });
  return { ...owner, ready, completed, deadlineAt };
}

// The only transition that grants one app.quit. Refusal, bad framing and
// timeouts never enter quit; a later terminal failure cannot authorize a retry.
export async function completeHandoff(helper, quit) {
  const ack = await helper.ready;
  if (ack.phase === "refused") {
    await bounded(
      helper.completed,
      Math.max(1, helper.deadlineAt - Date.now()),
      "HELPER_TERMINAL_UNKNOWN",
    );
    throw code("HELPER_REFUSED");
  }
  await quit();
  const result = await bounded(
    helper.completed,
    Math.max(1, helper.deadlineAt - Date.now()),
    "HELPER_TERMINAL_UNKNOWN",
  );
  check(result.status === "passed", "HELPER_TERMINAL_UNCONFIRMED");
  return result;
}

async function remeasure(candidate) {
  await verifyGoCoreArtifact(
    candidate.resources,
    candidate.core,
    candidate.build,
  );
}
async function publishBinding(candidate, operation, request, receipt, owners) {
  await remeasure(candidate);
  const before = await physicalDirectory(operation, true);
  const directory = await fs.open(
    operation,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    check(
      isDeepStrictEqual(pin(await directory.stat()), before),
      "OPERATION_CHANGED",
    );
    receipt.attempted = true;
    receipt.command = "publish-installed-slot-binding";
    const child = spawn(
      candidate.executable,
      [receipt.command, "--build-id", candidate.build.buildId],
      {
        cwd: "/",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore", "pipe", directory.fd],
      },
    );
    const owner = retainChild(child, receipt);
    owners.push(owner);
    let channelError = false;
    const output = collect(child.stdout, 4096, () => {
      channelError = true;
    });
    child.stdio[3].on("error", () => {
      channelError = true;
    });
    child.once("spawn", () => {
      receipt.pid = child.pid;
      child.stdio[3].end(slotBinding(request));
    });
    const exit = await bounded(
      owner.terminal,
      10000,
      "SLOT_PUBLICATION_UNKNOWN",
    );
    await bounded(output.ended, 1000, "SLOT_OUTPUT_UNKNOWN");
    check(
      !receipt.processError &&
        !channelError &&
        exit.code === 0 &&
        exit.signal === null &&
        output.bytes.toString("utf8") === "SLOT_BINDING_OK\n",
      "SLOT_PUBLICATION_UNKNOWN",
    );
    check(
      isDeepStrictEqual(pin(await directory.stat()), before) &&
        isDeepStrictEqual(await physicalDirectory(operation, true), before),
      "OPERATION_CHANGED",
    );
    await remeasure(candidate);
    receipt.status = "confirmed";
  } finally {
    await directory.close();
  }
}

function temporaryParent(value) {
  absolute(value);
  check(
    value === "/private/tmp" ||
      value === "/tmp" ||
      /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(value),
    "TEMP_ROOT_UNSUPPORTED",
  );
}
// These ancestors are also checked by the real helper. A sticky /private/tmp
// fails its ordinary mode guard; refuse before allocation instead of relaxing it.
async function assertHelperAncestors(parent) {
  for (let current = parent; ; current = path.dirname(current)) {
    const info = await fs.lstat(current);
    check(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        [0, process.getuid?.()].includes(info.uid) &&
        (info.mode & 0o022) === 0 &&
        (await fs.realpath(current)) === current,
      "HELPER_ANCESTOR_UNSAFE",
    );
    if (current === path.dirname(current)) break;
  }
}
export async function allocateHome(report = {}) {
  const parent = await fs.realpath(os.tmpdir());
  temporaryParent(parent);
  await assertHelperAncestors(parent);
  report.allocationAttempted = true;
  const root = await fs.mkdtemp(path.join(parent, "farol-e2e-home-"));
  report.profileRoot = root;
  report.home = path.join(root, "home");
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const library = path.join(home, "Library");
  const appData = path.join(library, "Application Support");
  const userData = desktopIdentity("preview", appData).userData;
  const applications = path.join(home, "Applications");
  for (const directory of [home, library, appData, userData, applications])
    await fs.mkdir(directory, { mode: 0o700 });
  const proof = randomUUID();
  await fs.writeFile(path.join(root, ".farol-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
  const directories = [root, home, library, appData, userData, applications];
  const pins = await Promise.all(
    directories.map((directory) => physicalDirectory(directory, true)),
  );
  return {
    root,
    home,
    appData,
    userData,
    applications,
    proof,
    parent,
    directories,
    pins,
  };
}
export async function recheckHome(home) {
  check(
    home.home === path.join(home.root, "home") &&
      home.appData === path.join(home.home, "Library/Application Support") &&
      home.userData === desktopIdentity("preview", home.appData).userData &&
      home.applications === path.join(home.home, "Applications"),
    "HOME_SELECTION",
  );
  temporaryParent(path.dirname(home.root));
  check(
    /^farol-e2e-home-[A-Za-z0-9]{6,}$/u.test(path.basename(home.root)),
    "HOME_SELECTION",
  );
  desktopAppDataPath("preview", home.appData, {
    enabled: true,
    override: home.appData,
    testRoot: home.root,
    testHome: home.home,
    testProof: home.proof,
  });
  for (let index = 0; index < home.directories.length; index++)
    check(
      isDeepStrictEqual(
        await physicalDirectory(home.directories[index], true),
        home.pins[index],
      ),
      "HOME_CHANGED",
    );
}
// Recursive copy preserves every directory/file mode and link spelling. Digest
// verification owns symlink containment; never dereference a packaged alias.
export async function copyApp(source, destination, expectedDigest) {
  check((await treeDigest(source)) === expectedDigest, "COPY_SOURCE_CHANGED");
  async function copy(from, to) {
    const info = await fs.lstat(from);
    if (info.isSymbolicLink()) return fs.symlink(await fs.readlink(from), to);
    if (info.isDirectory()) {
      await fs.mkdir(to, { mode: 0o700 });
      for (const name of await fs.readdir(from))
        await copy(path.join(from, name), path.join(to, name));
      await fs.chmod(to, info.mode & 0o7777);
    } else {
      check(info.isFile(), "COPY_SPECIAL_FILE");
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      await fs.chmod(to, info.mode & 0o7777);
    }
  }
  await copy(source, destination);
  check(
    (await treeDigest(destination)) === expectedDigest &&
      (await treeDigest(source)) === expectedDigest,
    "COPY_TREE_MISMATCH",
  );
}

async function atomicReport(repositoryRoot, report) {
  let current = repositoryRoot;
  await physicalDirectory(current);
  for (const name of ["_output", "evidence", "owner-beta-update-pair"]) {
    current = path.join(current, name);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await fs.lstat(current);
    check(
      info.isDirectory() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o022) === 0 &&
        (await fs.realpath(current)) === current,
      "REPORT_DIRECTORY_UNSAFE",
    );
  }
  const destination = path.join(current, `${report.runId}.json`);
  const temporary = path.join(current, `.${report.runId}-${randomUUID()}.tmp`);
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(report, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  return destination;
}

async function startApp(candidate, home, fixture, report, owners, launch) {
  await recheckHome(home);
  const installed = path.join(home.applications, productBundleName);
  check(
    (await treeDigest(installed)) === candidate.artifactSha256,
    "INSTALLED_TREE_MISMATCH",
  );
  // A prior running obligation forbids reopening, even if an old quit was clean.
  const state = path.join(home.userData, "farol-state");
  check(
    (await readRunMarker(state)).status === "absent",
    "PRIOR_RUNNING_OBLIGATION",
  );
  const lifetime = {
    buildId: candidate.buildId,
    launchAttempted: true,
    quitAttempted: false,
    status: "starting",
  };
  report.lifetimes.push(lifetime);
  let app;
  const pending = launch({
    executablePath: path.join(
      installed,
      "Contents/MacOS",
      desktopIdentity("preview", home.appData).applicationName,
    ),
    args: ["--preview-window-mode=hidden"],
    timeout: 15000,
    env: {
      HOME: home.home,
      TMPDIR: home.parent,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      FAROL_E2E: "1",
      FAROL_E2E_APP_DATA: home.appData,
      FAROL_E2E_TEST_ROOT: home.root,
      FAROL_E2E_TEST_PROOF: home.proof,
      FAROL_E2E_CHATGPT_URL: fixture.url,
    },
  }).then(
    (value) => {
      app = value;
      const owner = retainChild(value.process(), lifetime);
      owners.push(owner);
      // A timed-out launch remains the same original attempt, even if its
      // handle arrives after the failure report. Never replace or signal it.
      if (report.status === "failed") releaseObservers(owner);
      owner.windowObservation = collectWindowObservation(owner.child.stderr);
      return owner;
    },
    () => {
      // The pinned Playwright launcher may abort its own detached process group
      // before exposing a public app handle. Rejection proves neither no spawn
      // nor a clean terminal; preserve this original launch as UNKNOWN.
      lifetime.status = "outcome_unknown";
      lifetime.launchRejected = true;
      throw code("APP_LAUNCH_UNKNOWN");
    },
  );
  // Retain the original late launch; timeout never authorizes another launch.
  pending.catch(() => {});
  const owner = await bounded(pending, 20000, "APP_LAUNCH_UNKNOWN");
  const page = await bounded(app.firstWindow(), 15000, "APP_WINDOW_UNKNOWN");
  const actual = await bounded(
    app.evaluate(({ app, BrowserWindow }) => {
      return {
        pid: process.pid,
        home: app.getPath("home"),
        userData: app.getPath("userData"),
        sessionData: app.getPath("sessionData"),
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        windowObservation:
          typeof app.__farolE2EWindowLifetime === "function"
            ? app.__farolE2EWindowLifetime()
            : null,
      };
    }),
    15000,
    "APP_PATHS_UNKNOWN",
  );
  check(
    actual.pid === owner.child.pid &&
      actual.home === home.home &&
      actual.userData === home.userData &&
      actual.sessionData === home.userData &&
      actual.isPackaged === true &&
      actual.appPath === path.join(installed, "Contents/Resources/app"),
    "APP_IDENTITY_MISMATCH",
  );
  assertWindowSnapshot(actual.windowObservation, owner.child.pid);
  lifetime.native = actual;
  const deadline = Date.now() + 30000;
  for (;;) {
    const ready = await bounded(
      page.evaluate(async () => {
        const value = await window.farol.bootstrap();
        return {
          buildId: value.build.buildId,
          runtimeState: value.runtimeState,
          tasks: value.tasks.length,
        };
      }),
      Math.max(1, deadline - Date.now()),
      "APP_READY_UNKNOWN",
    );
    check(
      ready.buildId === candidate.buildId && ready.tasks === 0,
      "APP_BUILD_OR_WORK_MISMATCH",
    );
    if (ready.runtimeState === "ready") break;
    check(Date.now() < deadline, "APP_READY_UNKNOWN");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const marker = await readRunMarker(state);
  check(
    marker.status === "read" &&
      marker.marker.pid === owner.child.pid &&
      marker.marker.processStart !== null &&
      sameBoot(marker.marker.bootTime, currentBootTimeMs()) &&
      readProcessStart(owner.child.pid) === marker.marker.processStart,
    "RUNNING_IDENTITY_UNKNOWN",
  );
  lifetime.marker = marker.marker;
  lifetime.status = "running";
  await recheckHome(home);
  return { ...owner, app, lifetime, marker: marker.marker, home, state };
}
async function quitApp(owner) {
  check(
    !owner.lifetime.quitAttempted &&
      owner.child.exitCode === null &&
      owner.child.signalCode === null,
    "QUIT_ALREADY_ATTEMPTED_OR_EXITED",
  );
  await recheckHome(owner.home);
  const windowBefore = await bounded(
    owner.app.evaluate(({ app }) =>
      typeof app.__farolE2EWindowLifetime === "function"
        ? app.__farolE2EWindowLifetime()
        : null,
    ),
    5000,
    "VISIBILITY_UNKNOWN",
  );
  assertWindowSnapshot(windowBefore, owner.child.pid);
  const before = await readQuitObservation(owner.state);
  const request = beginQuitObservation(before, owner.child.pid);
  owner.lifetime.quitBefore = before;
  owner.lifetime.quitRequest = request;
  owner.lifetime.quitAttempted = true;
  owner.lifetime.quitDispatch = "pending";
  const dispatch = owner.app
    .evaluate(({ app }) => {
      app.quit();
    })
    .then(
      () => {
        owner.lifetime.quitDispatch = "returned";
      },
      () => {
        owner.lifetime.quitDispatch = "transport-ended-or-rejected";
      },
    );
  const exit = await bounded(owner.terminal, LIMITS.quitMs, "QUIT_UNKNOWN");
  const terminal = { pid: owner.child.pid, ...exit };
  owner.lifetime.windowLifetime = assertWindowLifetime(
    windowBefore,
    owner.windowObservation.snapshot(),
    terminal,
  );
  const after = await readQuitObservation(owner.state);
  owner.lifetime.quitAfter = after;
  const receipt = assertFreshQuit(request, after, terminal);
  check(
    (await readRunMarker(owner.state)).status === "absent",
    "RUNNING_MARKER_RETAINED",
  );
  await bounded(dispatch, 5000, "QUIT_DISPATCH_UNKNOWN");
  owner.lifetime.quit = receipt;
  owner.lifetime.status = "closed";
  // Disconnect after the witnessed close. No second app.quit is ever issued.
  await bounded(owner.app.close(), 5000, "DRIVER_CLOSE_UNKNOWN");
}

export async function runNativePair(pair) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  check(process.platform === "darwin", "DARWIN_REQUIRED");
  for (const candidate of [pair.source, pair.target])
    check(
      candidate.core.build.platform.goarch ===
        (process.arch === "arm64" ? "arm64" : "amd64"),
      "ARCH_MISMATCH",
    );
  const { createServer } = await import("node:http");
  const { _electron: electron } = await import("playwright-core");
  const report = {
    schema: "farol.owner-beta-update-pair/1",
    runId: randomUUID(),
    status: "running",
    source: {
      sourceSHA: pair.source.sourceSHA,
      buildId: pair.source.buildId,
      artifactSha256: pair.source.artifactSha256,
    },
    target: {
      sourceSHA: pair.target.sourceSHA,
      buildId: pair.target.buildId,
      artifactSha256: pair.target.artifactSha256,
    },
    notRun: NOT_RUN,
    lifetimes: [],
    helpers: [],
    publications: [],
    installed: [],
    quarantine: null,
  };
  const owners = [];
  let fixture, home;
  try {
    home = await allocateHome(report);
    report.profileRoot = home.root;
    report.home = home.home;
    const installed = path.join(home.applications, productBundleName);
    await copyApp(pair.source.appPath, installed, pair.source.artifactSha256);
    const update = path.join(home.userData, "installed-updates");
    await fs.mkdir(update, { mode: 0o700 });
    const operationId = randomUUID().replaceAll("-", "");
    const operation = path.join(update, operationId);
    await fs.mkdir(operation, { mode: 0o700 });
    report.operationId = operationId;
    report.operation = operation;
    await copyApp(
      pair.target.appPath,
      path.join(operation, "staged.app"),
      pair.target.artifactSha256,
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<!doctype html><title>Signed out fixture</title><p>Signed out</p>",
      );
    });
    fixture = { server };
    await bounded(
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
      5000,
      "FIXTURE_UNKNOWN",
    );
    fixture.url = `http://127.0.0.1:${server.address().port}/`;
    const build = (candidate) => ({
      digest: candidate.artifactSha256,
      version: candidate.build.version,
      buildId: candidate.buildId,
    });
    let source = await startApp(
      pair.source,
      home,
      fixture,
      report,
      owners,
      electron.launch.bind(electron),
    );
    const request = (action, predecessor) => ({
      schema: "farol.installed-update/1",
      action,
      home: home.home,
      installLocation: "legacy",
      operationId,
      source: build(pair.source),
      target: build(pair.target),
      drain: {
        status: "reconciled",
        acceptedSource: pair.source.buildId,
        acceptedTarget: pair.target.buildId,
      },
      pid: predecessor.child.pid,
      processStart: predecessor.marker.processStart,
      waitSeconds: 120,
      relaunch: false,
    });
    const apply = request("apply", source);
    const publication = {};
    report.publications.push(publication);
    await publishBinding(pair.target, operation, apply, publication, owners);
    async function updateAndQuit(input, predecessor) {
      await recheckHome(home);
      await remeasure(pair.target);
      check(
        readProcessStart(predecessor.child.pid) ===
          predecessor.marker.processStart,
        "PREDECESSOR_CHANGED",
      );
      const receipt = { action: input.action, operationId };
      report.helpers.push(receipt);
      const helper = startLiveHelper(pair.target.executable, input, receipt);
      owners.push(helper);
      await completeHandoff(helper, async () => {
        check(
          predecessor.child.exitCode === null &&
            predecessor.child.signalCode === null,
          "PREDECESSOR_EXITED_BEFORE_QUIT",
        );
        await quitApp(predecessor);
      });
      await remeasure(pair.target);
      const expected = input.action === "apply" ? pair.target : pair.source;
      const digest = await treeDigest(installed);
      report.installed.push({ action: input.action, digest });
      check(digest === expected.artifactSha256, "INSTALLED_TREE_MISMATCH");
    }
    await updateAndQuit(apply, source);
    const targetFirst = await startApp(
      pair.target,
      home,
      fixture,
      report,
      owners,
      electron.launch.bind(electron),
    );
    await quitApp(targetFirst);
    const targetReopen = await startApp(
      pair.target,
      home,
      fixture,
      report,
      owners,
      electron.launch.bind(electron),
    );
    await updateAndQuit(request("rollback", targetReopen), targetReopen);
    source = await startApp(
      pair.source,
      home,
      fixture,
      report,
      owners,
      electron.launch.bind(electron),
    );
    await quitApp(source);
    await recheckHome(home);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = /^(?:OWNER_BETA|NATIVE_LIFETIME)_[A-Z_]+$/u.test(
      error.message,
    )
      ? error.message
      : "OWNER_BETA_UNEXPECTED_REFUSAL_OR_UNKNOWN";
    report.quarantine =
      "Retain disposable home, staged/installed bytes and original known handles; no controller retry, additional signal, recovery or replacement launch. Playwright launch abort may already have signalled its own detached group; unconfirmed launch/terminal remains UNKNOWN";
  } finally {
    // The controller issues no follow-up signal or replacement after failure.
    // Playwright may have already aborted its own launch group. Persist only
    // observed terminals; an exception is never child-exit or no-spawn proof.
    for (const owner of owners) releaseObservers(owner);
    if (fixture) {
      fixture.server.close();
      fixture.server.unref();
    }
    report.unconfirmedLaunches = report.lifetimes
      .filter(
        (lifetime) => lifetime.launchAttempted && lifetime.pid === undefined,
      )
      .map((lifetime) => ({
        buildId: lifetime.buildId,
        status: "original-launch-unconfirmed",
      }));
    report.retainedProcesses = owners
      .filter((owner) => owner.receipt.terminal === null)
      .map((owner) => ({
        pid: owner.child.pid ?? null,
        command: owner.receipt.command ?? "Electron",
        status: "terminal-unconfirmed",
      }));
    try {
      report.receipt = await atomicReport(repositoryRoot, report);
    } catch {
      const failure = code("REPORT_WRITE_UNCONFIRMED");
      failure.nativeEffects = "unconfirmed";
      failure.profileRoot = report.profileRoot ?? null;
      throw failure;
    }
  }
  return { status: report.status, receipt: report.receipt, notRun: NOT_RUN };
}

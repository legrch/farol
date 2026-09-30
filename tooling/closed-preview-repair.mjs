import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import { trustedOwnerHome } from "./promotion-destination.mjs";
import * as leases from "./promotion-lease.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = fileURLToPath(
  new URL("./closed-preview-repair.py", import.meta.url),
);
const HELPER_SHA256 =
  "757c3d4ee0bbc37c9e06c53b5dc221cada544b0f91934d09ce5cd2bb4032237f";
const schema = "farol.next.closed-repair/1";
const sha = /^[0-9a-f]{64}$/u;
const operation = /^[0-9a-f]{32}$/u;
const profileFor = (home) =>
  path.join(home, "Library/Application Support/Farol Next Preview");

async function safeBytes(file, maximum, privateMode = false) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.geteuid()) ||
      (before.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error("CLOSED_REPAIR_FILE_UNSAFE");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== Number(before.size) ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    )
      throw new Error("CLOSED_REPAIR_FILE_CHANGED");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

// Existing profile only. In particular, never let acquirePromotionLease's
// mkdir traverse a redirected parent before the descriptor helper runs.
async function preflightHome(home) {
  for (const directory of [
    home,
    path.join(home, "Applications"),
    path.join(home, "Library"),
    path.join(home, "Library/Application Support"),
    profileFor(home),
    path.join(profileFor(home), "farol-next-state"),
  ]) {
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.geteuid() ||
      (info.mode & 0o022) !== 0 ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("CLOSED_REPAIR_PARENT_UNSAFE");
    if (
      (directory === profileFor(home) ||
        directory.endsWith("/farol-next-state")) &&
      (info.mode & 0o077) !== 0
    )
      throw new Error("CLOSED_REPAIR_PROFILE_UNSAFE");
  }
}

function parseOptions(args) {
  const options = {};
  const valued = new Set(["--expected-predecessor", "--rollback", "--recover"]);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key !== "--apply" && !valued.has(key))
      throw new Error("CLOSED_REPAIR_OPTION_INVALID");
    if (Object.hasOwn(options, key))
      throw new Error("CLOSED_REPAIR_OPTION_REPEATED");
    options[key] = valued.has(key) ? args[++i] : true;
    if (valued.has(key) && typeof options[key] !== "string")
      throw new Error("CLOSED_REPAIR_OPTION_VALUE_MISSING");
  }
  if (options["--rollback"] !== undefined) {
    if (
      Object.keys(options).length !== 1 ||
      !operation.test(options["--rollback"])
    )
      throw new Error("CLOSED_REPAIR_ROLLBACK_INVALID");
    return {
      action: "rollback",
      operationId: options["--rollback"],
      expectedPredecessor: null,
    };
  }
  if (
    options["--apply"] !== true ||
    !sha.test(options["--expected-predecessor"] ?? "") ||
    (options["--recover"] !== undefined &&
      !operation.test(options["--recover"]))
  )
    throw new Error("CLOSED_REPAIR_EXPLICIT_PAIR_REQUIRED");
  return {
    action: "apply",
    operationId: options["--recover"] ?? null,
    expectedPredecessor: options["--expected-predecessor"],
  };
}

function verifyPackage(artifactFile, appPath) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      artifactFile,
      "--app",
      appPath,
    ],
    { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 65536 },
  );
  if (result.error || result.status !== 0)
    throw new Error("CLOSED_REPAIR_PACKAGE_INVALID");
}

// Module-only seams; the script accepts no HOME/source/helper/environment
// overrides. Tests run these exact pinned bytes with a real inherited lock.
export async function runClosedRepairHelper(
  request,
  leaseFd,
  { atPhase, timeoutMs = 180000 } = {},
) {
  const helper = await safeBytes(helperPath, 64 * 1024);
  if (createHash("sha256").update(helper).digest("hex") !== HELPER_SHA256)
    throw new Error("CLOSED_REPAIR_HELPER_INVALID");
  if (!Number.isSafeInteger(leaseFd) || leaseFd < 0)
    throw new Error("CLOSED_REPAIR_LEASE_DESCRIPTOR_INVALID");
  const child = spawn("/usr/bin/python3", ["-I", "-"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: [
      "pipe",
      "pipe",
      "pipe",
      "pipe",
      atPhase ? "pipe" : "ignore",
      atPhase ? "pipe" : "ignore",
      leaseFd,
    ],
  });
  const output = [];
  let size = 0;
  let badOutput = false;
  let launchError;
  let hookWork;
  let hookError;
  child.on("error", (error) => {
    launchError = error;
  });
  const terminal = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536 || stream === child.stderr) {
        badOutput = true;
        child.kill("SIGKILL");
      } else output.push(chunk);
    });
  for (const stream of [child.stdin, child.stdio[3], child.stdio[5]].filter(
    Boolean,
  ))
    stream.on("error", () => {
      badOutput = true;
    });
  if (atPhase)
    child.stdio[4].once("data", () => {
      hookWork = Promise.resolve()
        .then(() => atPhase(child))
        .then(() => child.stdio[5].end("C"))
        .catch((error) => {
          hookError = error;
          child.kill("SIGKILL");
        });
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref();
  child.stdin.end(helper);
  child.stdio[3].end(JSON.stringify(request));
  // close, including a killed or refused child, is always observed before the
  // host can release its lease. No detached helper survives an early return.
  const result = await terminal;
  clearTimeout(timer);
  await hookWork;
  if (hookError) throw hookError;
  if (launchError || result.signal || badOutput)
    throw new Error("CLOSED_REPAIR_OUTCOME_UNCONFIRMED");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(output).toString("utf8"));
  } catch {
    throw new Error("CLOSED_REPAIR_TERMINAL_INVALID");
  }
  if (
    result.code !== 0 ||
    parsed.schema !== schema ||
    !["installed", "rolled_back"].includes(parsed.outcome)
  )
    throw new Error(`CLOSED_REPAIR_UNCONFIRMED:${parsed.code ?? "terminal"}`);
  return parsed.receipt;
}

export async function runClosedRepairCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let lease;
  const leaseApi = dependencies.leases ?? leases;
  try {
    const options = parseOptions(args);
    const home =
      dependencies.home ?? trustedOwnerHome(os.userInfo(), process.geteuid());
    const userData = profileFor(home);
    await preflightHome(home);
    if (typeof leaseApi.promotionLeaseDescriptor !== "function")
      throw new Error("CLOSED_REPAIR_LEASE_DESCRIPTOR_EXPORT_REQUIRED");
    const request = {
      schema,
      home,
      candidate: null,
      ...options,
      target: null,
      sourceCommit: null,
      sourceTreeDigest: null,
      quitDigest: null,
      hook: dependencies.hook ?? null,
    };
    let artifact;
    const currentIdentity =
      dependencies.sourceIdentity ?? (() => sourceIdentity(root, "."));
    const candidateRoot = dependencies.candidateRoot ?? root;
    if (options.action === "apply") {
      const { artifactFile, appPath } = candidatePaths(candidateRoot);
      artifact = JSON.parse(
        (await safeBytes(artifactFile, 65536)).toString("utf8"),
      );
      assertCanonicalArtifactPath(
        candidateRoot,
        artifact,
        "CLOSED_REPAIR_ARTIFACT_PATH_INVALID",
      );
      assertExactSourceIdentity(
        currentIdentity(),
        artifact,
        "CLOSED_REPAIR_SOURCE_NOT_EXACT",
      );
      request.candidate = appPath;
      request.target = {
        digest: artifact.artifactSha256,
        version: artifact.version,
        buildId: artifact.buildId,
      };
      request.sourceCommit = artifact.sourceCommit;
      request.sourceTreeDigest = artifact.sourceTreeDigest;
    }
    lease = await leaseApi.acquirePromotionLease(
      userData,
      artifact?.buildId ?? options.operationId,
      "promotion",
    );
    if (!lease) throw new Error("CLOSED_REPAIR_LEASE_HELD");
    if (artifact) {
      await (dependencies.verify ?? verifyPackage)(
        candidatePaths(candidateRoot).artifactFile,
        request.candidate,
      );
      assertExactSourceIdentity(
        currentIdentity(),
        artifact,
        "CLOSED_REPAIR_SOURCE_CHANGED",
      );
    }
    const activation =
      dependencies.activationObligations ??
      (await import("./promotion-obligations.mjs")).activationObligations;
    const obligations = await activation(userData);
    if (
      !obligations.drained ||
      obligations.obligations.length ||
      obligations.unreadable.length ||
      obligations.changed.length
    )
      throw new Error("CLOSED_REPAIR_ACTIVATION_NOT_DRAINED");
    const quit = await safeBytes(
      path.join(userData, "farol-next-state/last-quit.json"),
      8192,
      true,
    );
    const parsedQuit = JSON.parse(quit.toString("utf8"));
    if (
      Object.keys(parsedQuit).sort().join(",") !==
        "at,drained,schema,unconfirmed" ||
      parsedQuit.schema !== 1 ||
      parsedQuit.drained !== true ||
      !Array.isArray(parsedQuit.unconfirmed) ||
      parsedQuit.unconfirmed.length
    )
      throw new Error("CLOSED_REPAIR_QUIT_UNCONFIRMED");
    request.quitDigest = createHash("sha256").update(quit).digest("hex");
    if (!(await leaseApi.verifyPromotionLease(lease)))
      throw new Error("CLOSED_REPAIR_LEASE_LOST");
    const receipt = await runClosedRepairHelper(
      request,
      leaseApi.promotionLeaseDescriptor(lease),
      { atPhase: dependencies.atPhase, timeoutMs: dependencies.timeoutMs },
    );
    stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `Farol Next Preview cold repair refused: ${error instanceof Error ? error.message : "unconfirmed failure"}\n`,
    );
    return 1;
  } finally {
    if (lease) await leaseApi.releasePromotionLease(lease);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await runClosedRepairCli(process.argv.slice(2));

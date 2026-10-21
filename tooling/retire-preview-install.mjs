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
import {
  activationObligations,
  assertActivationDrained,
} from "./promotion-obligations.mjs";
import * as leases from "./promotion-lease.mjs";
import { readArtifactManifest } from "./promote-preview.mjs";
import { sourceIdentity } from "./source-identity.mjs";

// Explicit old-beta selectors for this legacy install reader.
const LEGACY_PROFILE_DIRECTORY = "Farol Next Preview";
const LEGACY_STATE_DIRECTORY = "farol-next-state";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = "farol.preview-retirement/1";
const HELPER_SHA256 =
  "5aee39bb39ee70e4a7030963fc0dd46b6702af71c197d3af84e036d2b845bbaa";
const LIBRARY_SHA256 =
  "cb49e66027f1026a88e5be1326779676305422d739c977f985e096b101bde1e5";

export function parsePreviewRetirementOptions(args) {
  const values = {};
  const valued = new Set([
    "--operation",
    "--expected-preview",
    "--closed-recovery",
    "--restore",
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (
      (name !== "--apply" && !valued.has(name)) ||
      Object.hasOwn(values, name)
    )
      throw new Error("RETIREMENT_OPTIONS_INVALID");
    values[name] = name === "--apply" ? true : args[++i];
  }
  const restore = values["--restore"] !== undefined;
  const operationId = restore ? values["--restore"] : values["--operation"];
  if (
    (restore
      ? values["--apply"] !== undefined || values["--operation"] !== undefined
      : values["--apply"] !== true) ||
    !/^[0-9a-f]{32}$/u.test(operationId ?? "") ||
    !/^[0-9a-f]{64}$/u.test(values["--expected-preview"] ?? "") ||
    (values["--closed-recovery"] !== undefined &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
        values["--closed-recovery"],
      ))
  )
    throw new Error("RETIREMENT_EXACT_EVIDENCE_REQUIRED");
  return {
    action: restore ? "restore" : "retire",
    operationId,
    expectedPreview: values["--expected-preview"],
    closedRecoveryId: values["--closed-recovery"] ?? null,
  };
}

async function helperBytes(name, expected) {
  const handle = await fs.open(
    path.join(root, "tooling", name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.geteuid() ||
      before.mode & 0o022 ||
      before.size < 1 ||
      before.size > 65536
    )
      throw new Error("RETIREMENT_HELPER_UNTRUSTED");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size ||
      createHash("sha256").update(bytes).digest("hex") !== expected
    )
      throw new Error("RETIREMENT_HELPER_UNTRUSTED");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function runHelper(request, leaseFd, atPhase) {
  const helper = await helperBytes("retire-preview-install.py", HELPER_SHA256);
  const library = await helperBytes("closed-preview-repair.py", LIBRARY_SHA256);
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: [
      "pipe",
      "pipe",
      "pipe",
      "pipe",
      atPhase ? "pipe" : "ignore",
      atPhase ? "pipe" : "ignore",
      leaseFd,
      "pipe",
    ],
  });
  const chunks = [];
  let size = 0;
  let invalid = false;
  let hookError;
  let hookWork;
  const end = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  child.on("error", () => {
    invalid = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536 || stream === child.stderr) {
        invalid = true;
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
  for (const stream of [
    child.stdin,
    child.stdio[3],
    child.stdio[5],
    child.stdio[7],
  ].filter(Boolean))
    stream.on("error", () => {
      invalid = true;
    });
  if (atPhase)
    child.stdio[4].once("data", (chunk) => {
      hookWork = Promise.resolve()
        .then(async () => {
          if (chunk.toString() !== "R")
            throw new Error("RETIREMENT_HOOK_INVALID");
          await atPhase();
          child.stdio[5].end("C");
        })
        .catch((error) => {
          hookError = error;
          child.kill("SIGKILL");
        });
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  timer.unref();
  child.stdin.end(helper);
  child.stdio[3].end(JSON.stringify(request));
  child.stdio[7].end(library);
  // Always observe this exact child before the host releases its kernel lease.
  const terminal = await end;
  clearTimeout(timer);
  await hookWork;
  if (hookError) throw hookError;
  if (invalid || terminal.signal)
    throw new Error("RETIREMENT_OUTCOME_UNCONFIRMED");
  let response;
  try {
    response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("RETIREMENT_TERMINAL_INVALID");
  }
  if (
    response.schema !== schema ||
    terminal.code !== 0 ||
    !["retired", "restored"].includes(response.phase)
  )
    throw new Error(`RETIREMENT_REFUSED:${response.code ?? "terminal"}`);
  return response;
}

// All seams are module-only disposable test inputs; the command accepts no
// alternate HOME, profile, helper, candidate, process or force option.
export async function runPreviewRetirementCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let lease;
  try {
    const runtime = dependencies.runtime ?? {
      nodeOptions: process.env.NODE_OPTIONS,
      nodePath: process.env.NODE_PATH,
      execArgv: process.execArgv,
    };
    if (runtime.nodeOptions || runtime.nodePath || runtime.execArgv.length)
      throw new Error("RETIREMENT_RUNTIME_UNTRUSTED");
    const options = parsePreviewRetirementOptions(args);
    const home =
      dependencies.home ?? trustedOwnerHome(os.userInfo(), process.geteuid());
    const userData = path.join(
      home,
      "Library/Application Support",
      LEGACY_PROFILE_DIRECTORY,
    );
    for (const p of [
      home,
      path.join(home, "Applications"),
      path.join(home, "Library"),
      path.join(home, "Library/Application Support"),
      userData,
      path.join(userData, LEGACY_STATE_DIRECTORY),
    ]) {
      const s = await fs.lstat(p);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.uid !== process.geteuid() ||
        s.mode & 0o022 ||
        (await fs.realpath(p)) !== p ||
        (p.startsWith(userData) && s.mode & 0o077)
      )
        throw new Error("RETIREMENT_PARENT_UNSAFE");
    }
    const candidateRoot = dependencies.candidateRoot ?? root;
    const { artifactFile, appPath } = candidatePaths(candidateRoot);
    const artifact = await readArtifactManifest(artifactFile);
    if (artifact.schema !== 6)
      throw new Error("RETIREMENT_BRANDED_CANDIDATE_REQUIRED");
    assertCanonicalArtifactPath(candidateRoot, artifact);
    const current = dependencies.sourceIdentity ?? (() => sourceIdentity(root));
    assertExactSourceIdentity(current(), artifact);
    lease = await leases.acquirePromotionLease(
      userData,
      artifact.buildId,
      "promotion",
    );
    if (!lease) throw new Error("RETIREMENT_LEASE_HELD");
    const verify =
      dependencies.verify ??
      (() => {
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
          throw new Error("RETIREMENT_PACKAGE_INVALID");
      });
    await verify();
    assertExactSourceIdentity(current(), artifact);
    const obligations = await (
      dependencies.activation ?? activationObligations
    )(userData);
    assertActivationDrained(obligations);
    if (!(await leases.verifyPromotionLease(lease)))
      throw new Error("PROMOTION_LEASE_LOST");
    const result = await runHelper(
      {
        schema,
        home,
        ...options,
        targetBuildId: artifact.buildId,
        hook: dependencies.hook ?? null,
      },
      leases.promotionLeaseDescriptor(lease),
      dependencies.atPhase,
    );
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z0-9_:,-]{1,240}$/u.test(error.message)
        ? error.message
        : "RETIREMENT_OUTCOME_UNCONFIRMED";
    stderr.write(`Farol preview retirement refused: ${code}\n`);
    return 1;
  } finally {
    if (lease) await leases.releasePromotionLease(lease);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runPreviewRetirementCli(process.argv.slice(2));

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPromotionDestination } from "./promotion-destination.mjs";
import { createPromotionLeaseTransfer } from "./promotion-lease.mjs";

const DEFAULT_HELPER = fileURLToPath(
  new URL("./promotion-apply.py", import.meta.url),
);
const HELPER_SHA256 =
  "be78ebefca9280329b766c0aee9dbfdd9adfdab2020f373df236441fdb476ec6";
const MAX_HELPER_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024;
const SUCCESS = "FAROL_PROMOTION_OK\n";
const CLOSE_ON_EXEC = fsConstants.O_CLOEXEC ?? 0;

async function readVerifiedHelper(helperPath) {
  const handle = await fs.open(
    helperPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | CLOSE_ON_EXEC,
  );
  try {
    const before = await handle.stat();
    const effectiveUser = process.geteuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_HELPER_BYTES ||
      (effectiveUser !== undefined && before.uid !== effectiveUser) ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("PROMOTION_HELPER_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== HELPER_SHA256
    ) {
      throw new Error("PROMOTION_HELPER_INVALID");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function appendBounded(chunks, chunk, state) {
  state.bytes += chunk.length;
  if (state.bytes > MAX_OUTPUT_BYTES) {
    throw new Error("PROMOTION_APPLY_OUTPUT_INVALID");
  }
  chunks.push(chunk);
}

export async function runPromotionApply({
  home,
  destination = path.join(home, "Applications/Farol.app"),
  source,
  artifactSha256,
  receiptText,
  lease,
  updaterLockDescriptor,
  onChildStarted,
  afterParentOpened,
  helperPath = DEFAULT_HELPER,
  timeoutMs = 180_000,
}) {
  if (
    !path.isAbsolute(home) ||
    !path.isAbsolute(source) ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256 ?? "") ||
    typeof receiptText !== "string" ||
    Buffer.byteLength(receiptText) > 64 * 1024 ||
    (updaterLockDescriptor !== undefined &&
      (!Number.isSafeInteger(updaterLockDescriptor) ||
        updaterLockDescriptor < 0)) ||
    (onChildStarted !== undefined && typeof onChildStarted !== "function") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error("PROMOTION_APPLY_INPUT_INVALID");
  }
  assertPromotionDestination({ home, source, destination });
  const installLocation =
    destination === "/Applications/Farol.app" ? "shared" : "legacy";
  // This is the original owner's held kernel lock, selected once. Passing a
  // descriptor from a receipt or acquiring another lock cannot authorize it.
  const transfer = await createPromotionLeaseTransfer(lease);
  const helper = await readVerifiedHelper(helperPath);
  if (!(await transfer.verify())) throw new Error("PROMOTION_LEASE_LOST");
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: [
      "pipe",
      "pipe",
      "pipe",
      "pipe",
      afterParentOpened ? "pipe" : "ignore",
      afterParentOpened ? "pipe" : "ignore",
      transfer.descriptor,
      // Maintenance retains its already-held updater lock in this original
      // effect child too. Python leaves fd 7 open until process exit, so owner
      // death cannot release updater exclusion while placement still runs.
      // Ordinary promotion callers omit it; no lock is opened or reacquired.
      updaterLockDescriptor ?? "ignore",
    ],
  });
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let failure;
  let killRequested = false;
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  function stop(error) {
    failure ??= error;
    if (killRequested) return;
    killRequested = true;
    try {
      child.kill("SIGKILL");
    } catch (killError) {
      failure ??= killError;
    }
  }
  // An error or a kill request is not terminal proof. Keep this original close
  // promise alive so the caller retains its lease even after a bounded refusal.
  child.once("error", stop);
  for (const stream of [
    child.stdin,
    child.stdout,
    child.stderr,
    child.stdio[3],
  ])
    stream.on("error", stop);
  let hookPromise = Promise.resolve();
  child.stdout.on("data", (chunk) => {
    try {
      appendBounded(stdout, chunk, stdoutState);
    } catch (error) {
      stop(error);
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      appendBounded(stderr, chunk, stderrState);
    } catch (error) {
      stop(error);
    }
  });
  if (afterParentOpened) {
    const hookOutput = child.stdio[4];
    const hookInput = child.stdio[5];
    hookOutput.on("error", stop);
    hookInput.on("error", stop);
    hookOutput.once("data", (chunk) => {
      hookPromise = Promise.resolve()
        .then(async () => {
          if (chunk.toString("utf8") !== "R") {
            throw new Error("PROMOTION_APPLY_HOOK_INVALID");
          }
          await afterParentOpened();
          hookInput.end("C");
        })
        .catch((error) => {
          stop(error);
        });
    });
  }
  const request = {
    schema: "farol.promotion-apply/1",
    home,
    installLocation,
    source,
    artifactSha256,
    receiptText,
    testHook: Boolean(afterParentOpened),
    lease: { file: lease.file, ...transfer.identity },
  };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      stop(new Error("PROMOTION_APPLY_TIMEOUT"));
      resolve(null);
    }, timeoutMs);
  });
  timer.unref();
  try {
    // Register the original child's lifetime before sending any executable or
    // effect request. Registration failure terminates that same child, once.
    const registration = onChildStarted?.(closed, { pid: child.pid });
    if (registration !== undefined) {
      // The owner registers synchronously. An asynchronous sink must not let
      // effect bytes escape while registration or its failure is still pending.
      void Promise.resolve(registration).catch(() => undefined);
      throw new Error("PROMOTION_APPLY_OWNER_INVALID");
    }
    child.stdin.end(helper);
    child.stdio[3].end(`${JSON.stringify(request)}\n`);
  } catch (error) {
    stop(error);
  }
  const completed = closed.then(async (outcome) => {
    await hookPromise;
    return outcome;
  });
  const outcome = await Promise.race([completed, deadline]).finally(() =>
    clearTimeout(timer),
  );
  if (outcome === null)
    throw new Error("PROMOTION_APPLY_OUTCOME_UNKNOWN", { cause: failure });
  if (failure) throw failure;
  if (
    outcome.signal ||
    outcome.code !== 0 ||
    Buffer.concat(stderr).length !== 0 ||
    Buffer.concat(stdout).toString("utf8") !== SUCCESS
  ) {
    throw new Error(
      `PROMOTION_APPLY_REFUSED:${outcome.code ?? outcome.signal}`,
    );
  }
}

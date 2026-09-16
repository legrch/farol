import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HELPER = fileURLToPath(
  new URL("./promotion-apply.py", import.meta.url),
);
const HELPER_SHA256 =
  "00fd3c376adf7836ed63ae8c1f2e12c7bf70082eefe1f83c0df139be832bdab1";
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
  source,
  artifactSha256,
  receiptText,
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
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error("PROMOTION_APPLY_INPUT_INVALID");
  }
  const helper = await readVerifiedHelper(helperPath);
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
    ],
  });
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let hookFailure;
  let hookPromise = Promise.resolve();
  child.stdout.on("data", (chunk) => {
    try {
      appendBounded(stdout, chunk, stdoutState);
    } catch (error) {
      hookFailure = error;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      appendBounded(stderr, chunk, stderrState);
    } catch (error) {
      hookFailure = error;
      child.kill("SIGKILL");
    }
  });
  if (afterParentOpened) {
    const hookOutput = child.stdio[4];
    const hookInput = child.stdio[5];
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
          hookFailure = error;
          child.kill("SIGKILL");
        });
    });
  }
  const request = {
    schema: "farol.next.promotion-apply/1",
    home,
    source,
    artifactSha256,
    receiptText,
    testHook: Boolean(afterParentOpened),
  };
  child.stdin.end(helper);
  child.stdio[3].end(`${JSON.stringify(request)}\n`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await hookPromise;
  if (hookFailure) throw hookFailure;
  if (timedOut) throw new Error("PROMOTION_APPLY_TIMEOUT");
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

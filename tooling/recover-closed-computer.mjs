import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import { compilerProblems } from "./dependency-digests.mjs";
import { trustedOwnerHome } from "./promotion-destination.mjs";
import {
  activationObligations,
  promotionUserData,
} from "./promotion-obligations.mjs";
import { readArtifactManifest } from "./promote-preview.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseClosedRecoveryOptions(args) {
  const values = {};
  const names = new Set(["--operation", "--expected-run", "--expected-quit"]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if ((name !== "--apply" && !names.has(name)) || Object.hasOwn(values, name))
      throw new Error("CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID");
    values[name] = name === "--apply" ? true : args[++index];
  }
  if (
    values["--apply"] !== true ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
      values["--operation"] ?? "",
    ) ||
    !/^[a-f0-9]{64}$/u.test(values["--expected-run"] ?? "") ||
    !/^[a-f0-9]{64}$/u.test(values["--expected-quit"] ?? "")
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_EXACT_EVIDENCE_REQUIRED");
  return {
    operationId: values["--operation"],
    expectedRunSha256: values["--expected-run"],
    expectedQuitSha256: values["--expected-quit"],
  };
}

async function run() {
  const options = parseClosedRecoveryOptions(process.argv.slice(2));
  if (
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length ||
    compilerProblems(root).length
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_TOOLCHAIN_UNTRUSTED");
  const artifact = await readArtifactManifest(
    candidatePaths(root).artifactFile,
  );
  if (artifact.schema !== 6)
    throw new Error("CLOSED_COMPUTER_RECOVERY_PACKAGE_INVALID");
  assertExactSourceIdentity(sourceIdentity(root), artifact);
  const verify = spawnSync(
    process.execPath,
    [path.join(root, "tooling/verify-package.mjs")],
    { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 65536 },
  );
  if (verify.error || verify.status !== 0)
    throw new Error("CLOSED_COMPUTER_RECOVERY_PACKAGE_INVALID");
  const home = trustedOwnerHome(os.userInfo(), process.geteuid());
  const userData = promotionUserData(home);
  // No HOME/profile/helper override, no process start/stop or provider call.
  // Compile only authenticated, clean, exact candidate source for maintenance.
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-closed-recovery-runner-"),
  );
  try {
    const output = path.join(scratch, "recovery.cjs");
    const { build } = await import("esbuild");
    await build({
      entryPoints: [
        path.join(root, "src/apps/desktop/closed-computer-recovery.ts"),
      ],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
    });
    assertExactSourceIdentity(sourceIdentity(root), artifact);
    const { recoverClosedComputer } = createRequire(import.meta.url)(output);
    const result = await recoverClosedComputer({
      userData,
      ...options,
      desktopState: () => activationObligations(userData),
    });
    process.stdout.write(
      `${JSON.stringify({ ...result, ...options, sourceCommit: artifact.sourceCommit, buildId: artifact.buildId })}\n`,
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await run();
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.message)
        ? error.message
        : "CLOSED_COMPUTER_RECOVERY_REFUSED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

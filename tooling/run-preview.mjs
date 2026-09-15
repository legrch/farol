import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(root, "..");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");
const { artifactFile, appPath } = candidatePaths(root);

function fail(message) {
  process.stderr.write(`Farol Next Preview is not runnable: ${message}\n`);
  process.exitCode = 1;
}

function verify(artifactPath, candidateAppPath) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      artifactPath,
      "--app",
      candidateAppPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error(
      "task next:run accepts no launch flags; use task next:preview for development",
    );
  }

  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
  } catch {
    throw new Error("package is missing; run 'task next:package' first");
  }

  try {
    assertCanonicalArtifactPath(root, artifact);
  } catch {
    throw new Error(
      "package manifest does not identify the canonical repository candidate; run 'task next:package'",
    );
  }

  try {
    assertExactSourceIdentity(
      sourceIdentity(repositoryRoot, scope),
      artifact,
      "CANDIDATE_SOURCE_NOT_EXACT",
    );
  } catch {
    throw new Error(
      "package is stale or source is not exact; commit the intended Next source and run 'task next:package'",
    );
  }

  const verified = verify(artifactFile, appPath);
  if (verified.status !== 0) {
    const detail = `${verified.stderr}${verified.stdout}`.trim();
    throw new Error(
      `package verification failed; run 'task next:package' (${detail || "no verifier detail"})`,
    );
  }
  process.stdout.write(verified.stdout);

  assertExactSourceIdentity(
    sourceIdentity(repositoryRoot, scope),
    artifact,
    "CANDIDATE_SOURCE_CHANGED_DURING_VERIFICATION",
  );
  const executable = path.join(appPath, "Contents/MacOS/Farol Next Preview");
  await fs.access(executable);
  process.stdout.write(`launching verified packaged candidate ${appPath}\n`);

  const child = spawn(executable, [], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (signal) reject(new Error(`application stopped by ${signal}`));
      else resolve(status ?? 1);
    });
  });
  if (code !== 0) throw new Error(`application exited with status ${code}`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown launch failure");
}

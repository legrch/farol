import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import {
  createLaunchSnapshot,
  ownerLaunchEnvironment,
  removeLaunchSnapshot,
} from "./launch-snapshot.mjs";
import { createOwnerLaunchResultCollector } from "./owner-launch-result.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(root, "..");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");
const { artifactFile, appPath } = candidatePaths(root);

function fail(message) {
  process.stderr.write(`Farol Next Preview is not runnable: ${message}\n`);
  process.exitCode = 1;
}

function verify(artifactPath, candidateAppPath, environment) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      artifactPath,
      "--app",
      candidateAppPath,
    ],
    { cwd: root, encoding: "utf8", env: environment },
  );
}

async function main() {
  if (process.env.FAROL_NEXT_OWNER_LAUNCH !== "1") {
    throw new Error("use the canonical owner command 'task next:run'");
  }
  if (process.argv.length !== 2) {
    throw new Error(
      "task next:run accepts no launch flags; use task next:preview for development",
    );
  }

  let artifact;
  let artifactBytes;
  try {
    artifactBytes = await fs.readFile(artifactFile);
    artifact = JSON.parse(artifactBytes.toString("utf8"));
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

  const environment = ownerLaunchEnvironment();
  let snapshot;
  try {
    snapshot = await createLaunchSnapshot({
      sourceApp: appPath,
      artifactBytes,
      artifactSha256: artifact.artifactSha256,
    });
    const verified = verify(
      snapshot.artifactFile,
      snapshot.appPath,
      environment,
    );
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
    const executable = path.join(
      snapshot.appPath,
      "Contents/MacOS/Farol Next Preview",
    );
    await fs.access(executable);
    process.stdout.write(
      `launching isolated verified candidate ${snapshot.appPath} from ${appPath}\n`,
    );

    const resultCollector = createOwnerLaunchResultCollector();
    let protocolError = null;
    const child = spawn(executable, [], {
      cwd: root,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (protocolError) return;
      try {
        resultCollector.push(chunk);
      } catch (error) {
        protocolError = error;
        child.kill("SIGTERM");
      }
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const forwardInterrupt = () => forward("SIGINT");
    const forwardTermination = () => forward("SIGTERM");
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTermination);
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        resolve({ status: status ?? 1, signal });
      });
    }).finally(() => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTermination);
    });
    if (protocolError) throw protocolError;
    if (outcome.signal) {
      throw new Error(`application stopped by ${outcome.signal}`);
    }
    if (outcome.status !== 0) {
      throw new Error(`application exited with status ${outcome.status}`);
    }
    const ownerLaunchResult = resultCollector.finish();
    if (
      ownerLaunchResult !== "primary-started" &&
      ownerLaunchResult !== "reopened"
    ) {
      throw new Error(
        `running Farol Next instance rejected the exact candidate (${ownerLaunchResult}); quit it and launch again`,
      );
    }
  } finally {
    if (snapshot) await removeLaunchSnapshot(snapshot);
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown launch failure");
}

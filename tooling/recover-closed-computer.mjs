import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import { compilerProblems } from "./dependency-digests.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "./build-contract.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import {
  declarationFromBuiltCore,
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "./go-core-artifact.mjs";
import { buildGoBackend } from "./go-backend-build.mjs";
import { readGoBuildInputs } from "./go-build-inputs.mjs";
import { assertResourceManifest } from "./resource-contract.mjs";
import { trustedOwnerHome } from "./promotion-destination.mjs";
import {
  activationObligations,
  promotionUserData,
} from "./promotion-obligations.mjs";
import { readArtifactManifest } from "./promote-preview.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import {
  DEV_DATA_DIRECTORY_NAME,
  LEGACY_DEV_DATA_DIRECTORY_NAME,
  resolveDevDataDirectoryName,
} from "../src/apps/desktop/dev-profile-directory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseClosedRecoveryOptions(args) {
  const values = {};
  const names = new Set(["--operation", "--expected-run", "--expected-quit"]);
  const flags = new Set(["--apply", "--development"]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if ((!flags.has(name) && !names.has(name)) || Object.hasOwn(values, name))
      throw new Error("CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID");
    values[name] = flags.has(name) ? true : args[++index];
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
    ...(values["--development"] === true ? { development: true } : {}),
  };
}

// The trusted owner home remains the only base. This is the same metadata-only
// Dev spelling resolver used by ordinary Task Dev, never a caller profile path.
export function closedRecoveryUserData(
  home,
  development = false,
  inspect,
  canonicalize = realpathSync.native,
) {
  if (typeof development !== "boolean")
    throw new Error("CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID");
  const production = promotionUserData(home);
  if (!development) return production;
  const appData = path.dirname(production);
  const selected = path.join(
    appData,
    resolveDevDataDirectoryName(appData, inspect),
  );
  let physical;
  try {
    physical = canonicalize(selected);
  } catch {
    throw new Error("DEV_PROFILE_DIRECTORY_UNREADABLE");
  }
  // A case-insensitive filesystem may resolve the preferred same-inode alias
  // to the legacy spelling. Preserve the core's exact canonical-path check:
  // only either fixed Dev entry under this exact parent may be selected.
  if (
    physical !== path.join(appData, DEV_DATA_DIRECTORY_NAME) &&
    physical !== path.join(appData, LEGACY_DEV_DATA_DIRECTORY_NAME)
  )
    throw new Error("DEV_PROFILE_DIRECTORY_UNSAFE");
  return physical;
}

export function assertClosedRecoveryProcesses(
  connectorRoot,
  development,
  inspect,
) {
  if (typeof development !== "boolean")
    throw new Error("CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID");
  const roots = [connectorRoot];
  if (development) {
    const profile = path.dirname(path.dirname(connectorRoot));
    const name = path.basename(profile);
    if (
      (name !== DEV_DATA_DIRECTORY_NAME &&
        name !== LEGACY_DEV_DATA_DIRECTORY_NAME) ||
      connectorRoot !==
        path.join(profile, "farol-state", "secure-mcp-connector")
    )
      throw new Error("DEV_PROFILE_DIRECTORY_UNSAFE");
    const alternate =
      name === DEV_DATA_DIRECTORY_NAME
        ? LEGACY_DEV_DATA_DIRECTORY_NAME
        : DEV_DATA_DIRECTORY_NAME;
    roots.push(
      path.join(
        path.dirname(profile),
        alternate,
        "farol-state",
        "secure-mcp-connector",
      ),
    );
  }
  // A child launched before maintenance may have recorded the other spelling.
  // A failed probe is terminal; never use the second alias as a fallback.
  for (const root of roots) inspect(root);
}

// A build directory can assert its own hashes, but cannot authenticate its Go
// producer. Reproduce the exact core with the existing authenticated SDK/module
// builder and original BuildID, then compare its independent declaration before
// maintenance. Neither core executable is run. Retain the unique producer output
// as evidence; the builder owns cleanup of its private compilation scratch.
export async function verifyClosedRecoveryDevBuild(
  repositoryRoot,
  current,
  { readInputs = readGoBuildInputs, rebuildGo = buildGoBackend } = {},
) {
  const directory = path.join(repositoryRoot, "_output/build/app");
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "build-manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== 4 ||
    manifest.sourceMode !== "head-exact" ||
    manifest.inputExact !== true ||
    manifest.dirty !== false
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_BUILD_INVALID");
  const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== entries.length ||
    !manifest.entries.every((entry, index) => entry === entries[index])
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_BUILD_INVALID");
  await verifyBuildEntries(directory, manifest.entrySha256, entries);
  await verifyInputManifest(directory, manifest);
  const identity = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(path.join(directory, "build-identity.json"), "utf8"),
    ),
  );
  if (
    identity.product !== manifest.product ||
    identity.bundleId !== manifest.bundleId ||
    identity.version !== manifest.version ||
    identity.buildId !== manifest.buildId ||
    identity.builtAt !== manifest.builtAt ||
    identity.sourceCommit !== manifest.sourceCommit ||
    identity.sourceTreeDigest !== manifest.sourceTreeDigest ||
    identity.sourceDirty !== manifest.dirty
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_BUILD_INVALID");
  assertExactSourceIdentity(current, identity);
  assertResourceManifest(
    JSON.parse(
      await fs.readFile(path.join(directory, "resource-manifest.json"), "utf8"),
    ),
  );
  await verifyGoCoreArtifact(directory, manifest.core, identity);
  const inputs = await readInputs([
    `--go-inputs=${path.join(repositoryRoot, "_output/go-build-inputs.json")}`,
  ]);
  if (!inputs) throw new Error("CLOSED_COMPUTER_RECOVERY_GO_INPUTS_REQUIRED");
  const reproduced = await rebuildGo({
    repositoryRoot,
    buildIdentity: identity,
    toolchain: inputs.toolchain,
    platform: manifest.core.build.platform,
    moduleInputs: inputs.moduleInputs,
  });
  const expected = declarationFromBuiltCore(reproduced, identity);
  await verifyGoCoreArtifact(directory, expected, identity);
  // Reproduction can take time. Refuse an edited host, ledger or declaration
  // instead of accepting the first read as authority for later maintenance.
  await verifyBuildEntries(directory, manifest.entrySha256, entries);
  await verifyInputManifest(directory, manifest);
  return identity;
}

async function run() {
  const { development = false, ...options } = parseClosedRecoveryOptions(
    process.argv.slice(2),
  );
  if (
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length ||
    compilerProblems(root).length
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_TOOLCHAIN_UNTRUSTED");
  let artifact;
  if (development) {
    artifact = await verifyClosedRecoveryDevBuild(root, sourceIdentity(root));
  } else {
    artifact = await readArtifactManifest(candidatePaths(root).artifactFile);
    if (artifact.schema !== 6 && artifact.schema !== 7)
      throw new Error("CLOSED_COMPUTER_RECOVERY_PACKAGE_INVALID");
    assertExactSourceIdentity(sourceIdentity(root), artifact);
    const verify = spawnSync(
      process.execPath,
      [path.join(root, "tooling/verify-package.mjs")],
      { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 65536 },
    );
    if (verify.error || verify.status !== 0)
      throw new Error("CLOSED_COMPUTER_RECOVERY_PACKAGE_INVALID");
  }
  const home = trustedOwnerHome(os.userInfo(), process.geteuid());
  const userData = closedRecoveryUserData(home, development);
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
    if (development)
      await verifyClosedRecoveryDevBuild(root, sourceIdentity(root));
    const { recoverClosedComputer, assertClosedConnectorProcesses } =
      createRequire(import.meta.url)(output);
    const result = await recoverClosedComputer(
      {
        userData,
        ...options,
        desktopState: () => activationObligations(userData),
      },
      {
        processesAbsent: (root) =>
          assertClosedRecoveryProcesses(
            root,
            development,
            assertClosedConnectorProcesses,
          ),
      },
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, ...options, environment: development ? "dev" : "preview", sourceCommit: artifact.sourceCommit, buildId: artifact.buildId })}\n`,
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

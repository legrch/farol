// Deliberate one-shot installed empty-chain maintenance.
// Fixed owner profile only; no retry, force, resume or normal-start override.
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { candidatePaths } from "./candidate-contract.mjs";
import { readArtifactManifest } from "./promote-preview.mjs";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sourceIdentity } from "./source-identity.mjs";
import { compilerProblems } from "./dependency-digests.mjs";
import { trustedOwnerHome } from "./promotion-destination.mjs";
import { activationObligations } from "./promotion-obligations.mjs";
import {
  closedRecoveryUserData,
  assertClosedRecoveryProcesses,
  verifyClosedRecoveryDevBuild,
} from "./recover-closed-computer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function parseInstalledEmptyRecoveryOptions(args) {
  const values = {};
  const flags = new Set(["--apply"]);
  const fields = new Set([
    "--selection",
    "--selection-sha",
    "--expected-source",
    "--expected-run",
    "--expected-config",
    "--expected-quit",
    "--cold-restart-plan",
    "--cold-restart-plan-sha",
  ]);
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if ((!flags.has(name) && !fields.has(name)) || Object.hasOwn(values, name))
      throw Error("EMPTY_CHAT_RECOVERY_OPTIONS_INVALID");
    values[name] = flags.has(name) ? true : args[++n];
  }
  if (
    values["--apply"] !== true ||
    !path.isAbsolute(values["--selection"] ?? "") ||
    !/^[a-f0-9]{40}$/u.test(values["--expected-source"] ?? "") ||
    !["--selection-sha", "--expected-run", "--expected-config"].every((name) =>
      /^[a-f0-9]{64}$/u.test(values[name] ?? ""),
    ) ||
    !/^[a-f0-9]{64}$/u.test(values["--expected-quit"] ?? "")
  )
    throw Error("EMPTY_CHAT_RECOVERY_EXACT_EVIDENCE_REQUIRED");
  if (
    Object.hasOwn(values, "--cold-restart-plan") ||
    Object.hasOwn(values, "--cold-restart-plan-sha")
  ) {
    if (
      !path.isAbsolute(values["--cold-restart-plan"] ?? "") ||
      !/^[a-f0-9]{64}$/u.test(values["--cold-restart-plan-sha"] ?? "")
    )
      throw Error("COLD_MACHINE_PLAN_EXACT_EVIDENCE_REQUIRED");
  }
  return values;
}

// Both closed production child scopes must be freshly absent; a failed probe
// is terminal for this invocation, never an alias/fallback admission route.
export function assertInstalledEmptyRecoveryProcesses(connectorRoot, inspect) {
  assertClosedRecoveryProcesses(connectorRoot, false, (currentRoot) => {
    inspect(currentRoot);
    inspect(path.join(path.dirname(currentRoot), "go-core"));
  });
}

async function privateBytes(file, maximum) {
  const f = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const a = await f.stat();
    if (
      !a.isFile() ||
      a.nlink !== 1 ||
      a.uid !== process.geteuid() ||
      (a.mode & 0o777) !== 0o600 ||
      a.size > maximum
    )
      throw Error("EMPTY_CHAT_RECOVERY_FILE_UNSAFE");
    const raw = Buffer.alloc(maximum + 1);
    const { bytesRead } = await f.read(raw, 0, raw.length, 0);
    const b = await f.stat();
    const named = await fs.lstat(file);
    if (
      bytesRead !== a.size ||
      b.size !== a.size ||
      b.mtimeMs !== a.mtimeMs ||
      b.ctimeMs !== a.ctimeMs ||
      named.dev !== a.dev ||
      named.ino !== a.ino
    )
      throw Error("EMPTY_CHAT_RECOVERY_STATE_CHANGED");
    return raw.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

export async function runInstalledRecovery(preserved = false) {
  const options = parseInstalledEmptyRecoveryOptions(process.argv.slice(2));
  if (
    process.platform !== "darwin" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length ||
    compilerProblems(root).length
  )
    throw Error("EMPTY_CHAT_RECOVERY_TOOLCHAIN_UNTRUSTED");
  if (!preserved && options["--cold-restart-plan"])
    throw Error("COLD_MACHINE_PLAN_REQUIRES_PRESERVED_MAINTENANCE");
  const current = sourceIdentity(root);
  if (current.dirty || current.commit !== options["--expected-source"])
    throw Error("EMPTY_CHAT_RECOVERY_SOURCE_MISMATCH");
  const identity = await verifyClosedRecoveryDevBuild(root, current);
  const artifact = await readArtifactManifest(
    candidatePaths(root).artifactFile,
  );
  if (
    artifact.schema !== 7 ||
    artifact.sourceCommit !== identity.sourceCommit ||
    artifact.buildId !== identity.buildId
  )
    throw Error("INSTALLED_EMPTY_RECOVERY_PACKAGE_INVALID");
  const verified = spawnSync(
    process.execPath,
    [path.join(root, "tooling/verify-package.mjs")],
    { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 65536 },
  );
  if (verified.error || verified.status !== 0)
    throw Error("INSTALLED_EMPTY_RECOVERY_PACKAGE_INVALID");
  const home = trustedOwnerHome(os.userInfo(), process.geteuid());
  const userData = closedRecoveryUserData(home, false);
  const profileRoot = path.join(userData, "farol-state", "go-core");
  const info = await fs.lstat(profileRoot);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.geteuid() ||
    (info.mode & 0o777) !== 0o700 ||
    (await fs.realpath(profileRoot)) !== profileRoot ||
    !Number.isSafeInteger(info.dev) ||
    !Number.isSafeInteger(info.ino)
  )
    throw Error("EMPTY_CHAT_RECOVERY_ROOT_UNSAFE");
  const marker = await privateBytes(
    path.join(profileRoot, "profile.json"),
    4096,
  );
  const selection = await privateBytes(options["--selection"], 65536);
  if (digest(selection) !== options["--selection-sha"])
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_CHANGED");
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-empty-chat-host-"),
  );
  try {
    const output = path.join(scratch, "host.cjs");
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents:
          'export { recoverInstalledEmptyChat, recoverInstalledPreservedChat } from "./src/apps/desktop/closed-empty-chat-recovery.ts"; export { assertClosedConnectorProcesses } from "./src/apps/desktop/closed-computer-recovery.ts"; export { parseJSON } from "./apps/desktop/bridge/frame.ts"; export { qualifyColdMachineRecoveryPlan } from "./src/apps/desktop/cold-machine-recovery-plan.ts";',
        resolveDir: root,
        sourcefile: "empty-chat-host-entry.ts",
        loader: "ts",
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
    });
    const {
      recoverInstalledEmptyChat,
      recoverInstalledPreservedChat,
      assertClosedConnectorProcesses,
      parseJSON,
      qualifyColdMachineRecoveryPlan,
    } = createRequire(import.meta.url)(output);
    const metadata = parseJSON(marker.toString("utf8"));
    let selected = parseJSON(selection.toString("utf8"));
    // A raw selection cannot assert the privileged before-boot observation.
    if (Object.hasOwn(selected, "ColdRestartBeforeBootSession"))
      throw Error("COLD_MACHINE_PLAN_RAW_SELECTION_REFUSED");
    let coldPlan = null;
    if (options["--cold-restart-plan"]) {
      coldPlan = await qualifyColdMachineRecoveryPlan({
        planPath: options["--cold-restart-plan"],
        expectedPlanSHA256: options["--cold-restart-plan-sha"],
        stateRoot: path.join(userData, "farol-state"),
        expectedRunSHA256: options["--expected-run"],
        expectedQuitSHA256: options["--expected-quit"],
        expectedConfigSHA256: options["--expected-config"],
        selectedRecords: selected.Preserved,
        currentBootSession: async () => {
          const result = spawnSync(
            "/usr/sbin/sysctl",
            ["-n", "kern.bootsessionuuid"],
            {
              encoding: "utf8",
              timeout: 5000,
              maxBuffer: 1024,
              env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            },
          );
          if (result.error || result.status !== 0 || result.signal)
            throw Error("COLD_MACHINE_SESSION_UNAVAILABLE");
          return result.stdout.trim().toLowerCase();
        },
      });
      selected = {
        ...selected,
        ColdRestartBeforeBootSession: coldPlan.beforeBootSession,
      };
    }
    if (
      (preserved
        ? selected.InstalledPreserved !== true ||
          Object.hasOwn(selected, "InstalledEmpty") ||
          !Array.isArray(selected.Preserved) ||
          selected.Preserved.length < 1 ||
          selected.Preserved.length > 128
        : selected.InstalledEmpty !== true ||
          Object.hasOwn(selected, "InstalledPreserved") ||
          Object.hasOwn(selected, "Preserved")) ||
      Object.hasOwn(selected, "UnacknowledgedDev") ||
      Object.hasOwn(selected, "Interrupted") ||
      !Array.isArray(selected.Mutations) ||
      selected.Mutations.length !== 0
    )
      throw Error("EMPTY_CHAT_RECOVERY_SELECTION_MISMATCH");
    if (
      Object.keys(metadata).sort().join(",") !==
        "computerId,profileId,schema" ||
      metadata.schema !== "farol-native-profile/2" ||
      metadata.profileId !== selected.Selection?.Current?.ProfileID ||
      metadata.computerId !== selected.ComputerID ||
      selected.Selection?.BuildID !== identity.buildId
    )
      throw Error("EMPTY_CHAT_RECOVERY_PROFILE_MISMATCH");
    const exact = {
      buildId: identity.buildId,
      operationId: selected.Selection.OperationID,
      current: selected.Selection.Current,
      hostLifetimeId: selected.Selection.HostLifetimeID,
      childLaunchId: selected.Selection.ChildLaunchID,
      backendGeneration: selected.Selection.Next.BackendGeneration,
    };
    const attest = async () => {
      await coldPlan?.recheck();
      const fresh = await verifyClosedRecoveryDevBuild(
        root,
        sourceIdentity(root),
      );
      if (
        fresh.buildId !== identity.buildId ||
        fresh.sourceCommit !== identity.sourceCommit ||
        !(
          await privateBytes(path.join(profileRoot, "profile.json"), 4096)
        ).equals(marker) ||
        !(await privateBytes(options["--selection"], 65536)).equals(selection)
      )
        throw Error("EMPTY_CHAT_RECOVERY_ATTESTATION_CHANGED");
    };
    const recover = preserved
      ? recoverInstalledPreservedChat
      : recoverInstalledEmptyChat;
    const result = await recover({
      userData,
      executable: path.join(root, "_output/build/app/farol-backend"),
      profile: {
        profileId: metadata.profileId,
        root: profileRoot,
        home,
        device: String(info.dev),
        inode: String(info.ino),
      },
      selectionInput: selected,
      exact,
      expectedRunSha256: options["--expected-run"],
      expectedConfigSha256: options["--expected-config"],
      expectedQuitSha256: options["--expected-quit"],
      desktopState: () => activationObligations(userData),
      attest,
      processesAbsent: () => {
        assertInstalledEmptyRecoveryProcesses(
          path.join(userData, "farol-state", "secure-mcp-connector"),
          assertClosedConnectorProcesses,
        );
      },
    });
    process.stdout.write(
      `${JSON.stringify({ ...result, sourceCommit: identity.sourceCommit, buildId: identity.buildId, environment: "preview" })}\n`,
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
    await runInstalledRecovery();
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.message)
        ? error.message
        : "EMPTY_CHAT_RECOVERY_REFUSED_OR_UNKNOWN";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

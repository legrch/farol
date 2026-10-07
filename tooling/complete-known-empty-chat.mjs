// One owner-selected completion of the known 7e8cad pre-recorder failure.
// No generic resume, preparation/ACK replay, profile override or app launch.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sourceIdentity } from "./source-identity.mjs";
import { compilerProblems } from "./dependency-digests.mjs";
import { trustedOwnerHome } from "./promotion-destination.mjs";
import { activationObligations } from "./promotion-obligations.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import {
  verifyBuildEntries,
  verifyInputManifest,
  BUILD_ENTRIES,
} from "./build-contract.mjs";
import { verifyGoCoreArtifact, GO_CORE_ENTRIES } from "./go-core-artifact.mjs";
import {
  closedRecoveryUserData,
  verifyClosedRecoveryDevBuild,
} from "./recover-closed-computer.mjs";
import { assertEmptyRecoveryProcesses } from "./recover-empty-chat.mjs";

const root = path.resolve(import.meta.dirname, "..");
const original = Object.freeze({
  operationId: "7e8cad64-a73f-4a49-a43f-8800faf8e4bb",
  sourceCommit: "4dbeef4523241326c7d674a57dca1fc6e0bee30c",
  sourceTreeDigest:
    "f695fe0f3c363dc0ca5004b70497b8156a2c867ceb56188f8d21a771103ab870",
  buildId: "eaa9c685af409f30fd96475368f7c171532ceea4b2d39873f3eabd2adb9008bb",
  coreSHA: "5c4fac674c7e5e2f6f6877aec55461593b997cadf2bac830c9a9769438554cff",
  failureSHA:
    "d8f7cc16e769196f3e8aa98f714fefba2a5371d70b661ef6fa6f1bc5f6ca7763",
  selectionSHA:
    "8a925c5997b963662669ea78485a05221ed082af59d69ab04a58436b98faeb2c",
  pendingSHA:
    "dae9046198f547d37b967eb1b9667b02c07f2930037e31fcd5ed5b98cde813cd",
  logSHA: "d063bf578449afce07cd8b804121071eb7f189a6b0003ba7a798bf7606aec98b",
  runSHA: "0cc7062117c685474903735c823234029706c1f81fdacfb82dfa0a389be697fc",
  configSHA: "aab749c360e7b213ba6eb4de8df938f82b1a93f32d0d662e04ae3c42ba7904e8",
});
const sum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalFailureDirectory = `/private/tmp/farol-ordinary-empty-recovery-${original.operationId}`;
const originalTerminalLog = path.join(
  originalFailureDirectory,
  "terminal-4dbeef45.log",
);
const fail = () => {
  throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
};

export function parseKnownCompletionOptions(args) {
  const values = {};
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if (
      ![
        "--apply",
        "--development",
        "--expected-source",
        "--completion-operation",
      ].includes(name) ||
      Object.hasOwn(values, name)
    )
      fail();
    values[name] = ["--apply", "--development"].includes(name)
      ? true
      : args[++n];
  }
  if (
    values["--apply"] !== true ||
    values["--development"] !== true ||
    !/^[a-f0-9]{40}$/u.test(values["--expected-source"] ?? "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
      values["--completion-operation"] ?? "",
    ) ||
    values["--completion-operation"] === original.operationId
  )
    fail();
  return values;
}

export function qualifyKnownCompletionFailure(receipt, log, selection) {
  // These pins are the original execution observed by the Lead, not facts
  // reconstructed from journal bytes. Only this exact unique source failure
  // is known to occur after prepareChild's original normal-close/ACK return.
  if (
    sum(receipt) !== original.failureSHA ||
    sum(log) !== original.logSHA ||
    !log.equals(Buffer.from("EMPTY_CHAT_RECOVERY_INTENT_CHANGED\n")) ||
    sum(selection) !== original.selectionSHA
  )
    fail();
  const value = JSON.parse(receipt.toString("utf8"));
  if (
    value.schema !== "farol.known-empty-maintenance-failure/1" ||
    value.operationId !== original.operationId ||
    value.sourceCommit !== original.sourceCommit ||
    value.buildId !== original.buildId ||
    !isDeepStrictEqual(value.originalExecution, {
      sessionId: 4525,
      initialChunk: "a1a28b",
      terminalChunk: "f00484",
      exitCode: 1,
      diagnostic: "EMPTY_CHAT_RECOVERY_INTENT_CHANGED",
      logSHA: original.logSHA,
    }) ||
    value.pendingSHA !== original.pendingSHA ||
    value.selectionSHA !== original.selectionSHA ||
    value.knownStage.recorder !== "NOT_STARTED" ||
    value.knownStage.hostCompletion !== "NOT_PERFORMED"
  )
    fail();
  return Object.freeze({
    sourceCommit: original.sourceCommit,
    originalHostExitCode: 1,
    originalDiagnostic: "EMPTY_CHAT_RECOVERY_INTENT_CHANGED",
    originalOperationId: original.operationId,
    originalBuildId: original.buildId,
    originalChildClose: { exitCode: "0", signal: "", forced: false },
    recorderStarted: false,
    receiptSha256: original.failureSHA,
    pendingSha256: original.pendingSHA,
  });
}

async function bytes(
  file,
  maximum,
  binary = false,
  io = fs,
  retainedTerminal = false,
) {
  if (retainedTerminal && (binary || file !== originalTerminalLog)) fail();
  const f = await io.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const a = await f.stat({ bigint: true });
    if (
      !a.isFile() ||
      a.nlink !== 1n ||
      a.uid !== BigInt(process.geteuid()) ||
      a.size > BigInt(maximum) ||
      (binary
        ? (a.mode & 0o111n) === 0n || (a.mode & 0o022n) !== 0n
        : (a.mode & 0o777n) !== 0o600n &&
          !(retainedTerminal && (a.mode & 0o777n) === 0o644n))
    )
      fail();
    const buffer = Buffer.alloc(Number(a.size) + 1);
    const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead);
    const b = await f.stat({ bigint: true });
    const n = await io.lstat(file, { bigint: true });
    if (
      BigInt(raw.length) !== a.size ||
      a.size !== b.size ||
      a.mtimeNs !== b.mtimeNs ||
      a.ctimeNs !== b.ctimeNs ||
      a.dev !== n.dev ||
      a.ino !== n.ino ||
      n.isSymbolicLink()
    )
      fail();
    return raw;
  } finally {
    await f.close();
  }
}

function sameFailureDirectory(a, b) {
  return (
    a.isDirectory() &&
    b.isDirectory() &&
    !b.isSymbolicLink() &&
    a.uid === BigInt(process.geteuid()) &&
    a.uid === b.uid &&
    (a.mode & 0o7777n) === 0o700n &&
    a.mode === b.mode &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// Only the fixed original diagnostic may retain its observed 0644 mode. The
// private physical parent is held and rechecked; every other evidence file
// keeps the existing 0600 rule. No evidence chmod, copy or rewrite occurs.
export async function readKnownOriginalTerminalLog(io = fs) {
  const directory = await io.open(
    originalFailureDirectory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const before = await directory.stat({ bigint: true });
    if (
      !sameFailureDirectory(
        before,
        await io.lstat(originalFailureDirectory, { bigint: true }),
      ) ||
      (await io.realpath(originalFailureDirectory)) !== originalFailureDirectory
    )
      fail();
    const log = await bytes(originalTerminalLog, 4096, false, io, true);
    if (
      !sameFailureDirectory(before, await directory.stat({ bigint: true })) ||
      !sameFailureDirectory(
        before,
        await io.lstat(originalFailureDirectory, { bigint: true }),
      )
    )
      fail();
    return log;
  } finally {
    await directory.close();
  }
}

// Read-only child, bounded bytes and original execFile completion. It grants no
// drain/terminal authority and cannot prepare, ACK, record, restore or retry.
export function observePreparedEmpty(
  executable,
  profile,
  buildId,
  selected,
  pendingSHA,
  originalSteps,
  parseJSON,
) {
  const args = [
    "inspect-prepared-empty-recovery",
    "--profile",
    profile.profileId,
    "--profile-root",
    profile.root,
    "--profile-device",
    profile.device,
    "--profile-inode",
    profile.inode,
    "--expected-build",
    buildId,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        timeout: 6000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        try {
          if (error || stderr) fail();
          const value = parseJSON(stdout);
          if (
            !isDeepStrictEqual(
              Object.keys(value).sort(),
              [
                "schema",
                "observerBuildId",
                "profileId",
                "publication",
                "acknowledgement",
                "lifecycleSHA",
                "archiveInventoryDigest",
                "newChatRoot",
              ].sort(),
            ) ||
            value.schema !== "farol-prepared-empty-inspection/1" ||
            value.observerBuildId !== buildId ||
            value.profileId !== profile.profileId ||
            !/^[a-f0-9]{64}$/u.test(value.lifecycleSHA) ||
            !/^[a-f0-9]{64}$/u.test(value.archiveInventoryDigest)
          )
            fail();
          resolve({
            publication: value.publication,
            acknowledgement: value.acknowledgement,
            archiveDigest: value.archiveInventoryDigest,
          });
        } catch {
          reject(Error("EMPTY_CHAT_PREPARED_OBSERVATION_REFUSED"));
        }
      },
    );
    child.stdin.on("error", () => {}); // execFile's original completion is authoritative.
    child.stdin.end(
      JSON.stringify({
        Original: selected,
        PendingSHA: [...Buffer.from(pendingSHA, "hex")],
        OriginalSteps: originalSteps,
      }),
    );
  });
}

async function run() {
  const options = parseKnownCompletionOptions(process.argv.slice(2));
  if (
    process.platform !== "darwin" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length ||
    compilerProblems(root).length
  )
    fail();
  const current = sourceIdentity(root);
  if (current.dirty || current.commit !== options["--expected-source"]) fail();
  const evidence = path.join(
    root,
    "_output/evidence/owner-setup-recovery-20261007/main-4dbeef-empty-maintenance-eaa9c685",
  );
  const originalApp = path.join(evidence, "app");
  const oldIdentity = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(path.join(originalApp, "build-identity.json"), "utf8"),
    ),
  );
  const oldDeclaration = JSON.parse(
    await fs.readFile(path.join(originalApp, "core-artifact.json"), "utf8"),
  );
  const reproduced = await bytes(
    path.join(evidence, "original-core-reproduction.json"),
    16384,
  );
  const proof = JSON.parse(reproduced.toString("utf8"));
  if (
    oldIdentity.sourceCommit !== original.sourceCommit ||
    oldIdentity.sourceTreeDigest !== original.sourceTreeDigest ||
    oldIdentity.buildId !== original.buildId ||
    proof.schema !== "farol.original-core-reproduction/1" ||
    proof.result !== "MATCH" ||
    proof.source !== original.sourceCommit ||
    proof.buildId !== original.buildId ||
    proof.reproduced.sha256 !== original.coreSHA ||
    proof.reproduced.inputExact !== true ||
    proof.reproduced.sourceCommit !== original.sourceCommit ||
    proof.reproduced.sourceTreeDigest !== original.sourceTreeDigest ||
    oldDeclaration.binary.sha256 !== original.coreSHA
  )
    fail();
  await verifyGoCoreArtifact(originalApp, oldDeclaration, oldIdentity);
  if (
    sum(
      await bytes(
        path.join(originalApp, "farol-backend"),
        128 * 1024 * 1024,
        true,
      ),
    ) !== original.coreSHA ||
    sum(await bytes(proof.reproduced.path, 128 * 1024 * 1024, true)) !==
      original.coreSHA
  )
    fail();
  const identity = await verifyClosedRecoveryDevBuild(root, current);
  const currentApp = path.join(root, "_output/build/app");
  const currentManifest = JSON.parse(
    await fs.readFile(path.join(currentApp, "build-manifest.json"), "utf8"),
  );
  const failed = originalFailureDirectory;
  const failureBytes = await bytes(
    path.join(failed, "original-failure-receipt.json"),
    16384,
  );
  const log = await readKnownOriginalTerminalLog();
  const selection = await bytes(
    path.join(failed, "selection-4dbeef45.json"),
    65536,
  );
  const failure = {
    ...qualifyKnownCompletionFailure(failureBytes, log, selection),
    completionOperationId: options["--completion-operation"],
  };
  const home = trustedOwnerHome(os.userInfo(), process.geteuid());
  const userData = closedRecoveryUserData(home, true);
  const profileRoot = path.join(userData, "farol-next-state/go-core");
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
    fail();
  const marker = await bytes(path.join(profileRoot, "profile.json"), 4096);
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-known-empty-host-"),
  );
  try {
    const output = path.join(scratch, "host.cjs");
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents:
          'export { completeKnownEmptyChat } from "./src/apps/desktop/closed-empty-chat-recovery.ts"; export { assertClosedConnectorProcesses } from "./src/apps/desktop/closed-computer-recovery.ts"; export { parseJSON } from "./apps/desktop/bridge/frame.ts";',
        resolveDir: root,
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
      completeKnownEmptyChat,
      assertClosedConnectorProcesses,
      parseJSON,
    } = createRequire(import.meta.url)(output);
    const selected = parseJSON(selection.toString("utf8"));
    const metadata = parseJSON(marker.toString("utf8"));
    if (
      Object.keys(metadata).sort().join(",") !==
        "computerId,profileId,schema" ||
      metadata.schema !== "farol-native-profile/2" ||
      metadata.profileId !== selected.Selection?.Current?.ProfileID ||
      metadata.computerId !== selected.ComputerID ||
      selected.Selection?.BuildID !== original.buildId ||
      selected.Selection?.OperationID !== original.operationId
    )
      fail();
    const profile = {
      profileId: metadata.profileId,
      root: profileRoot,
      home,
      device: String(info.dev),
      inode: String(info.ino),
    };
    const s = selected.Selection;
    const attest = async () => {
      const fresh = sourceIdentity(root);
      if (
        fresh.dirty ||
        fresh.commit !== current.commit ||
        fresh.treeDigest !== current.treeDigest ||
        !(
          await bytes(path.join(failed, "original-failure-receipt.json"), 16384)
        ).equals(failureBytes) ||
        !(await readKnownOriginalTerminalLog()).equals(log) ||
        !(
          await bytes(path.join(failed, "selection-4dbeef45.json"), 65536)
        ).equals(selection) ||
        !(await bytes(path.join(profileRoot, "profile.json"), 4096)).equals(
          marker,
        ) ||
        !(
          await bytes(
            path.join(evidence, "original-core-reproduction.json"),
            16384,
          )
        ).equals(reproduced)
      )
        fail();
      await verifyBuildEntries(
        currentApp,
        currentManifest.entrySha256,
        [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
      );
      await verifyInputManifest(currentApp, currentManifest);
      await verifyGoCoreArtifact(currentApp, currentManifest.core, identity);
      await verifyGoCoreArtifact(originalApp, oldDeclaration, oldIdentity);
    };
    const result = await completeKnownEmptyChat({
      userData,
      executable: path.join(originalApp, "farol-backend"),
      profile,
      selectionInput: selected,
      exact: {
        buildId: original.buildId,
        operationId: s.OperationID,
        current: s.Current,
        hostLifetimeId: s.HostLifetimeID,
        childLaunchId: s.ChildLaunchID,
        backendGeneration: s.Next.BackendGeneration,
      },
      expectedRunSha256: original.runSHA,
      expectedConfigSha256: original.configSHA,
      failure,
      desktopState: () => activationObligations(userData),
      attest,
      processesAbsent: () =>
        assertEmptyRecoveryProcesses(
          path.join(userData, "farol-next-state/secure-mcp-connector"),
          assertClosedConnectorProcesses,
        ),
      observePrepared: () =>
        observePreparedEmpty(
          path.join(currentApp, "farol-backend"),
          profile,
          identity.buildId,
          selected,
          original.pendingSHA,
          16,
          parseJSON,
        ),
    });
    process.stdout.write(
      `${JSON.stringify({ ...result, sourceCommit: current.commit, observerBuildId: identity.buildId, originalBuildId: original.buildId, completionOperationId: failure.completionOperationId, environment: "dev" })}\n`,
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
        : "EMPTY_CHAT_KNOWN_COMPLETION_REFUSED_OR_UNKNOWN";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

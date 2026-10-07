// Deliberate one-shot maintenance for the existing ordinary Dev profile ONLY.
// No normal-start override, production profile selection or retry/resume mode.
import fs from "node:fs/promises";
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

export function parseEmptyRecoveryOptions(args) {
  const values = {};
  const flags = new Set(["--apply", "--development"]);
  const fields = new Set([
    "--selection",
    "--selection-sha",
    "--expected-source",
    "--expected-run",
    "--expected-config",
  ]);
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if ((!flags.has(name) && !fields.has(name)) || Object.hasOwn(values, name))
      throw Error("EMPTY_CHAT_RECOVERY_OPTIONS_INVALID");
    values[name] = flags.has(name) ? true : args[++n];
  }
  if (
    values["--apply"] !== true ||
    values["--development"] !== true ||
    !path.isAbsolute(values["--selection"] ?? "") ||
    !/^[a-f0-9]{40}$/u.test(values["--expected-source"] ?? "") ||
    !["--selection-sha", "--expected-run", "--expected-config"].every((name) =>
      /^[a-f0-9]{64}$/u.test(values[name] ?? ""),
    )
  )
    throw Error("EMPTY_CHAT_RECOVERY_EXACT_EVIDENCE_REQUIRED");
  return values;
}

// The two supported Dev spellings can name one physical profile. Both the
// connector and Go child command lines must be absent under either spelling.
export function assertEmptyRecoveryProcesses(connectorRoot, inspect) {
  assertClosedRecoveryProcesses(connectorRoot, true, (currentRoot) => {
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

async function run() {
  const options = parseEmptyRecoveryOptions(process.argv.slice(2));
  if (
    process.platform !== "darwin" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length ||
    compilerProblems(root).length
  )
    throw Error("EMPTY_CHAT_RECOVERY_TOOLCHAIN_UNTRUSTED");
  const current = sourceIdentity(root);
  if (current.dirty || current.commit !== options["--expected-source"])
    throw Error("EMPTY_CHAT_RECOVERY_SOURCE_MISMATCH");
  const identity = await verifyClosedRecoveryDevBuild(root, current);
  const home = trustedOwnerHome(os.userInfo(), process.geteuid());
  const userData = closedRecoveryUserData(home, true);
  const profileRoot = path.join(userData, "farol-next-state", "go-core");
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
          'export { recoverClosedEmptyChat } from "./src/apps/desktop/closed-empty-chat-recovery.ts"; export { assertClosedConnectorProcesses } from "./src/apps/desktop/closed-computer-recovery.ts"; export { parseJSON } from "./apps/desktop/bridge/frame.ts";',
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
      recoverClosedEmptyChat,
      assertClosedConnectorProcesses,
      parseJSON,
    } = createRequire(import.meta.url)(output);
    const metadata = parseJSON(marker.toString("utf8"));
    const selected = parseJSON(selection.toString("utf8"));
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
    const result = await recoverClosedEmptyChat({
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
      desktopState: () => activationObligations(userData),
      attest,
      processesAbsent: () => {
        assertEmptyRecoveryProcesses(
          path.join(userData, "farol-next-state", "secure-mcp-connector"),
          assertClosedConnectorProcesses,
        );
      },
    });
    process.stdout.write(
      `${JSON.stringify({ ...result, sourceCommit: identity.sourceCommit, buildId: identity.buildId, environment: "dev" })}\n`,
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
        : "EMPTY_CHAT_RECOVERY_REFUSED_OR_UNKNOWN";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

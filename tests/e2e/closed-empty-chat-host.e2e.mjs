// Only called by the explicit native Go qualification on a fresh producer-owned
// synthetic tree. No ordinary/production profile, Electron or provider action.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { assertExactSourceIdentity } from "../../tooling/candidate-contract.mjs";
import { activationObligations } from "../../tooling/promotion-obligations.mjs";
import assert from "node:assert/strict";
import {
  verifyBuildEntries,
  verifyInputManifest,
  BUILD_ENTRIES,
} from "../../tooling/build-contract.mjs";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  verifyGoCoreArtifact,
  GO_CORE_ENTRIES,
} from "../../tooling/go-core-artifact.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureFile = process.argv[2];
if (process.argv.length !== 3 || !fixtureFile || !path.isAbsolute(fixtureFile))
  throw Error("HOST_FIXTURE_INVALID");
const fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
// Match the real JS-selected connector records: optional task fields are
// omitted, while the Go pending codec materializes their zero values.
for (const mutation of fixture.Input.Mutations) {
  for (const key of ["SessionID", "TaskID", "TaskEpoch", "ParticipantID"]) {
    const value = mutation.Binding.Identity[key];
    if (value !== "" && value !== 0)
      throw Error("HOST_FIXTURE_TASK_IDENTITY_UNEXPECTED");
    delete mutation.Binding.Identity[key];
  }
}
const userData = path.dirname(path.dirname(fixture.Profile.Root));
if (
  path.basename(userData) !==
    (fixture.Input.InstalledEmpty === true ||
    fixture.Input.InstalledPreserved === true
      ? "Farol Next Preview"
      : "Farol Dev") ||
  path.dirname(path.dirname(userData)) !== path.join(root, "_output/tmp") ||
  !path.basename(path.dirname(userData)).startsWith("retirement-boot-")
)
  throw Error("HOST_FIXTURE_SCOPE_REFUSED");
const phase = async (value) =>
  fs.writeFile(
    path.join(userData, "host-qualification-phase.json"),
    `${JSON.stringify({ phase: value })}\n`,
    { mode: 0o600 },
  );
await phase("artifact_attestation");
const directory = path.join(root, "_output/build/app");
const manifest = JSON.parse(
  await fs.readFile(path.join(directory, "build-manifest.json"), "utf8"),
);
const identity = assertBuildIdentity(
  JSON.parse(
    await fs.readFile(path.join(directory, "build-identity.json"), "utf8"),
  ),
);
if (
  manifest.schema !== 4 ||
  fixture.Input.Selection.BuildID !== identity.buildId
)
  throw Error("HOST_FIXTURE_BUILD_INVALID");
assertExactSourceIdentity(sourceIdentity(root), identity);
await verifyBuildEntries(
  directory,
  manifest.entrySha256,
  [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
);
await verifyInputManifest(directory, manifest);
await verifyGoCoreArtifact(directory, manifest.core, identity);
await phase("artifact_verified");
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-empty-recovery-qualification-"),
);
try {
  const output = path.join(scratch, "host.cjs");
  await build({
    stdin: {
      contents:
        'export { recoverClosedEmptyChat, recoverInterruptedEmptyChat, recoverUnacknowledgedEmptyDev, recoverInstalledEmptyChat, recoverInstalledPreservedChat } from "./src/apps/desktop/closed-empty-chat-recovery.ts"; export { recoverClosedPreservedChat } from "./apps/desktop/bridge/preserved-recovery-host.ts"; export { assertClosedConnectorProcesses } from "./src/apps/desktop/closed-computer-recovery.ts";',
      resolveDir: root,
      loader: "ts",
    },
    outfile: output,
    platform: "node",
    format: "cjs",
    bundle: true,
    target: "node24",
    logLevel: "silent",
  });
  const {
    recoverClosedEmptyChat,
    recoverInterruptedEmptyChat,
    recoverUnacknowledgedEmptyDev,
    recoverInstalledEmptyChat,
    recoverInstalledPreservedChat,
    recoverClosedPreservedChat,
    assertClosedConnectorProcesses,
  } = createRequire(import.meta.url)(output);
  const s = fixture.Input.Selection;
  const interrupted = fixture.Input.Interrupted !== undefined;
  const unacknowledged = fixture.UnacknowledgedDev === true;
  const installed =
    fixture.Input.InstalledEmpty === true ||
    fixture.Input.InstalledPreserved === true;
  const preservedProfile = fixture.PreservedProfile === true;
  const quitAbsent = fixture.QuitAbsent === true;
  if (
    quitAbsent &&
    (!preservedProfile ||
      fixture.PreviousConfirmedQuit === true ||
      Object.hasOwn(fixture, "ExpectedQuitSha256"))
  )
    throw Error("HOST_FIXTURE_QUIT_SCOPE_INVALID");
  if (quitAbsent)
    await assert.rejects(
      fs.lstat(path.join(userData, "farol-next-state", "last-quit.json")),
      { code: "ENOENT" },
    );
  if (unacknowledged || installed || preservedProfile) {
    const actual = await activationObligations(userData, {
      isAlive: () => false,
    });
    assert.deepEqual(actual.unreadable, []);
    assert.deepEqual(actual.changed, []);
    assert.deepEqual(actual.obligations, [
      ...(fixture.PreviousConfirmedQuit === true || quitAbsent
        ? []
        : [
            fixture.Input.InstalledPreserved === true
              ? "QUIT_UNCONFIRMED:go-core"
              : installed || preservedProfile
                ? "QUIT_UNCONFIRMED:connector,go-core"
                : "QUIT_UNCONFIRMED:go-core,connector",
          ]),
      "QUIT_UNCONFIRMED:crash",
    ]);
  }
  if (
    (installed && (unacknowledged || interrupted)) ||
    (unacknowledged && interrupted) ||
    (preservedProfile && (installed || unacknowledged || interrupted))
  )
    throw Error("HOST_FIXTURE_MODE_INVALID");
  const recover = preservedProfile
    ? recoverClosedPreservedChat
    : fixture.Input.InstalledPreserved === true
      ? recoverInstalledPreservedChat
      : installed
        ? recoverInstalledEmptyChat
        : unacknowledged
          ? recoverUnacknowledgedEmptyDev
          : interrupted
            ? recoverInterruptedEmptyChat
            : recoverClosedEmptyChat;
  const result = await recover({
    userData,
    executable: path.join(directory, "farol-backend"),
    profile: {
      profileId: fixture.Profile.ProfileID,
      root: fixture.Profile.Root,
      home: userData,
      device: String(fixture.Profile.Device),
      inode: String(fixture.Profile.Inode),
    },
    selectionInput: fixture.Input,
    exact: {
      buildId: identity.buildId,
      operationId: s.OperationID,
      current: s.Current,
      hostLifetimeId: s.HostLifetimeID,
      childLaunchId: s.ChildLaunchID,
      backendGeneration: s.Next.BackendGeneration,
    },
    expectedRunSha256: fixture.ExpectedRunSha256,
    expectedConfigSha256: fixture.ExpectedConfigSha256,
    ...(!quitAbsent &&
    (interrupted || unacknowledged || installed || preservedProfile)
      ? { expectedQuitSha256: fixture.ExpectedQuitSha256 }
      : {}),
    desktopState: async () =>
      unacknowledged || installed || preservedProfile
        ? activationObligations(userData, { isAlive: () => false })
        : {
            obligations:
              interrupted || unacknowledged
                ? [
                    unacknowledged
                      ? "QUIT_UNCONFIRMED:go-core,connector"
                      : "QUIT_UNCONFIRMED:go-core",
                    "QUIT_UNCONFIRMED:crash",
                  ]
                : ["QUIT_UNCONFIRMED:crash"],
            unreadable: [],
            changed: [],
          },
    processesAbsent: () => {
      assertClosedConnectorProcesses(
        path.join(userData, "farol-next-state/secure-mcp-connector"),
      );
      assertClosedConnectorProcesses(fixture.Profile.Root);
    },
    attest: async () => {
      await phase("host_attestation");
      assertExactSourceIdentity(sourceIdentity(root), identity);
      await verifyGoCoreArtifact(directory, manifest.core, identity);
      await phase("host_attested");
    },
  });
  await phase("host_finished");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

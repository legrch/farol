// Only called by the explicit native Go qualification on a fresh producer-owned
// synthetic tree. No ordinary/production profile, Electron or provider action.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { assertExactSourceIdentity } from "../../tooling/candidate-contract.mjs";
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
  path.basename(userData) !== "Farol Dev" ||
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
        'export { recoverClosedEmptyChat } from "./src/apps/desktop/closed-empty-chat-recovery.ts"; export { assertClosedConnectorProcesses } from "./src/apps/desktop/closed-computer-recovery.ts";',
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
  const { recoverClosedEmptyChat, assertClosedConnectorProcesses } =
    createRequire(import.meta.url)(output);
  const s = fixture.Input.Selection;
  const result = await recoverClosedEmptyChat({
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
    desktopState: async () => ({
      obligations: ["QUIT_UNCONFIRMED:crash"],
      unreadable: [],
      changed: [],
    }),
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

// Fresh native fixture only. Reproduce the actual frozen4d host failure and
// original child closure, then exercise the current read-only observer/host and
// the original recorder. No saved profile, Electron, provider or external MCP.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { observePreparedEmpty } from "../../tooling/complete-known-empty-chat.mjs";

const root = path.resolve(import.meta.dirname, "../..");
if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2] ?? ""))
  throw Error("KNOWN_HOST_FIXTURE_INVALID");
const fixture = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const userData = path.dirname(path.dirname(fixture.Profile.Root));
if (
  path.basename(userData) !== "Farol Dev" ||
  path.dirname(path.dirname(userData)) !== path.join(root, "_output/tmp") ||
  !path.basename(path.dirname(userData)).startsWith("retirement-boot-")
)
  throw Error("KNOWN_HOST_FIXTURE_SCOPE_REFUSED");
const oldRoot =
  "/Users/ac/.codex/worktrees/known-completion-original-core/farol";
const oldApp = path.join(
  root,
  "_output/evidence/owner-setup-recovery-20261007/main-4dbeef-empty-maintenance-eaa9c685/app",
);
const oldIdentity = assertBuildIdentity(
  JSON.parse(
    await fs.readFile(path.join(oldApp, "build-identity.json"), "utf8"),
  ),
);
const oldDeclaration = JSON.parse(
  await fs.readFile(path.join(oldApp, "core-artifact.json"), "utf8"),
);
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
  fixture.Input.Selection.BuildID !== oldIdentity.buildId ||
  oldIdentity.sourceCommit !== "4dbeef4523241326c7d674a57dca1fc6e0bee30c"
)
  throw Error("KNOWN_HOST_FIXTURE_BUILD_INVALID");
assertExactSourceIdentity(sourceIdentity(oldRoot), oldIdentity);
assertExactSourceIdentity(sourceIdentity(root), identity);
await verifyBuildEntries(
  directory,
  manifest.entrySha256,
  [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
);
await verifyInputManifest(directory, manifest);
await verifyGoCoreArtifact(directory, manifest.core, identity);
await verifyGoCoreArtifact(oldApp, oldDeclaration, oldIdentity);
for (const mutation of fixture.Input.Mutations)
  for (const key of ["SessionID", "TaskID", "TaskEpoch", "ParticipantID"]) {
    assert.ok(
      mutation.Binding.Identity[key] === "" ||
        mutation.Binding.Identity[key] === 0,
    );
    delete mutation.Binding.Identity[key];
  }
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-known-empty-qualification-"),
);
try {
  const currentOutput = path.join(scratch, "current.cjs");
  const oldOutput = path.join(scratch, "original.cjs");
  for (const [output, source] of [
    [currentOutput, root],
    [oldOutput, oldRoot],
  ]) {
    const exports =
      output === currentOutput
        ? "export { completeKnownEmptyChat }"
        : "export { recoverClosedEmptyChat }";
    await build({
      stdin: {
        contents: `${exports} from ${JSON.stringify(path.join(source, "src/apps/desktop/closed-empty-chat-recovery.ts"))}; export { assertClosedConnectorProcesses } from ${JSON.stringify(path.join(source, "src/apps/desktop/closed-computer-recovery.ts"))}; export { parseJSON } from ${JSON.stringify(path.join(source, "apps/desktop/bridge/frame.ts"))};`,
        resolveDir: root,
        loader: "ts",
      },
      outfile: output,
      platform: "node",
      format: "cjs",
      bundle: true,
      target: "node24",
      logLevel: "silent",
      nodePaths: [path.join(root, "node_modules")],
    });
  }
  const require = createRequire(import.meta.url);
  const old = require(oldOutput);
  const current = require(currentOutput);
  const s = fixture.Input.Selection;
  const profile = {
    profileId: fixture.Profile.ProfileID,
    root: fixture.Profile.Root,
    home: userData,
    device: String(fixture.Profile.Device),
    inode: String(fixture.Profile.Inode),
  };
  const common = {
    userData,
    executable: path.join(oldApp, "farol-backend"),
    profile,
    selectionInput: fixture.Input,
    exact: {
      buildId: oldIdentity.buildId,
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
      current.assertClosedConnectorProcesses(
        path.join(userData, "farol-next-state/secure-mcp-connector"),
      );
      current.assertClosedConnectorProcesses(profile.root);
    },
    attest: async () => {
      assertExactSourceIdentity(sourceIdentity(root), identity);
      await verifyGoCoreArtifact(directory, manifest.core, identity);
      await verifyGoCoreArtifact(oldApp, oldDeclaration, oldIdentity);
    },
  };
  let originalError;
  try {
    await old.recoverClosedEmptyChat(common);
  } catch (error) {
    originalError = error;
  }
  assert.equal(originalError?.message, "EMPTY_CHAT_RECOVERY_INTENT_CHANGED");
  const state = path.dirname(profile.root);
  const pending = path.join(state, "go-core.empty-recovery.pending");
  const raw = await fs.readFile(pending);
  const pendingSHA = createHash("sha256").update(raw).digest("hex");
  const archive = path.join(profile.root, `chat-retired-${s.OperationID}`);
  await assert.rejects(
    fs.stat(path.join(archive, "maintenance-completed.json")),
  );
  const failure = {
    sourceCommit: oldIdentity.sourceCommit,
    originalHostExitCode: 1,
    originalDiagnostic: originalError.message,
    originalOperationId: s.OperationID,
    originalBuildId: oldIdentity.buildId,
    originalChildClose: { exitCode: "0", signal: "", forced: false },
    recorderStarted: false,
    receiptSha256: createHash("sha256")
      .update(
        "synthetic execution of frozen original source, declared crash projection",
      )
      .digest("hex"),
    pendingSha256: pendingSHA,
    completionOperationId: randomUUID(),
  };
  let observations = 0;
  const input = {
    ...common,
    failure,
    observePrepared: async () => {
      observations++;
      return observePreparedEmpty(
        path.join(directory, "farol-backend"),
        profile,
        identity.buildId,
        fixture.Input,
        pendingSHA,
        4,
        current.parseJSON,
      );
    },
  };
  if (fixture.Case === "archive-corrupt") {
    await fs.writeFile(
      path.join(archive, "chat-handoff-0001.commit"),
      "f".repeat(64),
    );
    await assert.rejects(
      current.completeKnownEmptyChat(input),
      /EMPTY_CHAT_PREPARED_OBSERVATION_REFUSED/u,
    );
    assert.equal(observations, 1);
    assert.ok((await fs.readFile(pending)).equals(raw));
    await assert.rejects(
      fs.stat(path.join(archive, "known-completion-attempt.json")),
    );
    await assert.rejects(
      fs.stat(path.join(profile.root, "chat/chat-handoff-0003.attempt")),
    );
    process.stdout.write(
      `${JSON.stringify({ phase: "archive_corruption_refused", operationId: s.OperationID })}\n`,
    );
  } else if (fixture.Case === "attempt") {
    const attempt = Buffer.from('{"syntheticPriorUnknownRecorder":true}\n');
    await fs.writeFile(
      path.join(archive, "known-completion-attempt.json"),
      attempt,
      { mode: 0o600, flag: "wx" },
    );
    await assert.rejects(
      current.completeKnownEmptyChat(input),
      /EMPTY_CHAT_RECOVERY_STATE_PRESENT/u,
    );
    assert.equal(observations, 0);
    assert.ok((await fs.readFile(pending)).equals(raw));
    assert.ok(
      (
        await fs.readFile(path.join(archive, "known-completion-attempt.json"))
      ).equals(attempt),
    );
    process.stdout.write(
      `${JSON.stringify({ phase: "prior_attempt_refused", operationId: s.OperationID })}\n`,
    );
  } else {
    const result = await current.completeKnownEmptyChat(input);
    assert.equal(result.phase, "prepared_for_cold_start");
    assert.equal(observations, 1);
    assert.ok(
      (await fs.readFile(path.join(archive, "maintenance-intent.json"))).equals(
        raw,
      ),
    );
    const completed = JSON.parse(
      await fs.readFile(
        path.join(archive, "maintenance-completed.json"),
        "utf8",
      ),
    );
    assert.equal(completed.recorderConfirmed, true);
    assert.deepEqual(completed.knownFailure, {
      receiptSha256: failure.receiptSha256,
      completionOperationId: failure.completionOperationId,
    });
    await assert.rejects(current.completeKnownEmptyChat(input));
    assert.equal(observations, 1);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

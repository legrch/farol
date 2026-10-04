/**
 * SOURCE-ONLY preparation: this file never builds or packages an application.
 * Native execution is opt-in and belongs to the caller's exclusive native lane.
 *
 * node tests/e2e/go-core-startup.e2e.mjs --self-test
 * node tests/e2e/go-core-startup.e2e.mjs [--check|--run-native]
 *   --candidate-root /absolute/_output/build/app --source-sha <SHA>
 *   --build-id <buildId> [--dependency-root /absolute/node_modules]
 * Or replace --candidate-root with:
 *   --packaged /absolute/Farol.app --artifact-metadata /absolute/artifact.json
 *   --artifact-sha <independently selected artifactSha256>
 *
 * Exactly one normal main launch, one fresh disposable E2E profile, no Send,
 * no reopening of a closed Go Chat claim, no app-under-test entry compilation.
 * Missing read/denied/revoked witnesses are reported, never counted as passes.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "../../tooling/build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "../../tooling/go-core-artifact.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import {
  TREE_DIGEST_VERSION,
  treeDigest,
} from "../../tooling/artifact-digest.mjs";
import {
  ELECTRON_RUNTIME,
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex40 = /^[a-f0-9]{40}$/u;
const hex64 = /^[a-f0-9]{64}$/u;
const contract = Object.freeze({
  schema: "farol-go-core-startup-harness/1",
  applicationUnderTest:
    "Actual production-built src/apps/desktop/main.ts (main.cjs)",
  scenario:
    "Fresh unconfigured normal startup -> ready -> configuration rename with no grant -> Settings/Appearance -> Quit",
  backendWitness:
    "Production-created go-core/profile.json and computer/computer-access.json, read independently; unchanged zero authority through closure",
  providerWitness:
    "Existing controlled loopback fixture's independent attempted/accepted Send ledger must remain zero, including at child terminal",
  modes: ["--contract", "--self-test", "--check", "--run-native"],
  nativeAuthority:
    "Explicit --run-native; caller owns the exclusive native lane",
  isolation:
    "Existing E2E root/proof/app-data guard; new HOME/AppData, private per-user TMPDIR, hidden windows, fixture tunnel client, no workspace or provider verification",
  missingWitnesses: [
    "Normal Go read bytes/hash and classified Go denial: prepare-readonly-task requires ChatGPT readiness and Computer verification; Check access/Verify workspace use the legacy native helper",
    "Revoked old Go admission/no TS fallback: removing workspace is guarded before Go admission in normal preview; the normal configuration API does not expose the old admission or classified Go outcome",
    "No source-only claim of native execution, live provider/model, installed app, OS dialog/focus, or full migration acceptance",
  ],
});

function selection(args) {
  const result = {
    mode: "--check",
    dependencyRoot: path.join(root, "node_modules"),
  };
  const options = new Map([
    ["--candidate-root", "candidateRoot"],
    ["--packaged", "packaged"],
    ["--artifact-metadata", "artifactMetadata"],
    ["--artifact-sha", "artifactSHA"],
    ["--source-sha", "sourceSHA"],
    ["--build-id", "buildId"],
    ["--dependency-root", "dependencyRoot"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--check", "--run-native"].includes(argument)) {
      assert.equal(seen.has("mode"), false, "MODE_REPEATED");
      seen.add("mode");
      result.mode = argument;
      continue;
    }
    const key = options.get(argument);
    assert.ok(key && !seen.has(key), "OPTION_UNKNOWN_OR_REPEATED");
    seen.add(key);
    const value = args[++index];
    assert.ok(value && !value.startsWith("--"), "OPTION_VALUE_MISSING");
    result[key] = value;
  }
  assert.ok(hex40.test(result.sourceSHA ?? ""), "SOURCE_PIN_REQUIRED");
  assert.ok(hex64.test(result.buildId ?? ""), "BUILD_PIN_REQUIRED");
  assert.equal(
    Boolean(result.candidateRoot) !== Boolean(result.packaged),
    true,
    "SELECT_ONE_ARTIFACT",
  );
  if (result.packaged) {
    assert.ok(
      result.artifactMetadata && hex64.test(result.artifactSHA ?? ""),
      "PACKAGE_PINS_REQUIRED",
    );
  } else {
    assert.equal(result.artifactMetadata, undefined, "PACKAGE_OPTION_WITH_DEV");
    assert.equal(result.artifactSHA, undefined, "PACKAGE_OPTION_WITH_DEV");
  }
  for (const key of [
    "candidateRoot",
    "packaged",
    "artifactMetadata",
    "dependencyRoot",
  ]) {
    if (result[key] !== undefined)
      assert.ok(
        path.isAbsolute(result[key]) &&
          path.resolve(result[key]) === result[key],
        "ABSOLUTE_CANONICAL_PATH_REQUIRED",
      );
  }
  return result;
}

async function regular(file, maximum = 32 * 1024 * 1024) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum),
      "WITNESS_NOT_BOUNDED_REGULAR",
    );
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "mode",
      "mtimeNs",
      "ctimeNs",
      "nlink",
    ])
      assert.equal(after[key], before[key], "WITNESS_CHANGED_DURING_READ");
    assert.equal(BigInt(bytes.length), before.size);
    return bytes;
  } finally {
    await fd.close();
  }
}
async function document(file, maximum) {
  const bytes = await regular(file, maximum);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}
function pins(identity, selected) {
  assert.equal(identity.sourceDirty, false, "DIRTY_ARTIFACT");
  assert.equal(
    identity.sourceCommit,
    selected.sourceSHA,
    "SOURCE_PIN_MISMATCH",
  );
  assert.equal(identity.buildId, selected.buildId, "BUILD_PIN_MISMATCH");
}
async function attest(selected) {
  const appRoot = selected.packaged
    ? path.join(selected.packaged, "Contents/Resources/app")
    : selected.candidateRoot;
  assert.equal(await fs.realpath(appRoot), appRoot, "ARTIFACT_REDIRECTED");
  const identity = assertBuildIdentity(
    (await document(path.join(appRoot, "build-identity.json"), 8192)).value,
  );
  pins(identity, selected);
  const manifest = await document(path.join(appRoot, "build-manifest.json"));
  const build = manifest.value;
  assert.equal(build.schema, 4, "COMPILED_GO_CORE_REQUIRED");
  assert.equal(build.dirty, false);
  assert.equal(build.inputExact, true);
  assert.equal(build.sourceMode, "head-exact");
  assert.equal(build.sourceCommit, identity.sourceCommit);
  assert.equal(build.sourceTreeDigest, identity.sourceTreeDigest);
  assert.equal(build.buildId, identity.buildId);
  assert.deepEqual(
    build.entries,
    [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
  );
  await verifyBuildEntries(appRoot, build.entrySha256, build.entries);
  const ledger = await verifyInputManifest(appRoot, build);
  assert.ok(
    ledger.some(
      (entry) =>
        entry.kind === "source" &&
        entry.path === "src/apps/desktop/main.ts" &&
        entry.exact === true,
    ),
    "NORMAL_MAIN_INPUT_MISSING",
  );
  await verifyGoCoreArtifact(appRoot, build.core, identity);
  // The independent manifest declaration is compiled into normal main. This
  // check is supporting evidence; the Go-created snapshot below proves use.
  const main = (await regular(path.join(appRoot, "main.cjs"))).toString("utf8");
  assert.ok(
    main.includes(build.core.binary.sha256),
    "COMPILED_CORE_DECLARATION_MISSING",
  );
  let artifact = null;
  if (selected.packaged) {
    assert.equal(await fs.realpath(selected.packaged), selected.packaged);
    artifact = await document(selected.artifactMetadata, 8192);
    assert.equal(artifact.value.schema, 7);
    assert.equal(artifact.value.treeDigestVersion, TREE_DIGEST_VERSION);
    pins(artifact.value, selected);
    assert.equal(artifact.value.sourceTreeDigest, identity.sourceTreeDigest);
    assert.equal(artifact.value.artifactPath, selected.packaged);
    assert.equal(artifact.value.artifactSha256, selected.artifactSHA);
    assert.equal(
      await treeDigest(selected.packaged),
      selected.artifactSHA,
      "PACKAGE_HASH_MISMATCH",
    );
    // This authenticates the selected sealed package, not a new package gate.
    // It does not spawn verify-package's native helper or signing probes.
  } else {
    const source = sourceIdentity(root);
    assert.equal(source.dirty, false, "DEV_SOURCE_NOT_EXACT");
    assert.equal(source.commit, selected.sourceSHA, "DEV_SOURCE_PIN_MISMATCH");
    assert.equal(source.treeDigest, identity.sourceTreeDigest);
  }
  return {
    appRoot,
    identity,
    core: build.core,
    manifestSHA: manifest.sha256,
    mainSHA: build.entrySha256["main.cjs"],
    inputLedgerSHA: build.inputLedgerSha256,
    artifactMetadataSHA: artifact?.sha256 ?? null,
    artifactSHA: selected.artifactSHA ?? null,
  };
}

function zeroAuthority(profile, access, computerId) {
  assert.deepEqual(Object.keys(profile).sort(), [
    "computerId",
    "profileId",
    "schema",
  ]);
  assert.equal(profile.schema, "farol-native-profile/1");
  assert.match(profile.profileId, /^[a-f0-9-]{36}$/u);
  assert.equal(profile.computerId, computerId);
  assert.deepEqual(Object.keys(access).sort(), [
    "approval",
    "computerId",
    "generation",
    "ownerId",
    "participants",
    "profileId",
    "revision",
    "schema",
    "seenApproval",
  ]);
  assert.equal(access.schema, 1);
  assert.equal(access.profileId, profile.profileId);
  assert.equal(access.ownerId, "owner-desktop");
  assert.equal(access.computerId, computerId);
  assert.equal(access.revision, "0", "UNEXPECTED_AUTHORITY_PUBLICATION");
  assert.equal(access.generation, "0");
  assert.equal(access.seenApproval, false);
  assert.equal(access.approval, null, "EMPTY_OR_NONEMPTY_APPROVAL_FORBIDDEN");
  assert.deepEqual(access.participants, {}, "FRESH_PROFILE_HAS_ADMISSION");
}
function zeroSends(ledger) {
  assert.equal(ledger.attemptedSends, 0, "STARTUP_ATTEMPTED_SEND");
  assert.equal(ledger.acceptedSends, 0, "STARTUP_ACCEPTED_SEND");
  assert.deepEqual(ledger.ledger, []);
  assert.deepEqual(ledger.turns, []);
}
function cleanClosure(cleanup) {
  assert.equal(cleanup.launchResolved, true, "LAUNCH_OUTCOME_UNKNOWN");
  assert.equal(cleanup.closeRequested, true, "CLOSE_NOT_REQUESTED");
  assert.equal(cleanup.exitObserved, true, "CHILD_TERMINAL_UNKNOWN");
  assert.equal(cleanup.exitCode, 0, "CHILD_EXIT_FAILED");
  assert.equal(cleanup.signal, null, "CHILD_SIGNAL_DEATH");
  assert.equal(cleanup.drained, true, "GO_OR_OTHER_CHILD_DRAIN_UNCONFIRMED");
  assert.equal(cleanup.runMarkerRemoved, true, "RUN_MARKER_RETAINED");
  assert.equal(cleanup.siteClosed, true, "FIXTURE_CLOSE_UNKNOWN");
}
async function bounded(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function ready(window, active) {
  await window
    .locator(".desktop")
    .waitFor({ state: "visible", timeout: 15000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    active();
    const value = await bounded(
      window.evaluate(() => window.farolNext.bootstrap()),
      3000,
      "BOOTSTRAP_READ_UNKNOWN",
    );
    if (
      value.runtimeState === "ready" &&
      value.configuration.status === "ready"
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("NORMAL_GO_STARTUP_NOT_READY");
}
function unconfigured(bootstrap) {
  assert.equal(bootstrap.runtimeState, "ready");
  assert.equal(bootstrap.configuration.status, "ready");
  const settings = bootstrap.configuration.settings;
  assert.deepEqual(settings.computer.workspaces, []);
  assert.equal(settings.setup.computer.verified, null);
  assert.equal(settings.setup.chatgpt.verified, null);
  return settings;
}

async function native(selected, inputs, report, save) {
  assert.equal(process.platform, "darwin", "DARWIN_NATIVE_LANE_REQUIRED");
  // Explicit dependency location uses installed bytes; never install or link.
  assert.equal(
    await fs.realpath(selected.dependencyRoot),
    selected.dependencyRoot,
  );
  const playwrightDirectory = path.join(
    selected.dependencyRoot,
    "playwright-core",
  );
  const playwright = await document(
    path.join(playwrightDirectory, "package.json"),
  );
  assert.equal(
    playwright.value.version,
    "1.63.0",
    "PLAYWRIGHT_VERSION_MISMATCH",
  );
  const require = createRequire(import.meta.url);
  const { _electron: electron } = require(playwrightDirectory);
  const executable = selected.packaged
    ? path.join(selected.packaged, "Contents/MacOS/Farol Next Preview")
    : path.join(
        selected.dependencyRoot,
        "electron/dist/Electron.app/Contents/MacOS/Electron",
      );
  if (!selected.packaged)
    assertRuntimeObservation(
      await observeElectronRuntime(
        path.join(selected.dependencyRoot, "electron"),
      ),
      ELECTRON_RUNTIME,
    );
  // Reuse an existing guard-owned root name; new prefixes require a production
  // isolation change and are deliberately outside this harness's scope.
  const temp = await fs.realpath(os.tmpdir());
  assert.match(
    temp,
    /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u,
    "PRIVATE_MACOS_TEMP_REQUIRED_NO_FALLBACK",
  );
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-startup-")),
  );
  await fs.chmod(temporary, 0o700);
  report.temporary = temporary;
  report.cleanup = {
    launchAttempted: false,
    launchResolved: false,
    closeRequested: false,
    siteClosed: false,
    temporaryRemoved: false,
  };
  const home = path.join(temporary, "home");
  const appData = path.join(temporary, "app-data");
  // Match the existing Dev harness: keep native socket roots in the private
  // per-user macOS temp directory. A nested TMPDIR exceeds AF_UNIX limits;
  // /private/tmp is refused by Go's writable-ancestor policy.
  for (const directory of [home, appData])
    await fs.mkdir(directory, { mode: 0o700 });
  const proof = randomUUID();
  await fs.writeFile(path.join(temporary, ".farol-next-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
  const tunnelClient = path.join(temporary, "tunnel-client.cjs");
  await fs.writeFile(
    tunnelClient,
    `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
    { mode: 0o700, flag: "wx" },
  );
  let site;
  let application;
  let child;
  let exited;
  let stateRoot;
  let abort;
  const cancel = () => {
    abort = "HARNESS_CANCELLED";
  };
  const active = () => {
    if (abort) throw new Error(abort);
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const capture = async (label, computerId) => {
    const profile = await document(
      path.join(stateRoot, "go-core/profile.json"),
      4096,
    );
    const access = await document(
      path.join(stateRoot, "go-core/computer/computer-access.json"),
      1024 * 1024,
    );
    zeroAuthority(profile.value, access.value, computerId);
    report.snapshots.push({ label, profile, access });
    zeroSends(site.driver.snapshot());
    await save();
  };
  const close = async () => {
    assert.equal(
      report.cleanup.closeRequested,
      false,
      "DUPLICATE_CLOSE_FORBIDDEN",
    );
    report.cleanup.closeRequested = true;
    assert.ok(child.kill("SIGINT"), "OWNED_QUIT_SIGNAL_FAILED");
    await bounded(exited, 15000, "ELECTRON_CLOSE_UNKNOWN");
    report.cleanup.exitObserved = true;
    report.cleanup.exitCode = child.exitCode;
    report.cleanup.signal = child.signalCode;
    const quit = await document(path.join(stateRoot, "last-quit.json"), 8192);
    assert.equal(quit.value.schema, 1);
    assert.equal(quit.value.drained, true);
    assert.deepEqual(quit.value.unconfirmed, []);
    report.quitReceipt = quit;
    report.cleanup.drained = true;
    await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
      code: "ENOENT",
    });
    report.cleanup.runMarkerRemoved = true;
  };
  try {
    const { startControlledChatGptSite } =
      await import("./fixtures/chatgpt-controlled-site.mjs");
    site = await startControlledChatGptSite({
      conversationId: "startup-no-send-conversation",
      selection: { model: "Startup fixture", effort: "Light", connector: null },
      turns: [
        {
          userId: "startup-user",
          replyId: "startup-reply",
          prompt: "No startup Send is authorized",
          segments: [
            { id: "startup-segment", text: "Unreleased startup canary" },
          ],
        },
      ],
    });
    report.fixture = {
      origin: site.origin,
      playwrightVersion: playwright.value.version,
    };
    const environment = {
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: temporary,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelClient,
      FAROL_NEXT_E2E_CHATGPT_URL: site.url,
      ...(selected.packaged ? {} : { FAROL_NEXT_ENVIRONMENT: "dev" }),
      HOME: home,
      TMPDIR: temp,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    };
    report.cleanup.launchAttempted = true;
    await save();
    active();
    application = await electron.launch({
      executablePath: executable,
      args: [
        ...(selected.packaged ? [] : [path.join(inputs.appRoot, "main.cjs")]),
        "--preview-window-mode=hidden",
      ],
      env: environment,
      timeout: 15000,
    });
    report.cleanup.launchResolved = true;
    child = application.process();
    exited = once(child, "exit");
    // Observe terminal immediately; a rejection must not become unhandled.
    exited.catch(() => undefined);
    const window = await application.firstWindow({ timeout: 15000 });
    const bootstrap = await ready(window, active);
    const settings = unconfigured(bootstrap);
    const paths = await bounded(
      application.evaluate(({ app }) => ({
        name: app.getName(),
        userData: app.getPath("userData"),
        sessionData: app.getPath("sessionData"),
      })),
      3000,
      "PROFILE_PROJECTION_UNKNOWN",
    );
    assert.equal(
      path.dirname(paths.userData),
      appData,
      "PROFILE_ESCAPED_DISPOSABLE_APP_DATA",
    );
    assert.equal(paths.sessionData, paths.userData);
    assert.equal(paths.name, selected.packaged ? "Farol" : "Farol Dev");
    assert.equal(bootstrap.environment, selected.packaged ? "preview" : "dev");
    assert.equal(
      bootstrap.applicationId,
      selected.packaged ? "local.farol.next.preview" : "local.farol.dev",
    );
    stateRoot = path.join(paths.userData, "farol-next-state");
    report.profile = paths;
    const hidden = async () => {
      const windows = await bounded(
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((value) => ({
            visible: value.isVisible(),
            focused: value.isFocused(),
          })),
        ),
        3000,
        "WINDOW_PROJECTION_UNKNOWN",
      );
      assert.ok(windows.length > 0);
      assert.ok(
        windows.every((value) => !value.visible && !value.focused),
        "TEST_WINDOW_VISIBLE_OR_FOCUSED",
      );
      report.windows.push(windows);
    };
    await hidden();
    await capture("fresh-ready", settings.computer.computerId);
    // Ordinary preload/configuration IPC, one bounded mutation of disposable
    // settings. A Computer-generation change exercises withdrawal/publication
    // without granting a folder or manufacturing a Go admission.
    const renamed = await bounded(
      window.evaluate(() =>
        window.farolNext.configure({
          kind: "computer.rename",
          name: "Startup regression computer",
        }),
      ),
      5000,
      "SETTINGS_MUTATION_OUTCOME_UNKNOWN",
    );
    assert.equal(renamed.ok, true, "ZERO_AUTHORITY_SETTINGS_CHANGE_FAILED");
    assert.equal(
      renamed.snapshot.settings.computer.name,
      "Startup regression computer",
    );
    assert.equal(
      renamed.snapshot.settings.computer.generation,
      settings.computer.generation + 1,
    );
    assert.deepEqual(renamed.snapshot.settings.computer.workspaces, []);
    await window
      .getByRole("button", { name: "Settings", exact: true })
      .click({ timeout: 5000 });
    await window
      .locator(".contextual-sidebar")
      .getByRole("button", { name: "Appearance", exact: true })
      .click({ timeout: 5000 });
    await window
      .getByRole("heading", { name: "Appearance", exact: true, level: 2 })
      .waitFor({ timeout: 5000 });
    await window
      .getByRole("button", { name: "Graphite", exact: true })
      .click({ timeout: 5000 });
    await window.waitForFunction(
      () => document.querySelector(".desktop")?.dataset.theme === "graphite",
      undefined,
      { timeout: 5000 },
    );
    unconfigured(await ready(window, active));
    const savedSettings = await document(
      path.join(stateRoot, "config.json"),
      256 * 1024,
    );
    assert.deepEqual(savedSettings.value.computer.workspaces, []);
    assert.equal(
      savedSettings.value.computer.name,
      "Startup regression computer",
    );
    assert.equal(
      savedSettings.value.computer.generation,
      settings.computer.generation + 1,
    );
    report.settingsSHA = savedSettings.sha256;
    await capture("settings-ui-zero-authority", settings.computer.computerId);
    await hidden();
    active();
    await close();
    await capture(
      "confirmed-quit-zero-authority",
      settings.computer.computerId,
    );
    report.scenarioPassed = true;
  } finally {
    // A failed/unknown launch is never relaunched. A requested but unknown quit
    // is never retried or reinterpreted as clean; preserve the profile for Lead.
    if (application && !report.cleanup.closeRequested) {
      try {
        await close();
      } catch (error) {
        report.cleanup.closeError = String(error);
      }
    }
    if (site) {
      report.ledger = site.driver.snapshot();
      try {
        zeroSends(report.ledger);
      } catch (error) {
        report.cleanup.ledgerError = String(error);
      }
      try {
        await bounded(site.close(), 3000, "FIXTURE_CLOSE_UNKNOWN");
        report.cleanup.siteClosed = true;
      } catch (error) {
        report.cleanup.siteError = String(error);
      }
    }
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    try {
      cleanClosure(report.cleanup);
      assert.equal(report.cleanup.ledgerError, undefined);
      await fs.rm(temporary, { recursive: true });
      report.cleanup.temporaryRemoved = true;
    } catch (error) {
      report.cleanup.retainedReason = String(error);
    }
    await save();
  }
  cleanClosure(report.cleanup);
  assert.equal(report.cleanup.temporaryRemoved, true, "RESOURCES_RETAINED");
  assert.equal(report.scenarioPassed, true);
}

function selfTest() {
  let checks = 0;
  const pass = (call) => {
    call();
    checks++;
  };
  const reject = (call) => {
    assert.throws(call);
    checks++;
  };
  const profile = {
    schema: "farol-native-profile/1",
    profileId: "12345678-1234-1234-1234-123456789abc",
    computerId: "computer-test",
  };
  const access = {
    schema: 1,
    profileId: profile.profileId,
    ownerId: "owner-desktop",
    computerId: profile.computerId,
    revision: "0",
    generation: "0",
    seenApproval: false,
    approval: null,
    participants: {},
  };
  pass(() => zeroAuthority(profile, access, profile.computerId));
  for (const [key, value] of [
    ["approval", { workspaces: [] }],
    ["participants", { fabricated: {} }],
    ["revision", "1"],
    ["generation", "1"],
    ["seenApproval", true],
    ["profileId", "wrong-profile"],
    ["computerId", "wrong-computer"],
    ["ownerId", "wrong-owner"],
    ["schema", 2],
  ])
    reject(() =>
      zeroAuthority(profile, { ...access, [key]: value }, profile.computerId),
    );
  const ledger = { attemptedSends: 0, acceptedSends: 0, ledger: [], turns: [] };
  pass(() => zeroSends(ledger));
  for (const mutation of [
    { attemptedSends: 1 },
    { acceptedSends: 1 },
    { ledger: [{}] },
    { turns: [{}] },
  ])
    reject(() => zeroSends({ ...ledger, ...mutation }));
  const cleanup = {
    launchResolved: true,
    closeRequested: true,
    exitObserved: true,
    exitCode: 0,
    signal: null,
    drained: true,
    runMarkerRemoved: true,
    siteClosed: true,
  };
  pass(() => cleanClosure(cleanup));
  for (const [key, value] of Object.entries(cleanup))
    reject(() =>
      cleanClosure({
        ...cleanup,
        [key]:
          typeof value === "boolean" ? false : key === "signal" ? "SIGKILL" : 1,
      }),
    );
  const args = [
    "--candidate-root",
    "/tmp/candidate",
    "--source-sha",
    "a".repeat(40),
    "--build-id",
    "b".repeat(64),
  ];
  pass(() => assert.equal(selection(args).mode, "--check"));
  pass(() =>
    assert.equal(selection(["--run-native", ...args]).mode, "--run-native"),
  );
  for (const extra of [
    ["--build-only"],
    ["--run-native", "--check"],
    ["--source-sha", "a".repeat(40)],
    ["--artifact-sha", "c".repeat(64)],
    ["--packaged", "/tmp/Farol.app"],
  ])
    reject(() => selection([...args, ...extra]));
  reject(() => selection([]));
  reject(() =>
    selection(
      args.map((value) => (value === "/tmp/candidate" ? "relative" : value)),
    ),
  );
  const selected = selection(args);
  const packageArgs = [
    "--packaged",
    "/tmp/Farol.app",
    "--artifact-metadata",
    "/tmp/artifact.json",
    "--artifact-sha",
    "c".repeat(64),
    "--source-sha",
    "a".repeat(40),
    "--build-id",
    "b".repeat(64),
  ];
  pass(() => assert.equal(selection(packageArgs).mode, "--check"));
  reject(() => selection(packageArgs.slice(0, 4)));
  reject(() =>
    selection(packageArgs.filter((value, index) => index !== 4 && index !== 5)),
  );
  const identity = {
    sourceDirty: false,
    sourceCommit: selected.sourceSHA,
    buildId: selected.buildId,
  };
  pass(() => pins(identity, selected));
  reject(() => pins({ ...identity, sourceDirty: true }, selected));
  reject(() => pins({ ...identity, sourceCommit: "d".repeat(40) }, selected));
  reject(() => pins({ ...identity, buildId: "d".repeat(64) }, selected));
  process.stdout.write(
    `Go startup harness browser-free contract checks: ${checks} passed; native NOT RUN\n`,
  );
}

async function main(args) {
  const selected = selection(args);
  const report = {
    contract,
    selection: selected,
    status: "checking",
    nativeRun: false,
    snapshots: [],
    windows: [],
    cleanup: null,
  };
  const output = path.join(root, "_output/evidence");
  await fs.mkdir(output, { recursive: true });
  const reportPath = path.join(output, `go-core-startup-${randomUUID()}.json`);
  const save = async () => {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  };
  try {
    report.harnessSource = sourceIdentity(root);
    assert.equal(
      report.harnessSource.dirty,
      false,
      "HARNESS_SOURCE_NOT_COMMITTED_EXACT",
    );
    report.harnessSHA = hash(await regular(fileURLToPath(import.meta.url)));
    report.attestation = await attest(selected);
    if (selected.mode === "--check") report.status = "checked-native-not-run";
    else {
      report.nativeRun = true;
      await native(selected, report.attestation, report, save);
      const after = await attest(selected);
      assert.deepEqual(
        after,
        report.attestation,
        "ARTIFACT_CHANGED_DURING_NATIVE_RUN",
      );
      assert.deepEqual(
        sourceIdentity(root),
        report.harnessSource,
        "HARNESS_CHANGED_DURING_NATIVE_RUN",
      );
      report.status = "passed-fresh-startup-zero-authority-only";
    }
  } catch (error) {
    report.status = "failed-or-unknown";
    report.error = String(error?.stack ?? error);
    throw error;
  } finally {
    await save();
    process.stdout.write(
      `Go startup evidence: ${reportPath} (${report.status})\n`,
    );
  }
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--contract")
  process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
else if (args.length === 1 && args[0] === "--self-test") selfTest();
else await main(args);

/**
 * Source/build check by default. Native execution requires the caller's exclusive
 * native lane and --run-native. Never build a dirty candidate here.
 *
 * node tests/e2e/go-chat-normal.e2e.mjs --contract
 * node tests/e2e/go-chat-normal.e2e.mjs [--check|--build-only|--run-native]
 *   --candidate-root /absolute/clean/_output/build/app
 *   --source-sha <independently accepted SHA> --build-id <accepted buildId>
 *
 * The Go binary is the exact attested candidate. This separate hidden Electron
 * entry joins production constructors from that same clean source tree with
 * explicit controlled translations/profile. It does not execute normal main/UI
 * or qualify production ChatGPT controls, accounts, selectors or live acceptance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { sourceSnapshot } from "../../tooling/source-identity.mjs";
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
import {
  compilerProblems,
  dependencyDrift,
  readDependencyDigests,
  toolchainPackageRoots,
  packageRootOf,
} from "../../tooling/dependency-digests.mjs";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { ELECTRON_RUNTIME } from "../../tooling/runtime-contract.mjs";
import { DECLARED_NODE_VERSIONS } from "../../tooling/dev.mjs";

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), "../..");
const require = createRequire(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputContract = {
  schema: "farol-go-chat-normal-harness-inputs/1",
  owned: [
    "tests/e2e/go-chat-normal.e2e.mjs",
    "tests/e2e/go-chat-normal.e2e.entry.ts",
  ],
  candidate:
    "Clean attested schema-4 build artifact with core, build/input manifests and exact committed source; independent --source-sha and --build-id pins",
  constructors: [
    "createDesktopChatBrowser",
    "GoChatBrowserDriver",
    "ChatGptRoute.chatPhysical",
    "startDesktopGoCore",
  ],
  fixture:
    "tests/e2e/fixtures/chatgpt-controlled-site.mjs plus its controlled-client.mjs",
  requiredJoinSeams: [
    "ChatGptRoute hidden windowPresentation, message-anchors-v1 opt-in and farol-controlled-settled-segments-v1 physicalContentProfile",
    "GoChatBrowserDriver trusted e2eOrigin for exact HTTP 127.0.0.1 fixture origin; HTTPS-only binding validation is a blocker, never rewritten",
  ],
  nativeAuthority:
    "Explicit --run-native; caller must hold the exclusive native lane",
  normalScenario:
    "create -> prepare home -> one Send -> useful delta before terminal release -> retained result -> result/frame ACK -> physical quiescence -> same-CID follow-up -> second result",
  faultScenario:
    "Fresh fixture/profile/child; actual loseNextSendAcknowledgement seam -> one accepted physical POST -> non-ok duplicate Send -> unchanged independent ledger through exact child terminal",
  limits: [
    "Production-constructor composition, not normal main/UI acceptance",
    "Controlled provider/site/profile/selection, not live ChatGPT qualification",
    "No installed app, owner profile, credentials, auth state, old operations or adapter doubles",
  ],
};
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--contract") {
  process.stdout.write(`${JSON.stringify(inputContract, null, 2)}\n`);
} else {
  await main(args);
}

async function bounded(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function parse(args) {
  let mode = "--check";
  if (["--check", "--build-only", "--run-native"].includes(args[0]))
    mode = args.shift();
  const values = {};
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    assert.ok(
      ["--candidate-root", "--source-sha", "--build-id"].includes(key) &&
        value &&
        !Object.hasOwn(values, key),
      "HARNESS_ARGUMENT_INVALID: use --contract for required inputs",
    );
    values[key] = value;
  }
  assert.ok(
    path.isAbsolute(values["--candidate-root"] ?? ""),
    "CANDIDATE_ROOT_REQUIRED",
  );
  assert.match(
    values["--source-sha"] ?? "",
    /^[a-f0-9]{40}$/u,
    "SOURCE_PIN_REQUIRED",
  );
  assert.match(
    values["--build-id"] ?? "",
    /^[a-f0-9]{64}$/u,
    "BUILD_PIN_REQUIRED",
  );
  return {
    mode,
    artifactRoot: values["--candidate-root"],
    sourceSHA: values["--source-sha"],
    buildId: values["--build-id"],
  };
}
async function json(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function regular(file) {
  const stat = await fs.lstat(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    `INPUT_NOT_REGULAR:${file}`,
  );
  return fs.readFile(file);
}
async function candidate(selection) {
  assert.equal(
    await fs.realpath(selection.artifactRoot),
    selection.artifactRoot,
    "CANDIDATE_PATH_REDIRECTED",
  );
  const manifest = await json(
    path.join(selection.artifactRoot, "build-manifest.json"),
  );
  const identity = assertBuildIdentity(
    await json(path.join(selection.artifactRoot, "build-identity.json")),
  );
  assert.equal(manifest.schema, 4);
  assert.equal(manifest.dirty, false);
  assert.equal(manifest.inputExact, true);
  assert.equal(manifest.sourceMode, "head-exact");
  assert.equal(identity.sourceDirty, false);
  assert.equal(identity.sourceCommit, selection.sourceSHA);
  assert.equal(identity.buildId, selection.buildId);
  assert.equal(manifest.sourceCommit, identity.sourceCommit);
  assert.equal(manifest.sourceTreeDigest, identity.sourceTreeDigest);
  assert.equal(manifest.buildId, identity.buildId);
  assert.deepEqual(
    manifest.entries,
    [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
  );
  await verifyBuildEntries(
    selection.artifactRoot,
    manifest.entrySha256,
    manifest.entries,
  );
  await verifyInputManifest(selection.artifactRoot, manifest);
  await verifyGoCoreArtifact(selection.artifactRoot, manifest.core, identity);
  const snapshot = sourceSnapshot(root);
  assert.equal(
    snapshot.dirty,
    false,
    "HARNESS_REQUIRES_CLEAN_COMMITTED_SOURCE",
  );
  assert.equal(
    snapshot.commit,
    selection.sourceSHA,
    "HARNESS_SOURCE_PIN_MISMATCH",
  );
  assert.equal(snapshot.treeDigest, identity.sourceTreeDigest);
  for (const file of inputContract.owned)
    assert.ok(snapshot.entries.has(file), `HARNESS_NOT_COMMITTED:${file}`);
  // These declarations come from the independently pinned production manifest.
  // They are never synthesized from a newly measured executable digest.
  return { identity, core: manifest.core, snapshot, manifest };
}
async function compile(inputs, bundle, report) {
  assert.ok(
    DECLARED_NODE_VERSIONS.includes(process.versions.node),
    "DECLARED_NODE_REQUIRED",
  );
  assert.ok(
    !process.env.NODE_OPTIONS &&
      !process.env.NODE_PATH &&
      !process.env.ESBUILD_BINARY_PATH,
    "COMPILER_STARTUP_OVERRIDE_FORBIDDEN",
  );
  assert.equal(process.execArgv.length, 0, "NODE_STARTUP_ARGUMENT_FORBIDDEN");
  assert.deepEqual(compilerProblems(root), [], "COMPILER_NOT_ATTESTED");
  const { build } = await import("esbuild");
  const packages = new Set(toolchainPackageRoots());
  const records = [];
  const built = await build({
    absWorkingDir: root,
    entryPoints: [inputContract.owned[1]],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "original-fs"],
    metafile: true,
    write: false,
    logLevel: "silent",
    define: {
      __FAROL_NORMAL_CORE__: JSON.stringify(inputs.core),
      __FAROL_NORMAL_BUILD__: JSON.stringify(inputs.identity),
    },
    plugins: [
      {
        name: "exact-candidate-composition-inputs",
        setup(context) {
          context.onLoad(
            { filter: /\.(?:[cm]?[jt]sx?|json)$/ },
            async ({ path: file }) => {
              const relative = path
                .relative(root, file)
                .split(path.sep)
                .join("/");
              assert.ok(
                !path.isAbsolute(relative) && !relative.startsWith("../"),
                "HARNESS_INPUT_ESCAPES_SOURCE",
              );
              const bytes = await regular(file);
              if (relative.startsWith("node_modules/"))
                packages.add(packageRootOf(relative));
              else {
                const expected = inputs.snapshot.entries.get(relative);
                assert.ok(
                  expected?.bytes?.equals(bytes),
                  `HARNESS_SOURCE_NOT_EXACT:${relative}`,
                );
              }
              records.push({ path: relative, sha256: hash(bytes) });
              const extension = path.extname(file).slice(1);
              const loader = ["mjs", "cjs"].includes(extension)
                ? "js"
                : ["mts", "cts"].includes(extension)
                  ? "ts"
                  : extension;
              return {
                contents: bytes,
                loader,
                resolveDir: path.dirname(file),
              };
            },
          );
        },
      },
    ],
  });
  assert.deepEqual(
    dependencyDrift(root, [...packages], readDependencyDigests(root)),
    [],
    "HARNESS_DEPENDENCIES_NOT_ATTESTED",
  );
  const after = sourceSnapshot(root);
  assert.equal(after.dirty, false);
  assert.equal(after.commit, inputs.snapshot.commit);
  assert.equal(after.treeDigest, inputs.snapshot.treeDigest);
  assert.equal(built.outputFiles.length, 1);
  await fs.writeFile(bundle, built.outputFiles[0].contents, {
    flag: "wx",
    mode: 0o600,
  });
  report.bundle = {
    sha256: hash(built.outputFiles[0].contents),
    inputs: records.sort((a, b) => a.path.localeCompare(b.path)),
    inputCount: Object.keys(built.metafile.inputs).length,
    compiledCore: inputs.core,
    buildId: inputs.identity.buildId,
  };
}

async function main(args) {
  const selection = parse([...args]);
  const output = path.join(root, "_output");
  await fs.mkdir(path.join(output, "evidence"), { recursive: true });
  await fs.mkdir(path.join(output, "tmp"), { recursive: true });
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(output, "tmp", "go-chat-normal-")),
  );
  await fs.chmod(temporary, 0o700);
  const reportPath = path.join(
    output,
    "evidence",
    `${path.basename(temporary)}.json`,
  );
  const report = {
    inputContract,
    selection,
    status: "checking",
    temporary,
    startedAt: new Date().toISOString(),
    scenarios: [],
    cleanup: { temporaryRemoved: false },
    error: null,
  };
  const save = async () => {
    await fs.writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    await fs.rename(`${reportPath}.tmp`, reportPath);
  };
  let aborted = null;
  const onInt = () => {
    aborted ??= "CANCELLED_SIGINT";
  };
  const onTerm = () => {
    aborted ??= "CANCELLED_SIGTERM";
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const active = () => {
    if (aborted) throw new Error(aborted);
  };
  try {
    const inputs = await candidate(selection);
    report.attestation = {
      sourceSHA: inputs.identity.sourceCommit,
      buildId: inputs.identity.buildId,
      treeDigest: inputs.identity.sourceTreeDigest,
      manifestSha256: hash(
        await regular(path.join(selection.artifactRoot, "build-manifest.json")),
      ),
    };
    if (selection.mode === "--check") report.status = "checked-native-not-run";
    else {
      const bundle = path.join(temporary, "join.cjs");
      await compile(inputs, bundle, report);
      report.status = "build-only-native-not-run";
      if (selection.mode === "--run-native") {
        assert.equal(process.platform, "darwin");
        assert.equal(process.arch, "arm64");
        active();
        const executable = require("electron");
        assert.equal(
          require("electron/package.json").version,
          ELECTRON_RUNTIME.version,
        );
        assert.equal(
          await treeDigest(
            path.join(
              path.dirname(require.resolve("electron")),
              "dist/Electron.app",
            ),
          ),
          ELECTRON_RUNTIME.extractedTreeDigest,
        );
        report.runtime = {
          electron: ELECTRON_RUNTIME.version,
          executableSha256: hash(await regular(executable)),
          treeDigest: ELECTRON_RUNTIME.extractedTreeDigest,
        };
        // Fixture/client must also be exact tracked source, even though they are
        // not bundled into the child. No moving cross-writer source is loaded.
        for (const name of [
          "chatgpt-controlled-site.mjs",
          "chatgpt-controlled-client.mjs",
        ]) {
          const relative = `tests/e2e/fixtures/${name}`;
          assert.ok(
            inputs.snapshot.entries
              .get(relative)
              ?.bytes?.equals(await regular(path.join(root, relative))),
            `FIXTURE_NOT_EXACT:${name}`,
          );
        }
        const { startControlledChatGptSite } =
          await import("./fixtures/chatgpt-controlled-site.mjs");
        const { _electron } = await import("playwright-core");
        for (const fault of [false, true]) {
          active();
          await nativeScenario({
            fault,
            temporary,
            bundle,
            selection,
            executable,
            _electron,
            startControlledChatGptSite,
            report,
            reportPath,
            save,
            active,
          });
        }
        // Re-check immutable candidate and source after both child lifetimes.
        await candidate(selection);
        report.status = "passed-controlled-composition";
      }
    }
  } catch (error) {
    report.status = "failed";
    report.error = String(error?.stack ?? error);
  } finally {
    // Failed evidence, profiles, logs and journals are always retained. Success
    // removes disposable state only after all exact-child cleanup gates passed.
    if (report.status !== "failed") {
      try {
        await fs.rm(temporary, { recursive: true, force: true });
        report.cleanup.temporaryRemoved = true;
      } catch (error) {
        report.status = "failed";
        report.cleanup.error = String(error);
      }
    }
    report.finishedAt = new Date().toISOString();
    await save();
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    process.stdout.write(`${report.status}: ${reportPath}\n`);
    process.exitCode = report.status === "failed" ? 1 : 0;
  }
}

async function nativeScenario({
  fault,
  temporary,
  bundle,
  selection,
  executable,
  _electron,
  startControlledChatGptSite,
  report,
  reportPath,
  save,
  active,
}) {
  const name = fault
    ? "fresh-provider-http-lost-ack-no-duplicate"
    : "home-stream-result-ack-quiescence-same-cid-follow";
  const row = { name, status: "running", cleanup: {}, observations: [] };
  report.scenarios.push(row);
  await save();
  const owned = path.join(temporary, fault ? "lost-ack" : "normal");
  await fs.mkdir(owned, { mode: 0o700 });
  const paths = Object.fromEntries(
    [
      "home",
      "appData",
      "userData",
      "sessionData",
      "temp",
      "logs",
      "crashDumps",
    ].map((key) => [key, path.join(owned, key)]),
  );
  await Promise.all(
    Object.values(paths).map((directory) =>
      fs.mkdir(directory, { mode: 0o700 }),
    ),
  );
  const stateRoot = path.join(owned, "profile-settings");
  await fs.mkdir(stateRoot, { mode: 0o700 });
  const turns = [
    {
      userId: "user-first",
      replyId: "reply-first",
      prompt: "Return controlled useful text.",
      segments: [
        { id: "first-prefix", text: "Useful incremental text" },
        { id: "first-final", text: "Final controlled text" },
      ],
    },
    {
      userId: "user-follow",
      replyId: "reply-follow",
      prompt: "Continue this controlled conversation.",
      segments: [
        { id: "follow-prefix", text: "Useful follow up text" },
        { id: "follow-final", text: "Final follow up text" },
      ],
    },
  ].slice(0, fault ? 1 : 2);
  let site, application, child, exited;
  const receipt = reportPath.replace(
    /\.json$/u,
    `.${fault ? "lost-ack" : "normal"}.native.json`,
  );
  try {
    site = await startControlledChatGptSite({
      conversationId: fault ? "controlled-lost-ack" : "controlled-normal",
      selection: { model: "Test model", effort: "Light", connector: null },
      turns,
    });
    const configFile = path.join(owned, "config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        paths,
        stateRoot,
        artifactRoot: selection.artifactRoot,
        receipt,
        origin: site.origin,
        homeUrl: site.url,
      }),
      { flag: "wx", mode: 0o600 },
    );
    row.cleanup.launchAttempted = true;
    await save();
    // Preserve the exact ChildProcess handle before acting on cancellation.
    application = await _electron.launch({
      executablePath: executable,
      args: [bundle, configFile],
      artifactsDir: path.join(owned, "playwright-artifacts"),
      chromiumSandbox: true,
      cwd: owned,
      timeout: 15_000,
      env: {
        HOME: paths.home,
        TMPDIR: paths.temp,
        TMP: paths.temp,
        TEMP: paths.temp,
        XDG_CONFIG_HOME: paths.appData,
        XDG_CACHE_HOME: paths.sessionData,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
    });
    child = application.process();
    row.cleanup.pid = child.pid;
    exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    });
    const callRaw = (command) =>
      bounded(
        application.evaluate(
          (_electron, input) => globalThis.goChatNormal(input),
          command,
        ),
        18_000,
        "JOIN_COMMAND_TIMEOUT_NO_REPLAY",
      );
    const call = async (command) => {
      active();
      const result = await callRaw(command);
      assert.ok(!result?.harnessError, result?.harnessError ?? "JOIN_FAILURE");
      return result;
    };
    const wait = async (read, predicate, label) => {
      const end = Date.now() + 12_000;
      while (Date.now() < end) {
        active();
        const value = await read();
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(label);
    };
    await call({ kind: "start" });
    const first = await call({ kind: "create", prompt: turns[0].prompt });
    assert.equal((await call({ kind: "snapshot" })).routeCount, 0);
    const prepared = await call({ kind: "prepare" });
    assert.equal(prepared.handle.handleId, first.handleId);
    assert.equal(prepared.providerState, "home");
    assert.equal(prepared.conversationId, "");
    if (fault) {
      assert.equal(
        typeof site.driver.loseNextSendAcknowledgement,
        "function",
        "REAL_LOST_ACK_SEAM_REQUIRED",
      );
      site.driver.loseNextSendAcknowledgement();
      // Physical click acknowledgement may precede HTTP failure. This scenario
      // claims a lost provider HTTP ACK only, never a lost Go/RPC acknowledgement.
      row.sendOutcome = await callRaw({
        kind: "send",
        handleId: first.handleId,
      });
      await wait(
        async () => site.driver.snapshot(),
        (value) =>
          value.acceptedSends === 1 &&
          value.ledger[0]?.acknowledgement === "lost",
        "LOST_ACK_NOT_OBSERVED",
      );
      const duplicate = await callRaw({
        kind: "send",
        handleId: first.handleId,
      });
      assert.ok(duplicate?.harnessError, "DUPLICATE_SEND_RETURNED_OK");
      // Ingress can conservatively classify this response as unknown. Record
      // it verbatim; the independent POST ledger proves no physical duplicate.
      row.duplicateOutcome = duplicate;
      // Read the existing frame journal without probing or recovering uncertain
      // provider work. The fresh fault scenario never issues another Send.
      await call({
        kind: "events",
        handleId: first.handleId,
        afterSequence: "0",
      });
      await call({ kind: "snapshot" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(site.driver.snapshot().attemptedSends, 1);
      assert.equal(site.driver.snapshot().acceptedSends, 1);
    } else {
      const finishTurn = async (handle, turn, count) => {
        await call({ kind: "send", handleId: handle.handleId });
        await wait(
          async () => site.driver.snapshot(),
          (value) => value.acceptedSends === count,
          "PHYSICAL_SUBMISSION_NOT_OBSERVED",
        );
        assert.equal(site.driver.snapshot().attemptedSends, count);
        site.driver.releaseGeneration(turn.replyId, 1);
        site.driver.releaseRender(turn.replyId, 1);
        const frames = await wait(
          async () => {
            await call({ kind: "observe", handleId: handle.handleId });
            return call({
              kind: "events",
              handleId: handle.handleId,
              afterSequence: "0",
            });
          },
          (value) =>
            value.frames.some(
              (frame) =>
                frame.kind === "response.output_text.delta" &&
                JSON.stringify(frame.data).includes(turn.segments[0].text),
            ),
          "USEFUL_DELTA_NOT_OBSERVED_BEFORE_TERMINAL",
        );
        assert.ok(
          frames.frames.every((frame) => frame.kind !== "response.completed"),
        );
        assert.equal(
          site.driver.snapshot().turns[count - 1].providerTerminal,
          false,
        );
        row.observations.push({
          handleId: handle.handleId,
          usefulBeforeTerminal: true,
          frames,
        });
        await save();
        site.driver.releaseGeneration(turn.replyId, 2);
        site.driver.releaseRender(turn.replyId, 2);
        site.driver.releaseTerminal(turn.replyId);
        await wait(
          async () => {
            await call({ kind: "observe", handleId: handle.handleId });
            return call({
              kind: "events",
              handleId: handle.handleId,
              afterSequence: "0",
            });
          },
          (value) =>
            value.frames.some((frame) => frame.kind === "response.completed"),
          "RETAINED_RESULT_NOT_COMPLETE",
        );
        const result = await call({
          kind: "result",
          handleId: handle.handleId,
        });
        assert.equal(result.complete, true);
        assert.equal(result.userTurnId, turn.userId);
        assert.equal(result.replyId, turn.replyId);
        assert.equal(result.conversationId, "controlled-normal");
        assert.equal(
          result.text,
          turn.segments.map((segment) => segment.text).join("\n\n"),
        );
        assert.equal(result.acknowledged, false);
        assert.equal(result.evidence.observationSource, "field-facts");
        assert.equal(result.evidence.observed.model.source, "public-control");
        assert.equal(result.evidence.observed.model.value, "controlled-model");
        assert.equal(result.evidence.observed.effort.value, "low");
        assert.deepEqual(
          await call({ kind: "result", handleId: handle.handleId }),
          result,
        );
        const retainedFrames = await call({
          kind: "events",
          handleId: handle.handleId,
          afterSequence: "0",
        });
        assert.ok(
          retainedFrames.frames.some(
            (frame) => frame.kind === "response.completed",
          ),
        );
        for (const frame of retainedFrames.frames)
          await call({
            kind: "frame-ack",
            handleId: handle.handleId,
            sequence: frame.sequence,
          });
        await call({
          kind: "result-ack",
          handleId: handle.handleId,
          resultId: result.resultId,
        });
        assert.equal(
          (await call({ kind: "result", handleId: handle.handleId }))
            .acknowledged,
          true,
        );
        await wait(
          async () => {
            await call({ kind: "observe", handleId: handle.handleId });
            return call({ kind: "snapshot" });
          },
          (value) =>
            value.observations.some(
              (event) =>
                event.operationId === handle.binding.operationId &&
                event.kind === "quiescent",
            ),
          "PHYSICAL_QUIESCENCE_NOT_OBSERVED",
        );
        assert.equal(site.driver.snapshot().attemptedSends, count);
        row.observations.push({
          handleId: handle.handleId,
          result,
          retainedFrames,
          quiescenceObserved: true,
        });
        return result;
      };
      const firstResult = await finishTurn(first, turns[0], 1);
      const second = await call({
        kind: "create",
        prompt: turns[1].prompt,
        previousHandle: first.handleId,
      });
      assert.equal(second.binding.taskId, first.binding.taskId);
      assert.notEqual(second.binding.turnId, first.binding.turnId);
      assert.equal(second.binding.turnGeneration, "2");
      const again = await call({ kind: "prepare" });
      assert.equal(again.handle.handleId, second.handleId);
      assert.equal(again.providerState, "bound");
      assert.equal(again.conversationId, firstResult.conversationId);
      const secondResult = await finishTurn(second, turns[1], 2);
      assert.equal(secondResult.conversationId, firstResult.conversationId);
      await call({ kind: "result", handleId: first.handleId });
      assert.equal(site.driver.snapshot().attemptedSends, 2);
      row.sameCID = secondResult.conversationId;
    }
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.error = String(error?.stack ?? error);
    throw error;
  } finally {
    if (site) row.ledger = site.driver.snapshot();
    if (application) {
      try {
        const closed = await bounded(
          application.evaluate(() =>
            globalThis.goChatNormal({ kind: "close" }),
          ),
          5000,
          "HOST_CLOSE_UNKNOWN",
        );
        assert.equal(
          closed.hostCloseResolved,
          true,
          closed.harnessError ?? "GO_CHILD_TERMINAL_UNCONFIRMED",
        );
        assert.equal(closed.windowsDestroyed, true);
        row.cleanup.hostCloseResolved = true;
        row.cleanup.windowsDestroyed = true;
      } catch (error) {
        row.status = "failed";
        row.cleanup.hostError = String(error);
      }
      try {
        await bounded(application.close(), 5000, "ELECTRON_CLOSE_TIMEOUT");
        await bounded(exited, 3000, "ELECTRON_TERMINAL_TIMEOUT");
      } catch (error) {
        row.status = "failed";
        row.cleanup.electronError = String(error);
        // Exact owned handle only; no PID lookup/name/global process sweep.
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        try {
          await bounded(exited, 3000, "EXACT_CHILD_KILL_TIMEOUT");
        } catch (failure) {
          row.cleanup.killError = String(failure);
        }
      }
      row.cleanup.exitObserved =
        child.exitCode !== null || child.signalCode !== null;
      row.cleanup.exitCode = child.exitCode;
      row.cleanup.signal = child.signalCode;
      row.nativeReceipt = receipt;
      try {
        const native = await json(receipt);
        assert.equal(native.error, null);
        assert.equal(native.cleanup.windowsDestroyed, true);
        row.native = native;
      } catch (error) {
        row.status = "failed";
        row.cleanup.receiptError = String(error);
      }
    } else if (row.cleanup.launchAttempted) {
      row.cleanup.launchCleanup =
        "Playwright-owned failure cleanup; exact child terminal not independently observed";
    }
    if (site) {
      row.ledger = site.driver.snapshot();
      if (row.status === "passed") {
        const expected = fault ? 1 : 2;
        if (
          row.ledger.attemptedSends !== expected ||
          row.ledger.acceptedSends !== expected
        ) {
          row.status = "failed";
          row.cleanup.ledgerError =
            "PHYSICAL_DUPLICATE_OR_MISSING_SUBMISSION_AT_TERMINAL";
        }
      }
      try {
        await bounded(site.close(), 3000, "OWNED_SITE_CLOSE_TIMEOUT");
        row.cleanup.siteClosed = true;
      } catch (error) {
        row.status = "failed";
        row.cleanup.siteError = String(error);
      }
    }
    await save();
    if (
      row.status !== "passed" ||
      !row.cleanup.exitObserved ||
      !row.cleanup.hostCloseResolved ||
      !row.cleanup.windowsDestroyed ||
      !row.cleanup.siteClosed
    )
      throw new Error(`SCENARIO_FAILED_OR_CLEANUP_UNKNOWN:${name}`);
  }
}

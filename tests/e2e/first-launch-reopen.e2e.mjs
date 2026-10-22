// Exact packaged bytes, one fresh signed-out profile, two hidden lifetimes.
// No installed profile, provider call, authentication, recovery or retry seam.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright-core";
import { desktopIdentity } from "../../tooling/harness-identity.ts";
import { parseQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import { parseFirstLaunchOperations } from "./lib/first-launch-operations.mjs";
import {
  candidatePaths,
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "../../tooling/candidate-contract.mjs";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  refreshNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";
import { readNativePreviewEcho } from "./lib/native-preview-echo.mjs";
import { waitForReactShell } from "./current-react-setup.mjs";

assert.deepEqual(process.argv.slice(2), []);
assert.equal(process.platform, "darwin");
const root = path.resolve(import.meta.dirname, "../..");
const { appPath, artifactFile } = candidatePaths(root);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
assertCanonicalArtifactPath(root, artifact);
const build = assertBuildIdentity(
  JSON.parse(
    await fs.readFile(
      path.join(appPath, "Contents/Resources/app/build-identity.json"),
      "utf8",
    ),
  ),
);
assert.equal(artifact.schema, 7);
assertExactSourceIdentity(sourceIdentity(root), build);
assertExactSourceIdentity(sourceIdentity(root), artifact);
assert.equal(artifact.buildId, build.buildId);
assert.equal(await treeDigest(appPath), artifact.artifactSha256);
const runId = randomUUID();
const destination = path.join(
  root,
  "_output/evidence/first-launch-reopen",
  `${runId}.json`,
);
const profileRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
);
await fs.chmod(profileRoot, 0o700);
const proof = randomUUID();
await fs.writeFile(path.join(profileRoot, ".farol-e2e-root"), proof, {
  mode: 0o600,
  flag: "wx",
});
const appData = path.join(profileRoot, "app-data");
const identity = desktopIdentity("preview", appData);
await fs.mkdir(appData, { mode: 0o700 });
await fs.mkdir(identity.userData, { mode: 0o700 });
const report = {
  schema: "farol.first-launch-reopen/1",
  runId,
  build,
  artifactSha256: artifact.artifactSha256,
  profileRoot,
  limits: [
    "Signed-out loopback fixture; no provider/account or installed acceptance",
    "All native windows hidden; no visible/focus claim",
  ],
  lifetimes: [],
  status: "running",
};
function bounded(promise, code, milliseconds = 30000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    "<!doctype html><title>Signed out fixture</title><p>Signed out</p>",
  );
});
await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const options = {
  executablePath: path.join(
    appPath,
    "Contents/MacOS",
    identity.applicationName,
  ),
  args: ["--preview-window-mode=hidden"],
  timeout: 15000,
  env: {
    HOME: profileRoot,
    TMPDIR: await fs.realpath(os.tmpdir()),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    FAROL_E2E: "1",
    FAROL_E2E_APP_DATA: appData,
    FAROL_E2E_TEST_ROOT: profileRoot,
    FAROL_E2E_TEST_PROOF: proof,
    FAROL_E2E_CHATGPT_URL: `http://127.0.0.1:${fixture.address().port}/`,
  },
};
let witness, application, current, failure;
async function quit() {
  assert.equal(current.quitAttempted, false);
  witness = await bounded(
    refreshNativePreviewIsolation(witness, application),
    "FIRST_LAUNCH_PRE_QUIT_ISOLATION_TIMEOUT",
  );
  current.preQuitRelayObserved = witness.relayObserved;
  assert.equal(witness.relayObserved, true, "FIRST_LAUNCH_RELAY_NOT_OBSERVED");
  const relay = await fs.lstat(witness.relayRoot);
  current.relayBeforeQuit = {
    dev: relay.dev,
    ino: relay.ino,
    mode: relay.mode,
    uid: relay.uid,
  };
  const child = application.process();
  const requestedAt = Date.now();
  current.quitAttempted = true;
  current.quitDispatch = "pending";
  const request = application
    .evaluate(({ app }) => {
      app.quit();
    })
    .then(
      () => {
        current.quitDispatch = "returned";
      },
      () => {
        current.quitDispatch = "transport-ended-or-rejected";
      },
    );
  await bounded(current.terminal, "FIRST_LAUNCH_QUIT_UNKNOWN", 60000);
  await bounded(current.closed, "FIRST_LAUNCH_STREAM_CLOSE_UNKNOWN", 5000);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.ok(
    current.lifecycle.some(
      (entry) =>
        entry.event === "will-quit" &&
        entry.pid === child.pid &&
        entry.visibilityViolations === 0,
    ),
    "FIRST_LAUNCH_HIDDEN_LIFETIME_UNCONFIRMED",
  );
  const state = path.join(identity.userData, "farol-state");
  const parsed = parseQuitReceipt(
    await fs.readFile(path.join(state, "last-quit.json"), "utf8"),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.receipt.drained, true);
  assert.deepEqual(parsed.receipt.unconfirmed, []);
  assert.ok(Date.parse(parsed.receipt.at) >= requestedAt);
  await assert.rejects(fs.lstat(path.join(state, "running.json")), {
    code: "ENOENT",
  });
  current.quit = parsed.receipt;
  const afterRelay = await fs.lstat(witness.relayRoot);
  current.relayAfterQuit = {
    dev: afterRelay.dev,
    ino: afterRelay.ino,
    mode: afterRelay.mode,
    uid: afterRelay.uid,
  };
  assert.deepEqual(current.relayAfterQuit, current.relayBeforeQuit);
  current.relayEntriesAfterQuit = await fs.readdir(witness.relayRoot);
  assert.deepEqual(current.relayEntriesAfterQuit, []);
  current.exit = { code: child.exitCode, signal: child.signalCode };
  // Preserve the same original endpoint until its final metadata recheck.
  witness = await recheckNativePreviewIsolation(witness, current.actual, child);
  await bounded(application.close(), "FIRST_LAUNCH_DRIVER_CLOSE_UNKNOWN", 5000);
  await bounded(request, "FIRST_LAUNCH_QUIT_DISPATCH_UNKNOWN", 5000);
  application = undefined;
  current.status = "passed";
}
try {
  for (const ordinal of [1, 2]) {
    current = { ordinal, quitAttempted: false, status: "running" };
    report.lifetimes.push(current);
    const admission = await assertNativePreviewAdmission(undefined, {
      profileRoot,
      proof,
      launchOptions: options,
      fixture,
      ...(witness ? { previous: witness } : {}),
    });
    current.admission = admission;
    const pending = electron.launch(options).then((value) => {
      application = value;
      const child = value.process();
      current.pid = child.pid;
      current.terminal = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      current.closed = new Promise((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      // Retain only classified lifecycle diagnostics, never app/profile bytes.
      current.lifecycle = [];
      let buffer = "";
      child.stderr?.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop().slice(-16384);
        for (const line of lines) {
          if (line.startsWith("FAROL_FIRST_LAUNCH_QUIT:"))
            current.lifecycle.push(
              JSON.parse(line.slice("FAROL_FIRST_LAUNCH_QUIT:".length)),
            );
        }
      });
      return value;
    });
    await bounded(pending, "FIRST_LAUNCH_DISPATCH_UNKNOWN", 20000);
    const { page, actual } = await bounded(
      readNativePreviewEcho(application),
      "FIRST_LAUNCH_ECHO_UNKNOWN",
    );
    current.actual = actual;
    witness = await recheckNativePreviewIsolation(
      admission,
      actual,
      application.process(),
    );
    assert.equal(actual.userData, identity.userData);
    assert.equal(actual.isPackaged, true);
    await application.evaluate(({ app, BrowserWindow }) => {
      globalThis.__farolFirstLaunchVisibilityViolations = [];
      const watch = (window) => {
        for (const event of ["show", "focus"])
          window.on(event, () =>
            globalThis.__farolFirstLaunchVisibilityViolations.push(event),
          );
      };
      BrowserWindow.getAllWindows().forEach(watch);
      app.on("browser-window-created", (_event, window) => watch(window));
      app.once("will-quit", () =>
        process.stderr.write(
          "FAROL_FIRST_LAUNCH_QUIT:" +
            JSON.stringify({
              event: "will-quit",
              pid: process.pid,
              visibilityViolations:
                globalThis.__farolFirstLaunchVisibilityViolations.length,
            }) +
            "\n",
        ),
      );
    });
    await bounded(waitForReactShell(page), "FIRST_LAUNCH_RENDERER_TIMEOUT");
    await page
      .getByRole("heading", { name: "Welcome to Farol", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Start setup", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(
      await page
        .getByRole("heading", {
          name: "Your previous session needs recovery",
          exact: true,
        })
        .count(),
      0,
    );
    const readyDeadline = Date.now() + 30000;
    for (;;) {
      const state = await bounded(
        page.evaluate(
          async () => (await window.farol.bootstrap()).runtimeState,
        ),
        "FIRST_LAUNCH_RUNTIME_READY_TIMEOUT",
        Math.max(1, readyDeadline - Date.now()),
      );
      if (state === "ready") break;
      if (Date.now() >= readyDeadline)
        throw Error("FIRST_LAUNCH_RUNTIME_READY_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const deadline = Date.now() + 30000;
    for (;;) {
      const stage = await fs
        .readFile(path.join(profileRoot, ".farol-startup-stage"), "utf8")
        .catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      if (stage.trim() === "startup-complete") break;
      if (Date.now() >= deadline)
        throw Error("FIRST_LAUNCH_STARTUP_COMPLETE_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    current.marker = await readOwnedStartupMarker(
      path.join(identity.userData, "farol-state"),
      profileRoot,
      current.pid,
    );
    const operations = parseFirstLaunchOperations(
      await bounded(
        page.evaluate(() => window.farol.operations()),
        "FIRST_LAUNCH_OPERATIONS_TIMEOUT",
      ),
    );
    current.operationDiagnostics = {
      writeFailures: operations.writeFailures,
      corruptLines: operations.corruptLines,
      unrecordedUncertainEntries: operations.unrecordedUncertainEntries,
    };
    assert.equal(operations.writeFailures, 0);
    assert.equal(operations.corruptLines, 0);
    assert.equal(operations.unrecordedUncertainEntries, 0);
    current.unresolvedOperations = operations.entries
      .filter(
        (entry) => entry.outcome === "unknown" || entry.outcome === "pending",
      )
      .map(({ id, kind, outcome, code }) => ({ id, kind, outcome, code }));
    assert.deepEqual(
      current.unresolvedOperations,
      [],
      "FIRST_LAUNCH_UNRESOLVED_OPERATIONS",
    );
    await page
      .getByRole("button", { name: "Unresolved actions", exact: true })
      .waitFor({ state: "hidden" });
    current.startup = {
      destination: "setup",
      welcome: "Welcome to Farol",
      action: "Start setup",
      recovery: false,
    };
    current.screenshot = path.join(
      path.dirname(destination),
      `${runId}-${ordinal}-welcome.png`,
    );
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await page.screenshot({ path: current.screenshot });
    await quit();
  }
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.failure = {
    code: error.message.split("\n")[0],
    cause: error.cause?.message,
  };
  if (application && !current.quitAttempted) {
    // One teardown of the exact original process after an assertion/admission
    // failure. It cannot turn that failed witness into reopen authorization.
    current.quitAttempted = true;
    try {
      const child = application.process();
      await bounded(
        application.close(),
        "FIRST_LAUNCH_FAILURE_CLOSE_UNKNOWN",
        60000,
      );
      await bounded(
        current.terminal,
        "FIRST_LAUNCH_FAILURE_EXIT_UNKNOWN",
        5000,
      );
      await bounded(
        current.closed,
        "FIRST_LAUNCH_FAILURE_STREAM_CLOSE_UNKNOWN",
        5000,
      );
      report.failureCleanup = {
        exit: child.exitCode,
        signal: child.signalCode,
      };
      application = undefined;
    } catch (cleanup) {
      report.cleanupFailure = { code: cleanup.message };
    }
  }
} finally {
  // Unknown launches/quits retain their exact roots and are never signalled again.
  if (!application) {
    await new Promise((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
    report.cleanup =
      "original processes and driver closed; disposable profile retained for evidence";
  } else {
    fixture.unref();
    report.cleanup = "original lifetime/profile retained; cleanup unconfirmed";
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    destination,
    JSON.stringify(
      report,
      (_key, value) => (value instanceof Promise ? undefined : value),
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ status: report.status, receipt: destination }));
}
if (failure) throw failure;

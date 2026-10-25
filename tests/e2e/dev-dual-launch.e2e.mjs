// Same ordinary Dev image, one disposable signed-out profile, two hidden
// lifetimes. Saved Dev is observed only; this never applies real Recovery,
// copies auth, sends provider work, or claims fixture evidence as saved PASS.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { _electron as electron } from "playwright-core";
import {
  devGoBuildArguments,
  devLaunchEnvironment,
  devLaunchProfile,
} from "../../tooling/dev.mjs";
import { prepareDevBuild } from "../../tooling/dev-process-control.mjs";
import {
  prepareDevCoreResources,
  readPreparedDevCore,
} from "../../tooling/dev-core-resources.mjs";
import { desktopIdentity } from "../../tooling/harness-identity.ts";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { readRunMarker } from "../../src/apps/desktop/run-marker.ts";
import { parseQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import {
  readQuitObservation,
  beginQuitObservation,
  assertFreshQuit,
} from "./lib/native-quit-observation.mjs";
import {
  assertNativePreviewAdmission,
  refreshNativePreviewIsolation,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";
import { readNativePreviewEcho } from "./lib/native-preview-echo.mjs";
import { waitForReactShell } from "./current-react-setup.mjs";
import {
  savedDevAdmission,
  dualLaunchWitness,
} from "./lib/dev-dual-launch-witness.mjs";

assert.deepEqual(process.argv.slice(2), []);
assert.equal(process.platform, "darwin");
const root = path.resolve(import.meta.dirname, "../..");
const source = sourceIdentity(root);
assert.equal(source.dirty, false, "DUAL_LAUNCH_SOURCE_DIRTY");
const state = path.join(devLaunchProfile(true), "farol-state");
const readOptional = (file) =>
  fs.readFile(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function protectedSnapshot() {
  const entries = [];
  for (const profile of [devLaunchProfile(false), devLaunchProfile(true)]) {
    for (const relative of [
      "config.json",
      "running.json",
      "last-quit.json",
      "go-core/chat/chat-lifecycle.json",
    ]) {
      const file = path.join(profile, "farol-state", relative);
      const bytes = await readOptional(file);
      if (bytes === null) entries.push(null);
      else {
        const info = await fs.lstat(file);
        assert.equal(info.isSymbolicLink(), false);
        entries.push({
          dev: info.dev,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          size: info.size,
          sha256: hash(bytes),
        });
      }
    }
  }
  return entries;
}
const beforeProtected = await protectedSnapshot();
const marker = await readRunMarker(state);
const oldQuit = await readOptional(path.join(state, "last-quit.json"));
const parsedQuit =
  oldQuit === null ? null : parseQuitReceipt(oldQuit.toString("utf8"));
const saved = {
  status: "NOT_RUN",
  gate: savedDevAdmission(marker, parsedQuit),
  originalMarkerStatus: marker.status,
  originalQuit: parsedQuit?.ok ? parsedQuit.receipt : null,
  reason:
    "This fixture runner never launches or recovers an owner profile; saved admission remains separate.",
};
// Same pre-build exclusion as tooling/dev.mjs. No stop or live-profile repair.
await prepareDevBuild({
  root,
  buildArguments: devGoBuildArguments([]),
  replace: false,
  profilePath: devLaunchProfile(true),
});
await prepareDevCoreResources(root);
const image = await readPreparedDevCore(root);
const id = randomUUID();
const evidence = path.join(root, "_output/evidence/dev-dual-launch", id);
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const report = {
  schema: "farol.dev-dual-launch/1",
  source,
  buildId: image.buildId,
  saved,
  fixture: { status: "running", lifetimes: [] },
  limits: [
    "Hidden disposable signed-out Dev only; no saved-profile/provider/installed acceptance",
    "Home navigation is observed separately from startup destination; no synthetic Setup PASS",
  ],
};
const save = () =>
  fs.writeFile(
    path.join(evidence, "report.json"),
    JSON.stringify(
      report,
      (_key, value) => (value instanceof Promise ? undefined : value),
      2,
    ) + "\n",
    { mode: 0o600 },
  );
await save();
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
const identity = desktopIdentity("dev", appData);
await fs.mkdir(appData, { mode: 0o700 });
await fs.mkdir(identity.userData, { mode: 0o700 });
report.fixture.profileRoot = profileRoot;
const site = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    "<!doctype html><title>Signed out fixture</title><p>Signed out</p>",
  );
});
await new Promise((resolve, reject) => {
  site.once("error", reject);
  site.listen(0, "127.0.0.1", resolve);
});
const ordinary = devLaunchEnvironment({
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
});
assert.equal(ordinary.FAROL_ENVIRONMENT, "dev");
const options = {
  executablePath: image.executable,
  args: [
    path.join(root, "_output/dev-core/Contents/Resources/app/main.cjs"),
    "--preview-window-mode=hidden",
  ],
  timeout: 15000,
  cwd: root,
  env: {
    HOME: profileRoot,
    TMPDIR: await fs.realpath(os.tmpdir()),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    FAROL_ENVIRONMENT: ordinary.FAROL_ENVIRONMENT,
    FAROL_E2E: "1",
    FAROL_E2E_APP_DATA: appData,
    FAROL_E2E_TEST_ROOT: profileRoot,
    FAROL_E2E_TEST_PROOF: proof,
    FAROL_E2E_CHATGPT_URL: `http://127.0.0.1:${site.address().port}/`,
  },
};
function bounded(promise, code, ms = 30000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function until(run, accept, code) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const result = await bounded(
      Promise.resolve().then(run),
      code,
      Math.max(1, deadline - Date.now()),
    );
    if (accept(result)) return result;
    if (Date.now() >= deadline) throw Error(code);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let application,
  current,
  witness,
  failure,
  previousProfile,
  previousBackend,
  previousConfig;
async function quitOriginal() {
  assert.equal(current.quitAttempted, false, "DUAL_LAUNCH_QUIT_REPLAY");
  witness = await bounded(
    refreshNativePreviewIsolation(witness, application),
    "DUAL_LAUNCH_QUIT_ISOLATION",
  );
  const child = application.process();
  const stateRoot = path.join(identity.userData, "farol-state");
  const before = await readQuitObservation(stateRoot);
  const request = beginQuitObservation(before, child.pid);
  current.quitAttempted = true;
  const dispatch = application
    .evaluate(({ app }) => {
      app.quit();
    })
    .then(
      () => "returned",
      () => "transport-ended-or-rejected",
    );
  const exit = await bounded(
    current.terminal,
    "DUAL_LAUNCH_QUIT_UNKNOWN",
    60000,
  );
  await bounded(current.closed, "DUAL_LAUNCH_STREAM_CLOSE_UNKNOWN", 5000);
  current.exit = { pid: child.pid, code: exit.code, signal: exit.signal };
  current.quit = assertFreshQuit(
    request,
    await readQuitObservation(stateRoot),
    current.exit,
  );
  await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
    code: "ENOENT",
  });
  current.markerRemoved = true;
  current.quitDispatch = await bounded(
    dispatch,
    "DUAL_LAUNCH_QUIT_DISPATCH_UNKNOWN",
    5000,
  );
  witness = await recheckNativePreviewIsolation(witness, current.actual, child);
  await bounded(application.close(), "DUAL_LAUNCH_DRIVER_CLOSE_UNKNOWN", 5000);
  application = undefined;
  current.status = "passed";
}
try {
  for (const ordinal of [1, 2]) {
    // Requalify the SAME image, never rebuild or refresh between lifetimes.
    assert.deepEqual(await readPreparedDevCore(root), image);
    if (previousConfig)
      assert.equal(
        hash(
          await fs.readFile(
            path.join(identity.userData, "farol-state/config.json"),
          ),
        ),
        previousConfig,
        "DUAL_LAUNCH_SETTINGS_CHANGED_BETWEEN_LIFETIMES",
      );
    current = { ordinal, status: "starting", quitAttempted: false };
    report.fixture.lifetimes.push(current);
    const admission = await assertNativePreviewAdmission(undefined, {
      profileRoot,
      proof,
      launchOptions: options,
      fixture: site,
      ...(witness ? { previous: witness } : {}),
    });
    await save();
    application = await bounded(
      electron.launch(options),
      "DUAL_LAUNCH_DISPATCH_UNKNOWN",
      20000,
    );
    const child = application.process();
    current.pid = child.pid;
    current.terminal = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    current.closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length <= 131072)
        stderr += chunk.toString("utf8");
    });
    const { page, actual } = await bounded(
      readNativePreviewEcho(application),
      "DUAL_LAUNCH_ECHO_UNKNOWN",
    );
    current.actual = actual;
    witness = await recheckNativePreviewIsolation(admission, actual, child);
    assert.equal(actual.userData, identity.userData);
    assert(
      actual.windows.every((window) => !window.visible && !window.focused),
      "DUAL_LAUNCH_VISIBLE_WINDOW",
    );
    await bounded(waitForReactShell(page), "DUAL_LAUNCH_RENDERER_TIMEOUT");
    const outcome = await until(
      () => parseOwnerLaunchResult(stderr),
      (v) => v !== null,
      "DUAL_LAUNCH_RESULT_MISSING",
    );
    current.outcome = outcome;
    assert.equal(outcome, "primary-started", "DUAL_LAUNCH_RECOVERY_OR_REFUSAL");
    const boot = await until(
      () =>
        page.evaluate(async () => {
          const b = await window.farol.bootstrap();
          return {
            buildId: b.build.buildId,
            sourceCommit: b.build.sourceCommit,
            runtimeState: b.runtimeState,
            profileId: b.chatHistoryContext?.profileId,
            backendGeneration: b.chatHistoryContext?.backendGeneration,
            configuration: b.configuration.status,
          };
        }),
      (b) => b.runtimeState === "ready" && typeof b.profileId === "string",
      "DUAL_LAUNCH_RUNTIME_READY_TIMEOUT",
    );
    assert.equal(boot.sourceCommit, source.commit);
    assert.equal(boot.configuration, "ready");
    const profile = JSON.parse(
      await fs.readFile(
        path.join(identity.userData, "farol-state/go-core/profile.json"),
        "utf8",
      ),
    );
    assert.equal(profile.profileId, boot.profileId);
    previousProfile ??= profile.profileId;
    current.startupRoute = (await page.locator(".setup-page").count())
      ? "setup"
      : (await page.locator('[data-home-view="overview"]').count())
        ? "home"
        : "other";
    current.homeNavigationUsed = current.startupRoute !== "home";
    if (current.homeNavigationUsed)
      await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.locator('[data-home-view="overview"]').waitFor();
    await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
    const recovery = await page
      .getByRole("heading", {
        name: "Your previous session needs recovery",
        exact: true,
      })
      .count();
    current.witness = dualLaunchWitness(
      {
        buildId: image.buildId,
        profileId: previousProfile,
        previousBackendGeneration: previousBackend,
      },
      {
        ...boot,
        outcome,
        rendererReady: true,
        route: "home",
        recovery: recovery !== 0,
      },
    );
    current.marker = await readOwnedStartupMarker(
      path.join(identity.userData, "farol-state"),
      profileRoot,
      child.pid,
    );
    await page.screenshot({
      path: path.join(evidence, `lifetime-${ordinal}-home.png`),
    });
    previousBackend = boot.backendGeneration;
    await quitOriginal();
    previousConfig = hash(
      await fs.readFile(
        path.join(identity.userData, "farol-state/config.json"),
      ),
    );
    current.configSHA256AfterQuit = previousConfig;
    await save();
  }
  report.fixture.status = "passed";
} catch (error) {
  failure = error;
  report.fixture.status = "failed";
  report.failure = { code: error.message.split("\n")[0] };
  if (application && !current.quitAttempted) {
    try {
      await quitOriginal();
    } catch (cleanup) {
      report.cleanupFailure = { code: cleanup.message };
    }
  }
} finally {
  assert.deepEqual(
    await protectedSnapshot(),
    beforeProtected,
    "DUAL_LAUNCH_PROTECTED_PROFILE_CHANGED",
  );
  report.protectedDailyAndTestEntriesUnchanged = beforeProtected.length;
  if (!application) await new Promise((resolve) => site.close(resolve));
  else site.unref();
  report.cleanup = application
    ? "original lifetime/profile retained; cleanup unconfirmed"
    : "original processes and driver closed; fixture retained";
  await save();
  console.log(
    JSON.stringify({
      fixture: report.fixture.status,
      saved: report.saved.status,
      receipt: path.join(evidence, "report.json"),
    }),
  );
}
if (failure) throw failure;

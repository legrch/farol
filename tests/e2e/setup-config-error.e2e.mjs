// Hidden owned windows and disposable profiles only. No account, connector,
// model or owner-state acceptance is claimed by these configuration faults.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  retainOriginalChild,
  closeOriginalChild,
} from "./setup-config-error-child.mjs";
import {
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";
import {
  waitForReactShell,
  openSetup,
  setupStep,
  assertSetupOverview,
} from "./current-react-setup.mjs";

const packaged = process.argv.includes("--packaged");
const devOnly = process.argv.includes("--dev-only");
assert.deepEqual(
  process.argv.slice(2),
  packaged ? ["--packaged"] : devOnly ? ["--dev-only"] : [],
);
const root = process.cwd();
const appRoot = path.join(root, "_output/package/Farol.app");
const executable = packaged
  ? path.join(
      appRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const entry = packaged
  ? path.join(appRoot, "Contents/Resources/app/main.cjs")
  : path.join(root, "_output/build/app/main.cjs");
const ownerState = path.join(
  os.homedir(),
  "Library/Application Support/Farol Next Preview/farol-next-state",
);
const observations = [];
let primaryFailure;
const cleanupFailures = [];
let cleanupUnknown = false;
// Even unavailable configuration starts the Browser route. Select an owned
// loopback document so startup cannot fall back to the public ChatGPT home.
const chatFixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Local config fault fixture</title>");
});

async function fixtureWait(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await fixtureWait(
    new Promise((resolve, reject) => {
      chatFixture.once("error", reject);
      chatFixture.listen(0, "127.0.0.1", resolve);
    }),
    "SETUP_CONFIG_FIXTURE_LISTEN_UNKNOWN",
  );
  const fixtureAddress = chatFixture.address();
  assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;
  environments: for (const environment of packaged
    ? ["preview"]
    : devOnly
      ? ["dev"]
      : ["dev", "preview"]) {
    for (const fault of ["legacy-name", "corrupt", "unsafe"]) {
      const profile = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-home-")),
      );
      await fs.chmod(profile, 0o700);
      const proof = randomUUID();
      await fs.writeFile(path.join(profile, ".farol-next-e2e-root"), proof, {
        mode: 0o600,
      });
      const appData = path.join(profile, "app-data");
      const userData =
        environment === "dev"
          ? path.join(appData, "Farol Dev")
          : path.join(profile, "user-data");
      const stateRoot = path.join(userData, "farol-next-state");
      await fs.mkdir(appData, { mode: 0o700 });
      await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      const file = path.join(
        stateRoot,
        fault === "legacy-name" ? "product-settings.json" : "config.json",
      );
      const bytes = fault === "corrupt" ? "not-json\n" : "{}\n";
      await fs.writeFile(file, bytes, {
        mode: fault === "unsafe" ? 0o644 : 0o600,
      });
      const expected =
        fault === "legacy-name"
          ? "CONFIG_RENAME_REQUIRED"
          : fault === "corrupt"
            ? "SETTINGS_CORRUPT"
            : "SETTINGS_UNSAFE";
      let application;
      let owned;
      let isolationWitness;
      let nativePaths;
      let stage = "admission";
      const run = {
        kind: "config-fault-run",
        environment,
        fault,
        code: expected,
        profileRoot: profile,
        primaryFailure: null,
        cleanupFailures: [],
        child: null,
        profileCleanup: "retained",
      };
      observations.push(run);
      const cleanupStart = cleanupFailures.length;
      try {
        const launchOptions = {
          executablePath: executable,
          args: [
            entry,
            `--user-data-dir=${userData}`,
            "--preview-window-mode=hidden",
          ],
          env: {
            HOME: profile,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TMPDIR: os.tmpdir(),
            LANG: "en_US.UTF-8",
            FAROL_NEXT_E2E: "1",
            FAROL_NEXT_E2E_APP_DATA: appData,
            FAROL_NEXT_E2E_TEST_ROOT: profile,
            FAROL_NEXT_E2E_TEST_PROOF: proof,
            FAROL_NEXT_E2E_CHATGPT_URL: fixtureUrl,
            ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
          },
          timeout: 15000,
        };
        const admission = await assertNativePreviewAdmission(ownerState, {
          profileRoot: profile,
          proof,
          launchOptions,
          fixture: chatFixture,
        });
        stage = "launch";
        application = await electron.launch(launchOptions);
        owned = retainOriginalChild(application, observations, {
          environment,
          fault,
        });
        stage = "first-window";
        const window = await application.firstWindow({ timeout: 15000 });
        stage = "native-isolation";
        const actual = await application.evaluate(({ app, BrowserWindow }) => ({
          pid: process.pid,
          home: app.getPath("home"),
          userData: app.getPath("userData"),
          sessionData: app.getPath("sessionData"),
          temp: app.getPath("temp"),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })),
        }));
        observations.push({
          kind: "native-profile-path-readback",
          environment,
          profileRoot: profile,
          nativePaths: actual,
        });
        isolationWitness = await recheckNativePreviewIsolation(
          admission,
          actual,
          owned.child,
        );
        nativePaths = actual;
        observations.push(isolationWitness);
        await readOwnedStartupMarker(stateRoot, profile, owned.child.pid);
        stage = "configuration-ui";
        await waitForReactShell(window);
        const bootstrap = await window.evaluate(() =>
          window.farolNext.bootstrap(),
        );
        assert.deepEqual(bootstrap.configuration, {
          status: "error",
          error: expected,
        });
        // Configuration availability and snapshot freshness are independent.
        // Home must expose the retained fault even when its snapshot is current.
        await window
          .getByRole("navigation", { name: "Home views", exact: true })
          .getByRole("button", { name: /^Needs attention\b/u })
          .click();
        await window
          .getByText("Setup evidence is unavailable", { exact: true })
          .waitFor();
        await openSetup(window);
        await setupStep(window, "connection", "Connection");
        await window
          .locator('.setup-page[data-setup-step="connection"]')
          .waitFor();
        const unavailable = window.locator(".setup-page .settings-page");
        await unavailable
          .getByText(
            "Settings are unavailable. Refresh the current state before making changes.",
            { exact: true },
          )
          .waitFor();
        // With no valid settings React mounts no editable forms or mutation
        // controls. Navigation and Refresh remain available for inspection.
        assert.equal(
          await unavailable.locator("input, select, textarea, form").count(),
          0,
        );
        assert.deepEqual(
          await unavailable.getByRole("button").allTextContents(),
          ["Refresh status"],
        );
        // Refresh requests a read observation. The unavailable UI must remain
        // closed to edits, and neither observation nor navigation may reset bytes.
        await unavailable
          .getByRole("button", { name: "Refresh status", exact: true })
          .click();
        await unavailable
          .getByText(
            "Settings are unavailable. Refresh the current state before making changes.",
            { exact: true },
          )
          .waitFor();
        assert.deepEqual(
          (await window.evaluate(() => window.farolNext.bootstrap()))
            .configuration,
          { status: "error", error: expected },
          "REFRESH_RESET_CONFIGURATION_FAULT",
        );
        for (const [step, label] of [
          ["signin", "Sign in"],
          ["folders", "Workspaces"],
          ["attachment", "Check"],
        ]) {
          await setupStep(window, step, label);
          assert.equal(
            await unavailable.locator("input, select, textarea, form").count(),
            0,
          );
          assert.deepEqual(
            await unavailable.getByRole("button").allTextContents(),
            ["Refresh status"],
          );
        }
        await assertSetupOverview(window, {
          ready: false,
          signIn: "unknown",
          states: {
            signin: "unknown",
            folders: "unavailable",
            connection: "unavailable",
            attachment: "unavailable",
          },
        });
        await window
          .getByRole("region", { name: "Setup overview", exact: true })
          .getByRole("button", { name: "Review Connection", exact: true })
          .click();
        await window
          .locator('.setup-page[data-setup-step="connection"]')
          .waitFor();
        await unavailable
          .getByRole("button", { name: "Refresh status", exact: true })
          .waitFor();
        assert.equal(await window.locator("dialog[open]").count(), 0);
        await window
          .getByRole("navigation", { name: "Sections", exact: true })
          .getByRole("button", { name: "ChatGPT", exact: true })
          .click();
        // ChatGPT navigation has no duplicate shell launchers. The damaged
        // configuration must remain unavailable after presenting its route.
        for (const name of ["Open ChatGPT", "Sign in"]) {
          assert.equal(
            await window.getByRole("button", { name, exact: true }).count(),
            0,
          );
        }
        assert.deepEqual(
          (await window.evaluate(() => window.farolNext.bootstrap()))
            .configuration,
          { status: "error", error: expected },
          "NAVIGATION_RESET_CONFIGURATION_FAULT",
        );
        assert.equal(
          await fs.readFile(file, "utf8"),
          bytes,
          "CONFIGURATION_FAULT_WAS_RESET",
        );
        observations.push({
          environment,
          fault,
          code: expected,
          currentReactSetup: true,
          recoveryObservationAvailable: true,
          editableConfiguration: false,
          ready: false,
          configurationPreserved: true,
        });
      } catch (error) {
        primaryFailure = error;
        run.primaryFailure = String(error);
        run.failureStage = stage;
      } finally {
        if (owned) {
          const result = await closeOriginalChild(
            application,
            owned,
            fixtureWait,
          );
          run.child = {
            ...result,
            closeError: result.closeError ? String(result.closeError) : null,
            exitError: result.exitError ? String(result.exitError) : null,
          };
          cleanupFailures.push(
            ...[result.closeError, result.exitError].filter(Boolean),
          );
          cleanupUnknown ||= !result.terminal;
          if (result.terminal && (result.exit !== 0 || result.signal !== null))
            cleanupFailures.push(new Error("SETUP_CONFIG_FAULT_UNCLEAN_EXIT"));
        } else if (application || stage === "launch") {
          cleanupUnknown = true;
        }
        if (
          !primaryFailure &&
          cleanupFailures.length === cleanupStart &&
          run.child?.terminal &&
          isolationWitness
        ) {
          // Preserve an unsafe/unknown profile. Recheck the immutable physical
          // binding after the original child exits before disposable cleanup.
          try {
            await recheckNativePreviewIsolation(
              isolationWitness,
              nativePaths,
              owned.child,
            );
            run.profileCleanup = "removal-started";
            await fs.rm(profile, { recursive: true, force: true });
            run.profileCleanup = "removed";
          } catch (error) {
            cleanupFailures.push(error);
            if (run.profileCleanup === "removal-started") {
              run.profileCleanup = "removal-unknown";
              cleanupUnknown = true;
            }
          }
        }
        run.cleanupFailures = cleanupFailures.slice(cleanupStart).map(String);
        run.cleanupUnknown = cleanupUnknown;
      }
      if (primaryFailure || cleanupFailures.length || cleanupUnknown)
        break environments;
    }
  }
} catch (error) {
  primaryFailure ??= error;
} finally {
  try {
    if (chatFixture.listening)
      await fixtureWait(
        new Promise((resolve, reject) =>
          chatFixture.close((error) => (error ? reject(error) : resolve())),
        ),
        "SETUP_CONFIG_FIXTURE_CLOSE_UNKNOWN",
      );
  } catch (error) {
    cleanupFailures.push(error);
    cleanupUnknown = true;
  }
  process.stdout.write(
    `${JSON.stringify({ scope: "hidden-disposable-config-faults", packaged, devOnly, observations, primaryFailure: primaryFailure ? String(primaryFailure) : null, cleanupFailures: cleanupFailures.map(String), cleanupUnknown })}\n`,
  );
}
if (primaryFailure || cleanupFailures.length || cleanupUnknown) {
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures].filter(Boolean),
    cleanupUnknown
      ? "SETUP_CONFIG_FAULT_CLEANUP_UNKNOWN"
      : "SETUP_CONFIG_FAULT_FAILED",
  );
}

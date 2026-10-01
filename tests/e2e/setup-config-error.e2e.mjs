// Hidden owned windows and disposable profiles only. No account, connector,
// model or owner-state acceptance is claimed by these configuration faults.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { assertOwnerPreviewIdle } from "./native-preview-admission.mjs";

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

async function closeOwned(application) {
  const child = application.process();
  const terminal = once(child, "exit");
  let timer;
  try {
    await Promise.race([
      application.close().then(async () => {
        if (child.exitCode === null && child.signalCode === null)
          await terminal;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SETUP_CONFIG_FAULT_QUIT_UNKNOWN")),
          15000,
        );
      }),
    ]);
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
  } finally {
    clearTimeout(timer);
  }
}

for (const environment of packaged
  ? ["preview"]
  : devOnly
    ? ["dev"]
    : ["dev", "preview"]) {
  for (const fault of ["legacy-name", "corrupt", "unsafe"]) {
    await assertOwnerPreviewIdle(ownerState);
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
    let closed = false;
    try {
      application = await electron.launch({
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
          ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
        },
        timeout: 15000,
      });
      const actual = await application.evaluate(({ app }) =>
        app.getPath("userData"),
      );
      assert.equal(
        await fs.realpath(actual),
        await fs.realpath(userData),
        "SETUP_CONFIG_FAULT_PROFILE_NOT_OWNED",
      );
      const window = await application.firstWindow({ timeout: 15000 });
      await window.waitForFunction(
        () => document.documentElement.dataset.ready === "true",
      );
      const bootstrap = await window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.deepEqual(bootstrap.configuration, {
        status: "error",
        error: expected,
      });
      assert.equal(
        await window.locator("#setup-dialog").isVisible(),
        false,
        "LEGACY_MODAL_OPEN_ON_CONFIGURATION_ERROR",
      );
      assert.equal(
        await window.locator('[data-panel="computer"].active').isVisible(),
        true,
      );
      assert.equal(
        await window.locator("#guided-onboarding").isVisible(),
        true,
      );
      assert.match(
        await window.locator("#onboarding-feedback").innerText(),
        new RegExp(expected),
      );
      assert.equal(
        await window.locator("#onboarding-primary").isDisabled(),
        true,
      );
      for (const selector of [
        "#onboarding-open-chatgpt",
        "#onboarding-open-account",
      ]) {
        assert.equal(
          await window.locator(selector).isDisabled(),
          true,
          `CONFIGURATION_ACTION_STILL_ENABLED:${selector}`,
        );
      }
      const helpDisabled = await window
        .locator("[data-onboarding-help]")
        .evaluateAll((buttons) => buttons.map((button) => button.disabled));
      assert.ok(helpDisabled.length > 0);
      assert.ok(
        helpDisabled.every(Boolean),
        "CONFIGURATION_HELP_ACTION_STILL_ENABLED",
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
        sidebarSetup: true,
        legacyModal: false,
        configurationPreserved: true,
      });
    } finally {
      if (application) {
        await closeOwned(application);
        closed = true;
      }
      if (closed) await fs.rm(profile, { recursive: true, force: true });
    }
  }
}
process.stdout.write(
  `${JSON.stringify({ scope: "hidden-disposable-config-faults", packaged, observations })}\n`,
);

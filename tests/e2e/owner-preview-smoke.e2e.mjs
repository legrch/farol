import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopAppDataPath,
  desktopIdentity,
} from "../../src/apps/desktop/desktop-environment.ts";
import { parseQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import { requireOwnerPreviewRuntimeIntegration } from "../../tooling/owner-preview-contract.mjs";
import {
  verifyOwnerPreview,
  physicalDirectory,
  regularBytes,
  jsonBytes,
  sha256,
} from "../../tooling/verify-owner-preview.mjs";

const APPEARANCE = { theme: "graphite", accent: "amber", font: "geist" };
async function deadline(promise, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OWNER_PREVIEW_SMOKE_UNKNOWN:${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function privateDirectory(directory) {
  await physicalDirectory(path.dirname(directory));
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await physicalDirectory(directory, { privateMode: true });
}

// Receipt inputs cannot contain observations or a PASS override. This function
// must execute both exact packaged launches and verify their real observations.
export async function runOwnerPreviewSmoke(repositoryRoot, generation) {
  requireOwnerPreviewRuntimeIntegration();
  const verified = await verifyOwnerPreview(repositoryRoot, generation);
  const namespace = path.join(repositoryRoot, "_output/preview/smoke");
  await privateDirectory(namespace);
  const evidence = path.join(namespace, generation);
  await privateDirectory(evidence);
  for (const name of await fs.readdir(evidence)) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(name))
      throw new Error("OWNER_PREVIEW_SMOKE_EVIDENCE_INVALID");
    const prior = JSON.parse(
      (await regularBytes(path.join(evidence, name))).toString(),
    );
    if (prior.status !== "PASS")
      throw new Error(
        "OWNER_PREVIEW_SMOKE_UNRESOLVED: retain the original attempt; Root must reconcile, no automatic retry",
      );
  }
  const attempt = randomUUID();
  const receiptFile = path.join(evidence, `${attempt}.json`);
  const receipt = {
    schema: "farol-owner-preview-smoke/1",
    attempt,
    status: "UNKNOWN",
    launchFailureCleanup:
      "playwright-owned-disposable-process-group-may-be-killed",
    sourceCommit: verified.manifest.sourceCommit,
    sourceTreeDigest: verified.manifest.sourceTreeDigest,
    baseArtifactSha256: verified.manifest.baseArtifactSha256,
    baseBuildId: verified.manifest.baseBuildId,
    derivativeTreeDigest: verified.manifest.appTreeDigest,
    generation,
    startedAt: new Date().toISOString(),
    observations: [],
    limits: [
      "disposable profile",
      "no authentication/provider/tunnel",
      "no installed-state qualification",
    ],
  };
  await fs.writeFile(receiptFile, jsonBytes(receipt), {
    flag: "wx",
    mode: 0o600,
  });
  let home, proof, appData, current, server;
  let quitRequested = false;
  const checkpoint = () =>
    fs.writeFile(receiptFile, jsonBytes(receipt), { mode: 0o600 });
  try {
    const temporary = await fs.realpath(os.tmpdir());
    home = await fs.mkdtemp(path.join(temporary, "farol-next-e2e-home-"));
    await fs.chmod(home, 0o700);
    appData = path.join(home, "farol-e2e-app-data");
    await fs.mkdir(appData, { mode: 0o700 });
    proof = randomUUID();
    await fs.writeFile(path.join(home, ".farol-next-e2e-root"), proof, {
      flag: "wx",
      mode: 0o600,
    });
    // Reuse the production E2E proof; no arbitrary userData/profile override.
    desktopAppDataPath("owner-preview", appData, {
      enabled: true,
      override: appData,
      testRoot: home,
      testHome: home,
      testProof: proof,
    });
    const identity = desktopIdentity("owner-preview", appData);
    receipt.profile = { home, appData, proof, userData: identity.userData };
    await checkpoint();
    server = createServer((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<!doctype html><title>Offline Preview smoke</title><p>No account connected.</p>",
      );
    });
    server.listen(0, "127.0.0.1");
    await deadline(once(server, "listening"), "fixture-listen");
    const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
    const { _electron: electron } = await import("playwright-core");
    const executable = path.join(
      verified.appPath,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    );
    const appRoot = path.join(verified.appPath, "Contents/Resources/app");
    const environment = {
      HOME: home,
      TMPDIR: temporary,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_FORCE_IS_PACKAGED: "true",
      FAROL_NEXT_ENVIRONMENT: "owner-preview",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: home,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_CHATGPT_URL: fixtureOrigin,
    };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      // Canonical snapshot and derivative are independently reverified directly
      // before EACH launch. Never run the hidden canonical input application.
      await verifyOwnerPreview(repositoryRoot, generation);
      // The pinned launcher may kill its own disposable process group if
      // initialization fails before a handle returns. That is UNKNOWN, never
      // a drained Quit or permission to publish/replay this generation.
      current = await electron.launch({
        executablePath: executable,
        args: [
          appRoot,
          "--preview-window-mode=hidden",
          "--owner-background-only",
        ],
        env: environment,
        timeout: 15000,
      });
      quitRequested = false;
      const owned = current.process();
      assert.ok(Number.isInteger(owned.pid) && owned.pid > 0);
      const outbound = [];
      await current.context().route("**/*", (route) => {
        const url = route.request().url();
        if (
          url.startsWith(`${fixtureOrigin}/`) ||
          url.startsWith("file:") ||
          url.startsWith("devtools:")
        )
          return route.continue();
        outbound.push(new URL(url).origin);
        return route.abort();
      });
      const page = await current.firstWindow({ timeout: 15000 });
      await page
        .locator("#sidebar")
        .waitFor({ state: "attached", timeout: 15000 });
      const bootstrap = await deadline(
        page.evaluate(() => window.farolNext.bootstrap()),
        "bootstrap",
      );
      assert.equal(bootstrap.environment, "owner-preview");
      assert.equal(bootstrap.displayName, "Farol Preview");
      assert.equal(bootstrap.applicationId, "local.farol.owner.preview");
      assert.equal(bootstrap.partition, identity.runtimePartition);
      assert.equal(bootstrap.chatgptPartition, identity.chatGptPartition);
      assert.equal(
        bootstrap.build.sourceCommit,
        verified.manifest.sourceCommit,
      );
      assert.equal(
        bootstrap.build.sourceTreeDigest,
        verified.manifest.sourceTreeDigest,
      );
      assert.equal(bootstrap.build.buildId, verified.manifest.baseBuildId);
      assert.equal(bootstrap.build.sourceDirty, false);
      assert.equal(bootstrap.configuration.status, "ready");
      const connector = bootstrap.configuration.settings.connectors.secureMcp;
      assert.equal(connector.credential, "missing");
      for (const key of [
        "tunnelId",
        "tunnelClient",
        "runtime",
        "attachment",
        "lastVerifiedAttachment",
      ])
        assert.equal(connector[key], null);
      assert.deepEqual(bootstrap.tasks, []);
      const actual = await deadline(
        current.evaluate(({ app, BrowserWindow, session }) => ({
          name: app.getName(),
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          userData: app.getPath("userData"),
          sessionData: app.getPath("sessionData"),
          home: app.getPath("home"),
          executable: process.execPath,
          windows: BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            url: window.webContents.getURL(),
          })),
          runtimeStorage: session.fromPartition(
            "persist:farol-owner-preview-runtime",
          ).storagePath,
          chatStorage: session.fromPartition(
            "persist:farol-owner-preview-chatgpt",
          ).storagePath,
          pids: app.getAppMetrics().map((metric) => metric.pid),
        })),
        "runtime-identity",
      );
      assert.equal(actual.name, "Farol Preview");
      assert.equal(actual.packaged, true);
      assert.equal(
        await fs.realpath(actual.executable),
        await fs.realpath(executable),
      );
      assert.equal(
        await fs.realpath(actual.appPath),
        await fs.realpath(appRoot),
      );
      for (const key of ["userData", "sessionData"])
        assert.equal(actual[key], identity[key]);
      assert.equal(actual.home, home);
      for (const key of ["runtimeStorage", "chatStorage"])
        assert.ok(
          typeof actual[key] === "string" &&
            actual[key].startsWith(`${identity.userData}${path.sep}`),
        );
      assert.notEqual(actual.runtimeStorage, actual.chatStorage);
      assert.ok(
        actual.windows.length > 0 &&
          actual.windows.every(
            (window) =>
              !window.visible &&
              !window.focused &&
              (window.url.startsWith("file:") ||
                window.url.startsWith(fixtureOrigin)),
          ),
      );
      const update = await deadline(
        page.evaluate(() =>
          window.farolNext.installedUpdate({ kind: "status" }),
        ),
        "update-status",
      );
      assert.equal(
        update.phase,
        "unavailable",
        "OWNER_PREVIEW_INSTALLED_UPDATER_MUST_BE_EXCLUDED",
      );
      if (cycle === 0) {
        // Actual renderer preference key, consumed and presented on reopen.
        await deadline(
          page.evaluate(
            (appearance) =>
              localStorage.setItem(
                "farol.appearance.v1",
                JSON.stringify(appearance),
              ),
            APPEARANCE,
          ),
          "save-appearance",
        );
      } else {
        assert.deepEqual(
          await deadline(
            page.evaluate(() =>
              JSON.parse(localStorage.getItem("farol.appearance.v1")),
            ),
            "read-appearance",
          ),
          APPEARANCE,
        );
        await page
          .locator(
            '.desktop[data-theme="graphite"][data-accent="amber"][data-font="geist"]',
          )
          .waitFor({ state: "attached", timeout: 15000 });
      }
      assert.deepEqual(outbound, [], "OWNER_PREVIEW_SMOKE_EXTERNAL_REQUEST");
      const beforeQuit = Date.now();
      const exit = once(owned, "exit");
      quitRequested = true;
      void current.evaluate(({ app }) => app.quit()).catch(() => {});
      const [code, signal] = await deadline(exit, "normal-quit");
      assert.equal(code, 0);
      assert.equal(signal, null);
      const state = path.join(identity.userData, "farol-next-state");
      const quit = parseQuitReceipt(
        (
          await regularBytes(path.join(state, "last-quit.json"), 8192)
        ).toString(),
      );
      assert.equal(quit.ok, true);
      assert.equal(quit.receipt.drained, true);
      assert.deepEqual(quit.receipt.unconfirmed, []);
      assert.ok(Date.parse(quit.receipt.at) >= beforeQuit);
      await assert.rejects(fs.lstat(path.join(state, "running.json")), {
        code: "ENOENT",
      });
      // Exact observed owned PIDs only. No global process table and no signals.
      for (const pid of new Set([owned.pid, ...actual.pids])) {
        let gone = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") {
              gone = true;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          gone,
          true,
          `OWNER_PREVIEW_SMOKE_OWNED_PROCESS_UNCONFIRMED:${pid}`,
        );
      }
      receipt.observations.push({
        cycle,
        pid: owned.pid,
        identity: actual,
        configurationSha256: sha256(
          jsonBytes(bootstrap.configuration.settings),
        ),
        updater: update.phase,
        quit: quit.receipt,
        settingsPreserved: cycle === 1,
      });
      await checkpoint();
      current = null;
    }
    await verifyOwnerPreview(repositoryRoot, generation);
    // Only a successfully drained pair allows exact disposable-profile cleanup.
    await physicalDirectory(home, { privateMode: true });
    assert.equal(
      (
        await regularBytes(path.join(home, ".farol-next-e2e-root"), 64)
      ).toString(),
      proof,
    );
    assert.equal(path.dirname(home), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(home), /^farol-next-e2e-home-[A-Za-z0-9]{6,}$/u);
    await fs.rm(home, { recursive: true });
    receipt.cleanup = "exact-owned-profile-removed-after-two-drained-quits";
    receipt.status = "PASS";
    receipt.finishedAt = new Date().toISOString();
    await checkpoint();
    return { receiptFile, receipt };
  } catch (error) {
    // One orderly cleanup request for a known owned app, never retry Quit after
    // a refused/UNKNOWN drain, never close()/kill(), and preserve the profile.
    if (current && !quitRequested && current.process().exitCode === null) {
      quitRequested = true;
      void current.evaluate(({ app }) => app.quit()).catch(() => {});
    }
    receipt.status = "UNKNOWN";
    receipt.error =
      error instanceof Error ? error.message : "OWNER_PREVIEW_SMOKE_FAILED";
    receipt.profileRetained = home ?? null;
    await checkpoint();
    throw new Error(
      `OWNER_PREVIEW_SMOKE_UNCONFIRMED: ${receiptFile}: ${receipt.error}`,
      { cause: error },
    );
  } finally {
    if (server) {
      server.closeAllConnections(); // only this attempt's loopback fixture
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.argv.length !== 4 ||
      process.argv[2] !== "--generation" ||
      !/^[a-f0-9]{64}$/u.test(process.argv[3])
    )
      throw new Error(
        "Usage: node tests/e2e/owner-preview-smoke.e2e.mjs --generation <64hex>",
      );
    const root = await fs.realpath(
      path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    );
    const result = await runOwnerPreviewSmoke(root, process.argv[3]);
    process.stdout.write(`${result.receiptFile}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

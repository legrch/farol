import { desktopIdentity } from "../../tooling/harness-identity.ts";
// Real built application + disposable disk/native workspace. Only the OS picker
// is replaced by the existing explicit E2E workspace selection seam. No signed-in
// ChatGPT, external tunnel, production app or owner Dev profile is accessed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { _electron } from "playwright-core";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
const root = process.cwd(),
  output = path.join(root, "_output/shell-screens");
await fs.mkdir(output, { recursive: true });
const source = sourceIdentity(root),
  buildRoot = path.join(root, "_output/build/app");
const build = await qualifyGoBuild(buildRoot, source);
const profile = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
);
await fs.chmod(profile, 0o700);
const home = profile,
  appData = path.join(profile, "app-data"),
  workspace = path.join(profile, "B2 documents");
for (const dir of [home, appData, workspace])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
await fs.writeFile(
  path.join(workspace, "README.md"),
  "Disposable native workspace; no owner content.\n",
  { mode: 0o600 },
);
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
  mode: 0o600,
});
const report = {
  source,
  buildId: build.identity.buildId,
  mode: "hidden",
  profile,
  fixture: "OS workspace picker only; actual Settings/Go workspace/log reads",
  liveProvider:
    "NOT RUN: disposable profile has no signed-in ChatGPT or tunnel",
  launches: [],
  checks: [],
  screenshots: [],
};
const env = {
  FAROL_E2E: "1",
  FAROL_E2E_APP_DATA: appData,
  FAROL_E2E_TEST_ROOT: profile,
  FAROL_E2E_TEST_PROOF: proof,
  FAROL_E2E_WORKSPACE_ROOT: workspace,
  FAROL_ENVIRONMENT: "dev",
  HOME: home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TMPDIR: os.tmpdir(),
};
let application, page, activeInstance;
async function launch() {
  application = await _electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env,
    timeout: 20000,
  });
  const child = application.process();
  const terminal = once(child, "exit");
  activeInstance = { child, terminal };
  page = await application.firstWindow();
  const deadline = Date.now() + 20000;
  while (true) {
    const ready = await page.evaluate(async () => {
      const b = await window.farol?.bootstrap();
      return b?.runtimeState === "ready" && b?.configuration.status === "ready";
    });
    if (ready) break;
    assert.ok(Date.now() < deadline, "OPERATIONS_BOOTSTRAP_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const windows = await application.evaluate(({ BrowserWindow, app }) => ({
    userData: app.getPath("userData"),
    windows: BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
    })),
  }));
  assert.ok(windows.windows.every((w) => !w.visible && !w.focused));
  report.launches.push({ pid: child.pid, ...windows });
  return { child, terminal, userData: windows.userData };
}
async function close(owned) {
  const closing = application;
  application = null;
  await closing.close();
  const [code, signal] = await owned.terminal;
  assert.equal(code, 0);
  assert.equal(signal, null);
  owned.exitCode = code;
  report.launches.at(-1).exitCode = code;
}
async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  await page.screenshot({ path: path.join(output, name + ".png") });
  report.screenshots.push(name + ".png");
}
try {
  const first = await launch();
  assert.equal(first.userData, desktopIdentity("dev", appData).userData);
  // A fresh profile starts in Setup; Home restores the normal expanded shell.
  await page.locator('.rail [aria-label="Home"]').click();
  await page.locator('.desktop[data-sidebar="full"]').waitFor();
  assert.equal(
    await page.locator(".desktop").getAttribute("data-sidebar"),
    "full",
  );
  assert.equal(
    await page
      .locator(".rail")
      .evaluate((el) => el.getBoundingClientRect().width),
    214,
  );
  await screenshot("b2-default-expanded-real");
  const selected = await page.evaluate(() =>
    window.farol.configure({ kind: "computer.choose-workspace" }),
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.evidence.kind, "computer.workspace-pick");
  const added = await page.evaluate(
    (selectionId) =>
      window.farol.configure({ kind: "computer.add-workspace", selectionId }),
    selected.evidence.selectionId,
  );
  assert.equal(added.ok, true);
  const workspaceId = added.evidence.workspaceId;
  const verified = await page.evaluate(
    (workspaceId) =>
      window.farol.configure({
        kind: "computer.verify-workspace",
        workspaceId,
      }),
    workspaceId,
  );
  assert.equal(verified.ok, true, "actual workspace verification");
  const checked = await page.evaluate(() =>
    window.farol.configure({ kind: "connector.check-health" }),
  );
  assert.equal(checked.ok, false, "unconfigured connection stays refused");
  // Poll the async bridge sequentially; waitForFunction treats a Promise as
  // truthy before it settles. Observe results without resending any action.
  const observationDeadline = Date.now() + 20000;
  let log;
  for (;;) {
    log = await page.evaluate(() => window.farol.operations());
    const complete = [
      ["hub.start", "done"],
      ["computer.add-workspace", "done"],
      ["computer.verify-workspace", "done"],
      ["connector.check-health", "refused"],
    ].every(([kind, outcome]) =>
      log.entries.some(
        (entry) => entry.kind === kind && entry.outcome === outcome,
      ),
    );
    if (complete) break;
    assert.ok(
      Date.now() < observationDeadline,
      "OPERATIONS_OBSERVATION_TIMEOUT",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    log.entries.some(
      (e) =>
        e.kind === "hub.start" && e.source === "Setup" && e.outcome === "done",
    ),
  );
  assert.ok(
    log.entries.some(
      (e) =>
        e.kind === "computer.add-workspace" &&
        e.target.workspace === "B2 documents" &&
        e.outcome === "done",
    ),
  );
  assert.ok(
    log.entries.some(
      (e) => e.kind === "computer.verify-workspace" && e.outcome === "done",
    ),
  );
  assert.ok(
    log.entries.some(
      (e) => e.kind === "connector.check-health" && e.outcome === "refused",
    ),
  );
  assert.equal(log.corruptLines, 0);
  assert.equal(log.writeFailures, 0);
  report.operations = log;
  report.checks.push(
    "real workspace added and verified; real unconfigured connection check recorded as refused",
  );
  await page.locator('.rail [aria-label="Activity"]').click();
  await page.locator(".operation-row").first().waitFor();
  await page
    .locator(".operation-row")
    .filter({ hasText: "connector check-health" })
    .locator("summary")
    .click();
  await screenshot("b2-activity-real-session");
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await screenshot("b2-collapsed-real");
  await close(first);
  const second = await launch();
  // Bootstrap readiness precedes the renderer restoring its local preference.
  await page.locator('.desktop[data-sidebar="rail"]').waitFor();
  assert.equal(
    await page.locator(".desktop").getAttribute("data-sidebar"),
    "rail",
  );
  const reopened = await page.evaluate(() => window.farol.operations());
  assert.ok(
    reopened.entries.some((e) => e.kind === "hub.stop" && e.outcome === "done"),
  );
  for (const entry of log.entries)
    assert.ok(reopened.entries.some((e) => e.id === entry.id));
  report.checks.push("log and sidebar choice survive clean app restart");
  await page.locator('.rail [aria-label="Home"]').click();
  await page.locator(".home-recent .home-row").first().waitFor();
  assert.equal(
    await page.locator(".desktop").getAttribute("data-sidebar"),
    "rail",
  );
  await screenshot("b2-home-recent-real");
  await close(second);
  report.storage = path.join(first.userData, "farol-state/operations");
  report.cleanup =
    "both exact hidden Electron instances exited 0; disposable profile retained as local evidence";
} finally {
  if (application) {
    await close(activeInstance);
  }
  await fs.writeFile(
    path.join(output, "b2-real-session.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    checks: report.checks,
    screenshots: report.screenshots,
    cleanup: report.cleanup,
  }),
);

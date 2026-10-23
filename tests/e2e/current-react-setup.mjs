// Current built React surface only. These helpers navigate and observe; the
// caller owns disposable profiles, native processes and fixture receipts.
import assert from "node:assert/strict";

export async function waitForReactShell(page) {
  await page.locator(".toolbar-title strong").waitFor();
  await page.waitForFunction(() => {
    const main = document.querySelector("main.stage");
    return Boolean(
      main &&
      !main.textContent.includes("Connecting to Farol…") &&
      (document.querySelector('nav[aria-label="Sections"]') ||
        main.querySelector(".setup-page")),
    );
  });
}

export async function openSetup(page) {
  await setupStep(page, "overview");
  await page.locator(".setup-page").waitFor({ state: "visible" });
}

export async function setupStep(page, step) {
  const label = {
    overview: "Setup",
    signin: "Sign in",
    folders: "Workspaces",
    connection: "Connect this Mac",
    attachment: "Add to ChatGPT",
  }[step];
  assert.ok(label, `SETUP_STEP_UNSUPPORTED:${step}`);
  // Setup intentionally hides the ordinary rail. Page search is available
  // in both shells and uses the same production navigation destinations.
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Find a page", exact: true })
    .fill(label);
  await page
    .locator(".search-results")
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.locator(`.setup-page[data-setup-step="${step}"]`).waitFor();
}

export async function readSetupSettings(page) {
  const bootstrap = await page.evaluate(() => window.farol.bootstrap());
  assert.equal(bootstrap.configuration.status, "ready");
  return bootstrap.configuration.settings;
}

function connectionOutcomeUnknown(settings) {
  return Boolean(
    settings.setup.connect.outcomeUnknown ||
    settings.setup.computer.outcomeUnknown ||
    settings.setup.hosts?.outcomeUnknown ||
    settings.setup.verify?.outcomeUnknown ||
    settings.computer.pendingEdit ||
    settings.connectors.secureMcp.runtime?.state === "outcome_unknown",
  );
}

// A new connection must have fresh saved runtime evidence; an already green
// status cannot prove another click. Use this helper only from a stopped runtime.
export async function connectMac(page) {
  const connection = page.locator('.setup-page[data-setup-step="connection"]');
  const before = await readSetupSettings(page);
  assert.equal(connectionOutcomeUnknown(before), false);
  assert.equal(
    before.connectors.secureMcp.runtime,
    null,
    "SETUP_CONNECT_REQUIRES_STOPPED_RUNTIME",
  );
  await connection
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await readSetupSettings(page);
    if (connectionOutcomeUnknown(current))
      throw new Error("SETUP_CONNECT_OUTCOME_UNKNOWN");
    if (current.connectors.secureMcp.runtime?.state === "ready") {
      await connection
        .locator('.setup-success[role="status"]')
        .filter({ hasText: "Connected" })
        .waitFor({ state: "visible" });
      return current;
    }
    if (Date.now() >= deadline) throw new Error("SETUP_CONNECT_NOT_CONFIRMED");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A single Disconnect click is confirmed only by a fresh saved-state read.
// Unknown and timeout outcomes are terminal; this helper never clicks again.
export async function disconnectMac(page) {
  const connection = page.locator('.setup-page[data-setup-step="connection"]');
  const before = await readSetupSettings(page);
  assert.notEqual(before.connectors.secureMcp.runtime, null);
  assert.equal(connectionOutcomeUnknown(before), false);
  await connection
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await readSetupSettings(page);
    if (connectionOutcomeUnknown(current))
      throw new Error("SETUP_DISCONNECT_OUTCOME_UNKNOWN");
    if (current.connectors.secureMcp.runtime === null) return current;
    if (Date.now() >= deadline)
      throw new Error("SETUP_DISCONNECT_NOT_CONFIRMED");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// These exact journeys relied on UI deliberately removed by the Setup redesign.
// Fail before navigation or dispatch so a retired assertion cannot be counted as
// current native coverage. Current controls and unknown fences are covered by
// tests/renderer/{setup-wizard,settings}.test.tsx; native requalification is separate.
const retiredActions = {
  "Add workspace…":
    "The workspace-detail approval/receipt form was replaced by workspace rows and + Add workspace.",
  "Verify workspace":
    "The workspace-detail verification receipt was replaced by row-level Check access and Works status.",
  "Save & connect":
    "The separate save form was replaced by the Connect this Mac form; use connectMac for new journeys.",
  "Connect this Mac":
    "The former action label is now the step title; use connectMac for the Connect submit.",
  "Check connection":
    "The separate local check action was folded into Connect.",
  "Check attachment":
    "External challenge confirmation was replaced by Test in ChatGPT; these are different one-shot journeys.",
  "Save file permissions":
    "The advanced This Mac policy form was removed; workspace rows own access and Commands.",
  "Stop connection":
    "The advanced connection controls were removed; use disconnectMac for the current Disconnect control.",
  Disconnect:
    "The old Settings receipt observer cannot prove the current Disconnect action; use disconnectMac.",
};
function retired(journey, reason) {
  throw new Error(`E2E_JOURNEY_RETIRED:${journey}: ${reason}`);
}
// Check access binds its one click and fresh receipt to the selected row. The
// single-workspace shorthand remains available; multiple rows need an exact ID.
export async function setupAction(page, name, { workspaceId } = {}) {
  if (name === "+ Add workspace" || name === "Check access") {
    const before = await readSetupSettings(page);
    assert.equal(connectionOutcomeUnknown(before), false);
    const target =
      name === "Check access"
        ? workspaceId === undefined && before.computer.workspaces.length === 1
          ? before.computer.workspaces[0]
          : before.computer.workspaces.find(
              (workspace) => workspace.workspaceId === workspaceId,
            )
        : null;
    if (name === "Check access")
      assert.ok(
        target,
        workspaceId === undefined
          ? "SETUP_WORKSPACE_TARGET_REQUIRED"
          : `SETUP_WORKSPACE_TARGET_MISSING:${workspaceId}`,
      );
    const scope = target
      ? page
          .locator(".setup-workspace-row")
          .filter({ has: page.getByText(target.root, { exact: true }) })
      : page.locator(".setup-page");
    await scope.getByRole("button", { name, exact: true }).click();
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = await readSetupSettings(page);
      if (connectionOutcomeUnknown(current))
        throw new Error(`SETUP_ACTION_OUTCOME_UNKNOWN:${name}`);
      const checked = current.computer.workspaces.find((workspace) => {
        const prior = before.computer.workspaces.find(
          (item) => item.workspaceId === workspace.workspaceId,
        );
        return (
          workspace.accessCheck?.checkId &&
          workspace.accessCheck.checkId !== prior?.accessCheck?.checkId &&
          (!target ||
            (workspace.workspaceId === target.workspaceId &&
              workspace.root === target.root)) &&
          (name !== "+ Add workspace" || !prior)
        );
      });
      if (checked) {
        await page
          .locator(".setup-workspace-row")
          .filter({ has: page.getByText(checked.root, { exact: true }) })
          .locator(".setup-success")
          .filter({ hasText: "Works" })
          .waitFor({ state: "visible" });
        return current;
      }
      if (Date.now() >= deadline)
        throw new Error(`SETUP_ACTION_UNCONFIRMED:${name}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(
    Object.hasOwn(retiredActions, name),
    `SETUP_ACTION_UNSUPPORTED:${name}`,
  );
  retired(name, retiredActions[name]);
}
export function assertSetupOverviewEvidence() {
  retired(
    "setup-overview-evidence",
    "The optional-sign-in readiness checklist and Open Home card were removed; Setup now has a welcome screen and required linear steps.",
  );
}
export async function assertSetupOverview() {
  retired(
    "setup-overview",
    "The Setup overview checklist, optional sign-in badges and Open Home action were removed; use the welcome/progress UI in new journeys.",
  );
}
export async function reviewSetupWithoutChanges() {
  retired(
    "review-setup-retained-actions",
    "Review Setup and the Diagnostics retained-action list were removed; General now exposes Open Setup and the renderer retains outcome fences.",
  );
}

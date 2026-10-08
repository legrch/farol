// Current built React surface only. These helpers navigate and observe; the
// caller owns disposable profiles, native processes and fixture receipts.
import assert from "node:assert/strict";

export async function waitForReactShell(page) {
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .waitFor();
  await page.locator(".toolbar-title strong").waitFor();
  await page.waitForFunction(() => {
    const main = document.querySelector("main.stage");
    return main && !main.textContent.includes("Connecting to Farol…");
  });
}

export async function openSetup(page) {
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "Setup", exact: true })
    .click();
  await page.locator(".setup-page").waitFor({ state: "visible" });
}

export async function setupStep(page, step, label) {
  await page
    .getByRole("navigation", { name: "Setup steps", exact: true })
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.locator(`.setup-page[data-setup-step="${step}"]`).waitFor();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Setup steps", exact: true })
      .getByRole("button", { name: label, exact: true })
      .getAttribute("aria-current"),
    "step",
  );
}

export async function readSetupSettings(page) {
  const bootstrap = await page.evaluate(() => window.farolNext.bootstrap());
  assert.equal(bootstrap.configuration.status, "ready");
  return bootstrap.configuration.settings;
}

// One click only. A refusal, unknown result or timeout fails this journey;
// observation never resubmits the command or chooses another executor.
export async function setupAction(page, name) {
  await page
    .locator(".setup-page")
    .getByRole("button", { name, exact: true })
    .click();
  if (name === "Verify workspace") {
    // The selected workspace owns its action receipt. Do not infer success
    // from the old page-wide feedback, which intentionally excludes it.
    const feedback = page.locator(
      '.setup-page .workspace-detail .workspace-feedback p[role="status"]',
    );
    await feedback
      .filter({
        hasText:
          "Verify workspace: Action confirmed. Check the current status below.",
      })
      .waitFor();
    assert.equal(
      await feedback
        .filter({ hasText: "Verify workspace: " })
        .last()
        .innerText(),
      "Verify workspace: Action confirmed. Check the current status below.",
      `SETUP_ACTION_UNCONFIRMED:${name}`,
    );
    return;
  }
  await page.waitForFunction(() => {
    const feedback = document.querySelector(
      '.setup-page .settings-page > p[role="status"]',
    );
    return feedback && feedback.textContent !== "Saving or checking…";
  });
  assert.equal(
    await page
      .locator('.setup-page .settings-page > p[role="status"]')
      .innerText(),
    name === "Add folder…"
      ? "Selection received. Confirm read-only access below to add it."
      : name === "Add selected folder read-only"
        ? "Approval request completed. Only folders in the approved list below have saved access."
        : "Action confirmed. Check the current status below.",
    `SETUP_ACTION_UNCONFIRMED:${name}`,
  );
}

export async function assertSetupFinish(page, ready) {
  await setupStep(page, "finish", "Finish");
  const finish = page.getByRole("region", {
    name: "Computer setup status",
    exact: true,
  });
  await finish
    .getByRole("heading", {
      name: ready ? "Computer ready" : "A few checks remain",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await finish
      .getByRole("button", {
        name: "Continue setup",
        exact: true,
      })
      .count(),
    ready ? 0 : 1,
  );
}

export async function reviewSetupWithoutChanges(page, ready) {
  const before = await readSetupSettings(page);
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings navigation", exact: true })
    .getByRole("button", { name: "General", exact: true })
    .click();
  await page.getByRole("button", { name: "Review Setup", exact: true }).click();
  await page.locator(".setup-page").waitFor();
  for (const [step, label] of [
    ["connection", "Connection"],
    ["folders", "Workspaces"],
    ["attachment", "Add to ChatGPT"],
  ])
    await setupStep(page, step, label);
  await assertSetupFinish(page, ready);
  assert.deepEqual(
    await readSetupSettings(page),
    before,
    "REVIEW_SETUP_CHANGED_CONFIGURATION",
  );
}

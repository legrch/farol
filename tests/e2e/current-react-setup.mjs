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
  const expectedFeedback =
    {
      "Add workspace…":
        "Selection received. Confirm read-only access below to add it.",
      "Add selected workspace read-only":
        "Approval request completed. Only workspaces in the approved list below have saved access.",
      "Save & connect":
        "Credentials saved. The connection step did not complete. Review its status before another action; keep the saved key.",
      "Connect this Mac":
        "Local connection started. Verify Farol in ChatGPT to confirm external access.",
      "Check connection":
        "Local connection checked. Access from ChatGPT has a separate verification.",
    }[name] ?? "Action confirmed. Check the current status below.";
  assert.equal(
    await page
      .locator('.setup-page .settings-page > p[role="status"]')
      .innerText(),
    expectedFeedback,
    `SETUP_ACTION_UNCONFIRMED:${name}`,
  );
}

const setupSteps = [
  ["overview", "Overview"],
  ["signin", "Sign in"],
  ["folders", "Workspaces"],
  ["connection", "Connection"],
  ["attachment", "Add to ChatGPT"],
];
const checkStatus = {
  verified: "Verified",
  needed: "Not checked",
  pending: "Check in progress",
  unknown: "Result needs review",
  unavailable: "Status unavailable",
};

// Validate observed UI evidence, not a fixture's claim or an absent status.
// The caller declares each expected row and independent Computer readiness.
export function assertSetupOverviewEvidence(observed, expected) {
  assert.equal(typeof expected.ready, "boolean");
  assert.deepEqual(
    Object.keys(expected.states).sort(),
    setupSteps
      .slice(1)
      .map(([step]) => step)
      .sort(),
  );
  assert.deepEqual(
    observed.steps,
    setupSteps.map(([, label]) => label),
  );
  assert.deepEqual(observed.currentSteps, ["Overview"]);
  assert.equal(observed.obsoleteCount, 0, "OBSOLETE_SETUP_FINISH_SURFACE");
  assert.deepEqual(
    observed.rows,
    setupSteps.slice(1).map(([step, label]) => {
      const state = expected.states[step];
      assert.ok(
        Object.hasOwn(checkStatus, state),
        `SETUP_STATE_INVALID:${step}`,
      );
      return {
        step,
        label,
        optional: step === "signin",
        state,
        status: checkStatus[state],
        navigationState: state,
        navigationStatus: checkStatus[state],
      };
    }),
    "SETUP_OVERVIEW_EVIDENCE_MISMATCH",
  );
  if (expected.ready)
    for (const step of ["folders", "connection", "attachment"])
      assert.equal(
        expected.states[step],
        "verified",
        `COMPUTER_NOT_READY:${step}`,
      );
  assert.deepEqual(
    observed.openHome,
    expected.ready
      ? { count: 1, visible: true, disabled: false }
      : { count: 0, visible: false, disabled: false },
    "SETUP_OPEN_HOME_READINESS_MISMATCH",
  );
}

export async function assertSetupOverview(page, expected) {
  await setupStep(page, "overview", "Overview");
  await page
    .getByRole("region", { name: "Setup overview", exact: true })
    .waitFor();
  const observed = await page.evaluate(() => {
    const setup = document.querySelector(
      '.setup-page[data-setup-step="overview"]',
    );
    const navigation = document.querySelector('[aria-label="Setup steps"]');
    const buttons = [...navigation.querySelectorAll("button")];
    const overview = setup.querySelector('[aria-label="Setup overview"]');
    const home = [...overview.querySelectorAll("button")].filter(
      (button) => button.textContent.trim() === "Open Home",
    );
    return {
      steps: buttons.map((button) => button.getAttribute("aria-label")),
      currentSteps: buttons
        .filter((button) => button.getAttribute("aria-current") === "step")
        .map((button) => button.getAttribute("aria-label")),
      obsoleteCount:
        setup.querySelectorAll(
          '.setup-finish, [aria-label="Computer setup status"]',
        ).length +
        [...setup.querySelectorAll("button")].filter(
          (button) => button.textContent.trim() === "Finish",
        ).length,
      rows: [...overview.querySelectorAll(".setup-checklist-row")].map(
        (row) => {
          const heading = row.querySelector("h2");
          const status = row.querySelector(".setup-check-status");
          const label = heading?.firstChild?.textContent.trim();
          const button = buttons.find(
            (button) => button.getAttribute("aria-label") === label,
          );
          return {
            step: row.getAttribute("data-setup-check"),
            label,
            optional: row.querySelectorAll(".setup-optional-tag").length === 1,
            state: status?.getAttribute("data-check-state"),
            status: status?.textContent.trim(),
            navigationState: button
              ?.querySelector("[data-check-state]")
              ?.getAttribute("data-check-state"),
            navigationStatus: button?.getAttribute("aria-description"),
          };
        },
      ),
      openHome: {
        count: home.length,
        visible: home.some((button) => button.checkVisibility()),
        disabled: home.some((button) => button.disabled),
      },
    };
  });
  assertSetupOverviewEvidence(observed, expected);
}

export async function reviewSetupWithoutChanges(page, expected) {
  const before = await readSetupSettings(page);
  const retainedBefore = await readRetainedSetupActions(page);
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
  // Visiting Sign in is navigation only; never click its account action.
  for (const [step, label] of setupSteps) await setupStep(page, step, label);
  await assertSetupOverview(page, expected);
  assert.deepEqual(
    await readSetupSettings(page),
    before,
    "REVIEW_SETUP_CHANGED_CONFIGURATION",
  );
  assert.deepEqual(
    await readRetainedSetupActions(page),
    retainedBefore,
    "REVIEW_SETUP_LOST_OR_CHANGED_ORIGINAL_RESULTS",
  );
  await openSetup(page);
  await assertSetupOverview(page, expected);
}

// Observe the existing content-free diagnostics projection. Full typed receipt
// retention and zero command dispatch are separately covered by the renderer
// regression; this DOM observation is not an IPC dispatch counter.
async function readRetainedSetupActions(page) {
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings navigation", exact: true })
    .getByRole("button", { name: "Diagnostics", exact: true })
    .click();
  const details = page.locator("details").filter({
    has: page.getByText("Action details", { exact: true }),
  });
  if (!(await details.evaluate((element) => element.open)))
    await details.getByText("Action details", { exact: true }).click();
  return page
    .getByRole("list", { name: "Retained actions", exact: true })
    .locator("li")
    .allTextContents();
}

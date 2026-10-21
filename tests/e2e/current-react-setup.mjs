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
  const bootstrap = await page.evaluate(() => window.farol.bootstrap());
  assert.equal(bootstrap.configuration.status, "ready");
  return bootstrap.configuration.settings;
}

// One click only. A refusal, unknown result or timeout fails this journey;
// observation never resubmits the command or chooses another executor.
export async function setupAction(page, name, { scope = ".setup-page" } = {}) {
  const messages = {
    "Save & connect":
      "Connection started. Credentials are saved. Verify Farol in ChatGPT to finish connecting this Mac.",
    "Connect this Mac":
      "Local connection started. Verify Farol in ChatGPT to confirm external access.",
    "Check connection":
      "Local connection checked. Access from ChatGPT has a separate verification.",
    "Check attachment":
      "Attachment checked. The current workspace and connection checks passed.",
    "Save file permissions":
      "Request completed. Review its recorded result in Diagnostics and the current status below.",
    "Stop connection":
      "Request completed. Review its recorded result in Diagnostics and the current status below.",
  };
  const verify = name === "Verify workspace";
  const add = name === "Add workspace…";
  assert.ok(
    verify || add || Object.hasOwn(messages, name),
    `SETUP_ACTION_UNSUPPORTED:${name}`,
  );
  let expected = messages[name];
  let before;
  if (verify || add) before = await readSetupSettings(page);
  if (verify) {
    const root = await page
      .locator(`${scope} .workspace-detail:visible .workspace-path code`)
      .innerText();
    const workspace = before.computer.workspaces.find(
      (item) => item.root === root,
    );
    assert.ok(workspace, "SETUP_WORKSPACE_NOT_SAVED");
    assert.ok(
      ["read", "write"].includes(workspace.access),
      "SETUP_WORKSPACE_ACCESS_INVALID",
    );
    expected = `Verify workspace: Workspace access checked: ${workspace.root}. Saved access: ${workspace.access === "read" ? "Read-only" : "Read & write"}.`;
  }
  // Arm before the original click. Retained feedback is not a new result, and
  // a later refresh must not erase the first observed refusal/unknown outcome.
  // This watches presentation only; it does not query or replay an operation.
  const observation = await page.evaluateHandle(
    ({ scope, verify, add }) => {
      const container = document.querySelector(scope);
      if (!container) throw new Error("SETUP_ACTION_SURFACE_MISSING");
      const read = () =>
        [
          ...container.querySelectorAll(
            verify
              ? '.workspace-detail .workspace-feedback p[role="status"]'
              : add
                ? '.workspace-detail .workspace-feedback p[role="status"], .settings-page > p[role="status"], .settings-page > .workspace-activity > p[role="status"]'
                : '.settings-page > p[role="status"]',
          ),
        ]
          .filter((node) => {
            const surface = node.closest(".workspace-detail, .settings-page");
            if (!surface?.checkVisibility()) return false;
            if (node.checkVisibility()) return true;
            // Successful receipts live inside closed disclosures. Observe only
            // their direct receipt children on an otherwise visible surface;
            // dormant Settings pages and hidden workspace cards stay excluded.
            const disclosure = node.parentElement;
            return (
              disclosure?.matches(
                "details.workspace-technical, details.workspace-activity",
              ) &&
              !disclosure.open &&
              disclosure.checkVisibility()
            );
          })
          // Add composes selection, approval, verification and connection. A
          // previous access edit or removal is never a result of that action,
          // even if its caption changes as the workspace generation changes.
          .filter(
            (node) =>
              !add ||
              !node.closest(".workspace-detail") ||
              !/^(?:Save access|Remove workspace): /u.test(node.textContent),
          )
          .map((node) => node.textContent)
          .filter((text) => !verify || text.startsWith("Verify workspace: "))
          .map((text) =>
            add ? text.replace(/^Verify workspace: /u, "") : text,
          );
      const pending = verify
        ? "Verify workspace: Saving or checking…"
        : "Saving or checking…";
      const previous = JSON.stringify(read());
      const observation = { result: null, observer: null };
      let changed = false;
      observation.observer = new MutationObserver(() => {
        if (observation.result !== null) return;
        if (!container.isConnected) {
          observation.result = ["SETUP_ACTION_SURFACE_LOST"];
          return;
        }
        const current = read();
        changed ||= JSON.stringify(current) !== previous;
        const intermediate =
          add &&
          current.every(
            (text) =>
              text === pending ||
              text === "Workspace selected. Saving access…" ||
              /^Workspace access (?:saved|checked): /u.test(text) ||
              text ===
                "Local connection started. Verify Farol in ChatGPT to confirm external access.",
          );
        if (
          changed &&
          current.length &&
          (!current.includes(pending) || (add && !intermediate))
        ) {
          // Adding composes pick, save, access checks and optional connection.
          // Keep the first refusal/unknown; only known intermediate successes
          // may wait for the original composed button to become idle.
          if (
            !intermediate ||
            container.querySelector(".workspace-add button")?.textContent ===
              "Add workspace…"
          )
            observation.result = current;
        }
      });
      observation.observer.observe(container, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      return observation;
    },
    { scope, verify, add },
  );
  try {
    await page
      .locator(scope)
      .getByRole("button", { name, exact: true })
      .click();
    await page.waitForFunction((value) => value.result !== null, observation);
    let observed = await observation.evaluate((value) => value.result);
    if (add) {
      const after = await readSetupSettings(page);
      const added = after.computer.workspaces.filter(
        (item) =>
          !before.computer.workspaces.some(
            (prior) => prior.workspaceId === item.workspaceId,
          ),
      );
      assert.equal(added.length, 1, "SETUP_ADDED_WORKSPACE_UNCONFIRMED");
      assert.equal(
        added[0].access,
        "write",
        "SETUP_ADDED_WORKSPACE_NOT_READ_WRITE",
      );
      const check = after.setup.computer;
      assert.equal(
        check.verified?.workspaceId,
        added[0].workspaceId,
        "SETUP_ADDED_WORKSPACE_NOT_VERIFIED",
      );
      assert.equal(check.verified.configRevision, after.computer.generation);
      assert.equal(check.reachable, "reachable");
      assert.equal(check.outcomeUnknown, false);
      expected =
        after.connectors.secureMcp.runtime?.state === "ready"
          ? messages["Connect this Mac"]
          : `Workspace access checked: ${added[0].root}. Saved access: Read & write.`;
      if (
        after.connectors.secureMcp.runtime?.state === "ready" &&
        observed.length === 2
      ) {
        const checked = `Workspace access checked: ${added[0].root}. Saved access: Read & write.`;
        // The current folder receipt may remain visible beside the composed
        // connection result. Accept only that exact additional success.
        if (observed.includes(expected) && observed.includes(checked))
          observed = [expected];
      }
    }
    assert.deepEqual(observed, [expected], `SETUP_ACTION_UNCONFIRMED:${name}`);
  } finally {
    await observation.evaluate((value) => value.observer.disconnect());
    await observation.dispose();
  }
}

const setupSteps = [
  ["overview", "Overview"],
  ["signin", "Sign in"],
  ["folders", "Folders"],
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
// Optional Sign in reports the current page sample or its original operation
// outcome. Generic Computer captions cannot stand in for that evidence.
const signInStatus = {
  authenticated: { state: "verified", status: "Signed in" },
  signed_out: { state: "needed", status: "Signed out" },
  pending: { state: "pending", status: "Checking sign-in…" },
  unknown: { state: "needed", status: "Sign-in not checked" },
  unavailable: { state: "unavailable", status: "Sign-in not checked" },
  outcome_unknown: { state: "unknown", status: "Outcome unknown" },
};

// Validate observed UI evidence, not a fixture's claim or an absent status.
// The caller declares each expected row and independent Computer readiness.
export function assertSetupOverviewEvidence(observed, expected) {
  assert.equal(typeof expected.ready, "boolean");
  assert.equal(typeof expected.signIn, "string", "SETUP_SIGNIN_STATUS_MISSING");
  assert.ok(
    Object.hasOwn(signInStatus, expected.signIn),
    "SETUP_SIGNIN_STATUS_INVALID",
  );
  const signIn = signInStatus[expected.signIn];
  assert.equal(
    expected.states.signin,
    signIn.state,
    "SETUP_SIGNIN_STATE_MISMATCH",
  );
  assert.equal(
    typeof expected.hasWorkspaces,
    "boolean",
    "SETUP_WORKSPACE_SELECTION_MISSING",
  );
  if (!expected.hasWorkspaces)
    assert.notEqual(
      expected.states.folders,
      "verified",
      "SETUP_EMPTY_WORKSPACE_FILE_PROOF",
    );
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
      const status =
        step === "signin"
          ? signIn.status
          : state === "verified" && step === "connection"
            ? "Local connection ready"
            : state === "verified" && step === "attachment"
              ? "Verified from ChatGPT"
              : step === "folders" &&
                  !expected.hasWorkspaces &&
                  state === "needed"
                ? "No workspace access enabled"
                : checkStatus[state];
      return {
        step,
        label,
        optional:
          step === "signin" || (step === "folders" && !expected.hasWorkspaces),
        state,
        status,
        navigationState: state,
        navigationStatus: status,
      };
    }),
    "SETUP_OVERVIEW_EVIDENCE_MISMATCH",
  );
  if (expected.ready)
    for (const step of [
      ...(expected.hasWorkspaces ? ["folders"] : []),
      "connection",
      "attachment",
    ])
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

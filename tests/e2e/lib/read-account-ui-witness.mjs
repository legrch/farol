import assert from "node:assert/strict";
import {
  previewWitness,
  readCanary,
} from "../fixtures/go-read-discard-witness.mjs";

// Observes the public React surface only. No controller access, replacement
// preload, injected response, provider clone or Send is needed by this witness.
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const title = "Read-only file preview";
export const readAccountLimits = Object.freeze([
  "Synthetic GET /api/auth/session through actual ChatGptRoute.observeAccount and the normal explicit Go approval composition; not live authentication, entitlement, model qualification or atomic provider binding",
  "No independent Go account-approval RPC counter is exposed. Zero extra GETs plus the source-bound ReadAccountConfirmation cached original command contract support no reapproval; unchanged ChatTurn journal alone does not prove that private in-memory grant was untouched. Lead must bind this inference to the exact integrated production source",
  "React receipts expose safe metadata and account state, not a principal or confirmation ID. A duplicate inspect is permitted only after independently observed exact UI success, to read the original confirmation receipt; an approved duplicate follows only independently observed exact UI confirmation",
  "Same-revision Refresh status is clicked in Diagnostics; the public UI has no refresh-completion receipt. Retained exact metadata, current Diagnostics and independent settings/journals are observed on returning Home; no claim about transient refresh timing",
]);

export function accountLedgerWitness(ledger, expectedGets, session) {
  assert.equal(ledger.attemptedSends, 0, "ACCOUNT_SEND_ATTEMPTED");
  assert.equal(ledger.acceptedSends, 0, "ACCOUNT_SEND_ACCEPTED");
  assert.deepEqual(ledger.ledger, [], "ACCOUNT_SEND_LEDGER_NONEMPTY");
  assert.deepEqual(ledger.turns, [], "ACCOUNT_PROVIDER_TURN_CREATED");
  assert.ok(
    Number.isSafeInteger(expectedGets) &&
      expectedGets >= 0 &&
      expectedGets <= 2,
  );
  assert.equal(ledger.accountGets, expectedGets, "ACCOUNT_GET_COUNT_CHANGED");
  assert.deepEqual(
    ledger.accountSession,
    session,
    "ACCOUNT_FIXTURE_SESSION_CHANGED",
  );
}

export async function readAccountUi(window) {
  return window.locator(`section[aria-label="${title}"]`).evaluate(
    (section) => {
      const metadata = section.querySelector(
        'section[aria-label="Selected file metadata"]',
      );
      const details = metadata?.querySelector("details");
      return {
        text: section.textContent,
        heading: metadata?.querySelector("h3")?.textContent ?? null,
        counts: metadata?.querySelector("p")?.textContent ?? null,
        operationId: details?.querySelector("code")?.textContent ?? null,
        revision: details
          ? ([...details.querySelectorAll("p")].find((p) =>
              p.textContent?.startsWith("Configuration revision:"),
            )?.textContent ?? null)
          : null,
        expiresAt:
          metadata?.querySelector("time")?.getAttribute("datetime") ?? null,
        folder: section.querySelector("select")
          ? {
              value: section.querySelector("select").value,
              disabled: section.querySelector("select").disabled,
              options: [...section.querySelectorAll("select option")].map(
                (option) => ({
                  value: option.value,
                  label: option.textContent,
                }),
              ),
            }
          : null,
        buttons: [...section.querySelectorAll("button")].map((button) => ({
          name: button.textContent.trim(),
          disabled: button.disabled,
        })),
        alerts: [...section.querySelectorAll('[role="alert"]')].map(
          (node) => node.textContent,
        ),
      };
    },
    undefined,
    { timeout: 5000 },
  );
}

export function accountUiWitness(
  ui,
  workspace,
  phase,
  original,
  forbidden = [],
) {
  assert.ok(["prepared", "observed", "approved"].includes(phase));
  assert.equal(typeof ui.text, "string");
  assert.ok(ui.text.length < 8192, "ACCOUNT_UI_UNBOUNDED");
  for (const value of [
    ...readCanary.text.split("\n").filter(Boolean),
    ...forbidden,
  ])
    assert.equal(
      ui.text.includes(value),
      false,
      "ACCOUNT_UI_PRIVATE_DATA_EXPOSED",
    );
  assert.deepEqual(ui.alerts, [], "ACCOUNT_UI_ALERT");
  assert.doesNotMatch(
    ui.text,
    /unknown|refused|unavailable|could not be confirmed/iu,
    "ACCOUNT_UI_UNCONFIRMED",
  );
  assert.equal(ui.heading, `${workspace.label} / ${readCanary.relativePath}`);
  assert.match(ui.operationId ?? "", uuid, "ACCOUNT_UI_OPERATION_INVALID");
  assert.match(ui.revision ?? "", /^Configuration revision: [1-9][0-9]*$/u);
  const revision = Number(ui.revision.slice("Configuration revision: ".length));
  assert.ok(Number.isSafeInteger(revision));
  const counts = /^(\d+) bytes · (\d+) of (\d+) context characters$/u.exec(
    ui.counts ?? "",
  );
  assert.ok(counts, "ACCOUNT_UI_COUNTS_INVALID");
  const preview = {
    kind: "chatgpt.readonly-task-preview",
    operationId: ui.operationId,
    workspaceId: workspace.workspaceId,
    workspaceLabel: workspace.label,
    relativePath: readCanary.relativePath,
    bytes: Number(counts[1]),
    contextCharacters: Number(counts[2]),
    contextLimit: Number(counts[3]),
    contextTruncated: false,
    excludedPaths: [],
    expiresAt: ui.expiresAt,
  };
  assert.ok(
    ui.text.includes(
      "No custom exclusions. Credential defaults remain denied.",
    ),
  );
  assert.equal(ui.text.includes("Context is truncated."), false);
  previewWitness(preview, workspace);
  assert.equal(new Date(preview.expiresAt).toISOString(), preview.expiresAt);
  const receipt = { revision, preview };
  if (original)
    assert.deepEqual(receipt, original, "ACCOUNT_UI_ORIGINAL_CHANGED");
  assert.ok(ui.folder && ui.folder.disabled, "ACCOUNT_UI_FOLDER_NOT_FENCED");
  // After remount the form's local selection may be empty. The retained receipt
  // above must still name the original folder and file exactly.
  assert.ok(
    ui.folder.value === "" || ui.folder.value === workspace.workspaceId,
  );
  const button = (name, disabled) => {
    const matches = ui.buttons.filter((item) => item.name === name);
    assert.equal(matches.length, 1, "ACCOUNT_UI_BUTTON_MISSING_OR_DUPLICATED");
    assert.equal(
      matches[0].disabled,
      disabled,
      "ACCOUNT_UI_BUTTON_STATE_CHANGED",
    );
  };
  button("Choose file…", true);
  button("Discard preview", false);
  button("Open ChatGPT", false);
  if (phase !== "approved")
    assert.equal(
      ui.text.includes(
        "Account confirmed for this preview. Nothing has been sent.",
      ),
      false,
      "ACCOUNT_UI_FALSE_APPROVAL",
    );
  const inspect = ui.buttons.filter(
    (item) => item.name === "Inspect current account",
  );
  const confirm = ui.buttons.filter((item) => item.name === "Use this account");
  if (phase === "prepared") {
    assert.equal(
      ui.folder.value,
      workspace.workspaceId,
      "ACCOUNT_UI_SELECTED_FOLDER_CHANGED",
    );
    button("Inspect current account", false);
    assert.deepEqual(confirm, []);
  } else if (phase === "observed") {
    assert.deepEqual(inspect, []);
    button("Use this account", false);
    assert.equal(
      ui.text.includes(
        "Account confirmed for this preview. Nothing has been sent.",
      ),
      false,
    );
  } else {
    assert.deepEqual(inspect, []);
    assert.deepEqual(confirm, []);
    assert.ok(
      ui.text.includes(
        "Account confirmed for this preview. Nothing has been sent.",
      ),
    );
  }
  assert.equal(
    ui.buttons.some((item) => /send|submit/iu.test(item.name)),
    false,
    "ACCOUNT_UI_SEND_CONTROL",
  );
  return receipt;
}

export function accountReplyWitness(
  reply,
  configured,
  original,
  phase,
  confirmationId,
) {
  assert.equal(reply.ok, true, "ACCOUNT_ORIGINAL_COMMAND_UNCONFIRMED");
  assert.deepEqual(
    reply.snapshot.settings,
    configured,
    "ACCOUNT_CONFIGURATION_CHANGED",
  );
  const account = reply.evidence?.account;
  assert.ok(account && typeof account === "object", "ACCOUNT_RECEIPT_MISSING");
  assert.deepEqual(Object.keys(account).sort(), ["confirmationId", "state"]);
  assert.match(account.confirmationId, uuid, "ACCOUNT_CONFIRMATION_ID_INVALID");
  assert.equal(account.state, phase, "ACCOUNT_STATE_UNCONFIRMED");
  if (confirmationId)
    assert.equal(
      account.confirmationId,
      confirmationId,
      "ACCOUNT_CONFIRMATION_CROSSED",
    );
  const { account: _account, ...metadata } = reply.evidence;
  assert.deepEqual(
    metadata,
    original.preview,
    "ACCOUNT_RECEIPT_ORIGINAL_CHANGED",
  );
  assert.equal(reply.snapshot.settings.revision, original.revision);
  return account.confirmationId;
}

export async function accountUiAction(window, name, after) {
  const section = window.locator(`section[aria-label="${title}"]`);
  const button = section.getByRole("button", { name, exact: true });
  assert.equal(
    await button.isEnabled({ timeout: 5000 }),
    true,
    "ACCOUNT_UI_ACTION_DISABLED",
  );
  await button.click({ timeout: 5000 }); // Exactly one action, never retried.
  // Waiting observes only; an unknown/refused result never triggers another click.
  await window.waitForFunction(
    ({ after, title }) => {
      const section = document.querySelector(`section[aria-label="${title}"]`);
      const text = section?.textContent ?? "";
      return (
        /unknown|refused|could not be confirmed/iu.test(text) ||
        (after === "approved"
          ? text.includes(
              "Account confirmed for this preview. Nothing has been sent.",
            ) &&
            [...(section?.querySelectorAll("button") ?? [])].some(
              (button) =>
                button.textContent.trim() === "Discard preview" &&
                !button.disabled,
            )
          : after === "discarded"
            ? text.includes("The exact preview was discarded.")
            : [...(section?.querySelectorAll("button") ?? [])].some(
                (button) =>
                  button.textContent.trim() === after && !button.disabled,
              ))
      );
    },
    { after, title },
    { timeout: 20000 },
  );
}

export async function refreshAccountUi(window, revision) {
  assert.ok(Number.isSafeInteger(revision) && revision >= 0);
  await window
    .getByRole("button", { name: "Settings", exact: true })
    .click({ timeout: 5000 });
  await window
    .locator(".contextual-sidebar")
    .getByRole("button", { name: "Diagnostics", exact: true })
    .click({ timeout: 5000 });
  const diagnostics = window
    .locator(".settings-page > div:not([hidden])")
    .filter({
      has: window.getByRole("heading", { name: "Diagnostics", exact: true }),
    });
  await diagnostics
    .getByRole("button", { name: "Refresh status", exact: true })
    .click({ timeout: 5000 });
  // Preload setup commands bypass the window controller's command receipts.
  // Observe its adoption through the real UI before choosing a verified folder.
  await diagnostics
    .getByText(`Configuration revision: ${revision}.`)
    .waitFor({ state: "visible", timeout: 5000 });
  return diagnostics.textContent();
}

export function readAccountSelfTest(pass, reject) {
  const session = {
    user: { id: "synthetic-user" },
    account: { id: "synthetic-account" },
    expires: "2099-10-04T12:00:00.000Z",
  };
  const ledger = {
    accountSession: session,
    accountGets: 1,
    attemptedSends: 0,
    acceptedSends: 0,
    ledger: [],
    turns: [],
  };
  pass(() => accountLedgerWitness(ledger, 1, session));
  for (const change of [
    { accountGets: 2 },
    { accountGets: undefined },
    { attemptedSends: 1 },
    { acceptedSends: 1 },
    { ledger: [{}] },
    { turns: [{}] },
    { accountSession: null },
  ])
    reject(() => accountLedgerWitness({ ...ledger, ...change }, 1, session));
  const workspace = {
    workspaceId: "workspace",
    label: "Synthetic read folder",
    root: "/synthetic/workspace",
    excludedPaths: [],
  };
  const operationId = "12345678-1234-4234-8234-123456789abc";
  const confirmationId = "77777777-7777-4777-8777-777777777777";
  const ui = {
    text: "No custom exclusions. Credential defaults remain denied.",
    heading: `${workspace.label} / ${readCanary.relativePath}`,
    counts: `${Buffer.byteLength(readCanary.text)} bytes · ${readCanary.text.length} of 24000 context characters`,
    operationId,
    revision: "Configuration revision: 4",
    expiresAt: "2099-10-04T12:00:00.000Z",
    folder: { value: workspace.workspaceId, disabled: true },
    alerts: [],
    buttons: [
      { name: "Choose file…", disabled: true },
      { name: "Open ChatGPT", disabled: false },
      { name: "Discard preview", disabled: false },
      { name: "Inspect current account", disabled: false },
    ],
  };
  const original = accountUiWitness(ui, workspace, "prepared");
  const observed = {
    ...ui,
    folder: { value: "", disabled: true },
    buttons: [
      ...ui.buttons.slice(0, 3),
      { name: "Use this account", disabled: false },
    ],
  };
  const approved = {
    ...observed,
    buttons: observed.buttons.slice(0, 3),
    text: `${ui.text} Account confirmed for this preview. Nothing has been sent.`,
  };
  for (const [value, phase] of [
    [ui, "prepared"],
    [observed, "observed"],
    [approved, "approved"],
  ])
    pass(() =>
      accountUiWitness(value, workspace, phase, original, [
        session.user.id,
        session.account.id,
      ]),
    );
  // Initial Prepare cannot adopt unsolicited account state. Preserve the
  // selected folder here so rejection specifically tests the account controls
  // and approval projection, rather than an unrelated empty remount selection.
  for (const unsolicited of [observed, approved])
    reject(() =>
      accountUiWitness(
        { ...unsolicited, folder: ui.folder },
        workspace,
        "prepared",
        original,
      ),
    );
  for (const change of [
    { operationId: confirmationId },
    { revision: "Configuration revision: 5" },
    { heading: "Other folder / other.txt" },
    { counts: "0 bytes · 0 of 24000 context characters" },
    { expiresAt: "2099-10-05T12:00:00.000Z" },
    { alerts: ["Unknown"] },
    { text: `${ui.text} ${session.user.id}` },
    { text: `${ui.text} ${readCanary.text}` },
    { text: `${ui.text} Outcome unknown` },
    { folder: { value: "other", disabled: true } },
    { buttons: [...observed.buttons, { name: "Send", disabled: false }] },
  ])
    reject(() =>
      accountUiWitness(
        { ...observed, ...change },
        workspace,
        "observed",
        original,
        [session.user.id, session.account.id],
      ),
    );
  reject(() =>
    accountUiWitness(
      { ...ui, text: approved.text },
      workspace,
      "prepared",
      original,
    ),
  );
  reject(() =>
    accountUiWitness(
      { ...observed, text: approved.text },
      workspace,
      "observed",
      original,
    ),
  );
  reject(() =>
    accountUiWitness(
      {
        ...approved,
        buttons: approved.buttons.map((button) =>
          button.name === "Discard preview"
            ? { ...button, disabled: true }
            : button,
        ),
      },
      workspace,
      "approved",
      original,
    ),
  );
  reject(() => accountUiWitness(ui, workspace, "observed", original));
  reject(() => accountUiWitness(observed, workspace, "approved", original));
  const configured = { revision: 4 };
  const reply = {
    ok: true,
    snapshot: { settings: configured },
    evidence: {
      ...original.preview,
      account: { confirmationId, state: "observed" },
    },
  };
  pass(() =>
    assert.equal(
      accountReplyWitness(reply, configured, original, "observed"),
      confirmationId,
    ),
  );
  pass(() =>
    accountReplyWitness(
      {
        ...reply,
        evidence: {
          ...reply.evidence,
          account: { confirmationId, state: "approved" },
        },
      },
      configured,
      original,
      "approved",
      confirmationId,
    ),
  );
  for (const change of [
    { ok: false },
    { ok: false, error: "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED" },
    { ok: false, error: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID" },
    { snapshot: { settings: { revision: 5 } } },
    { evidence: { ...reply.evidence, operationId: confirmationId } },
    {
      evidence: {
        ...reply.evidence,
        account: { confirmationId, state: "approved" },
      },
    },
    {
      evidence: {
        ...reply.evidence,
        account: { confirmationId, state: "observed", principalKey: "secret" },
      },
    },
  ])
    reject(() =>
      accountReplyWitness(
        { ...reply, ...change },
        configured,
        original,
        "observed",
        confirmationId,
      ),
    );
  reject(() =>
    accountReplyWitness(reply, configured, original, "observed", operationId),
  );
}

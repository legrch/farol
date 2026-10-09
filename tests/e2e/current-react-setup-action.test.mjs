// Pure fake-page/VM evidence only: no Electron, Playwright, IPC, filesystem
// workspace inspection, provider calls or native/profile/process lifecycle.
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { setupAction } from "./current-react-setup.mjs";

const { test } = await import(process.env.VITEST ? "vitest" : "node:test");
const root = "/in-memory/approved-folder";
const workspace = { workspaceId: "owned-workspace", root, access: "read" };
const checked = (access = "read", path = root) =>
  `Verify workspace: Workspace access checked: ${path}. Saved access: ${access === "read" ? "Read-only" : "Read & write"}.`;
const attachment =
  "Attachment checked. The current workspace and connection checks passed.";
const generic = "Action confirmed. Check the current status below.";
const pending = "Saving or checking…";
const unknown =
  "Outcome unknown. Do not repeat this action; inspect the existing result in Diagnostics.";

// Execute the real browser callbacks in a separate DOM VM realm. Only the
// locator/click and bounded observation scheduler are faked; MutationObserver
// and querySelectorAll run against real in-memory DOM nodes.
function fakePage({
  name = "Verify workspace",
  access = "read",
  previous,
  events = [],
  clickError,
  before = [workspace],
  after = before,
  scope = ".setup-page",
  extraWorkspaceFeedback,
} = {}) {
  const dom = new JSDOM(
    '<main class="setup-page"><div class="settings-page"><section class="workspace-detail"><p class="workspace-path"><code></code></p><div class="workspace-feedback"></div></section></div></main>',
    { runScripts: "outside-only" },
  );
  const { document } = dom.window;
  document.querySelector("code").textContent = root;
  // jsdom has no layout. Visibility is an explicit fake-page assumption.
  dom.window.HTMLElement.prototype.checkVisibility = () => true;
  const context = dom.getInternalVMContext();
  let currentWorkspaces = before.map((item) => ({ ...item, access }));
  dom.window.farolNext = {
    bootstrap: () => ({
      configuration: {
        status: "ready",
        settings: { computer: { workspaces: currentWorkspaces } },
      },
    }),
  };
  const run = (callback, argument) => {
    context.callbackArgument = argument;
    return runInContext(`(${callback.toString()})(callbackArgument)`, context);
  };
  const verify = name === "Verify workspace";
  const addFeedback = (text, target = verify ? "workspace" : "page") => {
    const selector =
      target === "workspace" ? ".workspace-feedback" : ".settings-page";
    const parent = document.querySelector(selector);
    let node = parent.querySelector(':scope > p[role="status"]');
    if (!node) {
      node = document.createElement("p");
      node.setAttribute("role", "status");
      parent.append(node);
    }
    node.textContent = text;
  };
  if (previous !== undefined) addFeedback(previous);
  if (extraWorkspaceFeedback) {
    const node = document.createElement("p");
    node.setAttribute("role", "status");
    node.textContent = extraWorkspaceFeedback;
    document.querySelector(".workspace-feedback").append(node);
  }
  let clicks = 0;
  let disposed = 0;
  let activeObservation;
  const page = {
    evaluate: async (callback) => structuredClone(await run(callback)),
    evaluateHandle: async (callback, argument) => {
      activeObservation = run(callback, argument);
      return {
        value: activeObservation,
        evaluate: async (callback) => {
          const result = await run(callback, activeObservation);
          return result === undefined ? undefined : structuredClone(result);
        },
        dispose: async () => {
          disposed++;
        },
      };
    },
    locator: (selector) => ({
      innerText: async () => {
        assert.equal(
          selector,
          `${scope} .workspace-detail:visible .workspace-path code`,
        );
        return root;
      },
      getByRole: (role, options) => ({
        click: async () => {
          assert.equal(selector, scope);
          assert.equal(role, "button");
          assert.deepEqual(options, { name, exact: true });
          assert.ok(
            activeObservation,
            "observer must be armed before the original click",
          );
          clicks++;
          if (clickError) throw clickError;
        },
      }),
    }),
    waitForFunction: async (callback, handle) => {
      // Deliver every scripted mutation, even a late refresh after unknown.
      // The browser observer must retain the first terminal, not the last.
      for (const event of events) {
        if (typeof event === "string") addFeedback(event);
        else addFeedback(event.text, event.target);
        currentWorkspaces = after;
        await nextTurn();
      }
      if (!run(callback, handle.value))
        throw new Error("FAKE_OBSERVATION_TIMEOUT");
    },
  };
  return {
    page,
    clicks: () => clicks,
    disposed: () => disposed,
    close: () => dom.window.close(),
  };
}

async function journey(options, failure) {
  const fake = fakePage(options);
  try {
    const result = setupAction(fake.page, options?.name ?? "Verify workspace", {
      scope: options?.scope ?? ".setup-page",
    });
    if (failure) await assert.rejects(result, failure);
    else await result;
    assert.equal(
      fake.clicks(),
      1,
      "the journey must keep its original single click",
    );
    assert.equal(fake.disposed(), 1, "the observation handle must be released");
  } finally {
    fake.close();
  }
}

for (const access of ["read", "write"]) {
  test(`current specific workspace success with saved ${access} access`, async () => {
    await journey({
      access,
      events: [`Verify workspace: ${pending}`, checked(access)],
    });
  });
}

test("late original completion replaces prior unrelated feedback", async () => {
  await journey({
    previous: "Verify workspace: Prior request",
    events: [`Verify workspace: ${pending}`, checked()],
  });
});

test("repeated exact success requires an observed new transition", async () => {
  await journey({
    previous: checked(),
    events: [`Verify workspace: ${pending}`, checked()],
  });
});

test("prior exact success plus unchanged refresh cannot confirm a new action", async () => {
  await journey(
    { previous: checked(), events: [checked()] },
    /FAKE_OBSERVATION_TIMEOUT/,
  );
});

test("page-wide green feedback cannot substitute for the workspace receipt", async () => {
  await journey(
    { events: [{ target: "page", text: checked() }] },
    /FAKE_OBSERVATION_TIMEOUT/,
  );
});

for (const text of [
  `Verify workspace: ${generic}`,
  checked("read", "/in-memory/another-folder"),
  checked("write"),
  `${checked()} Additional success`,
  "Verify workspace: Workspace check request completed. A current access check is not confirmed; review the saved workspace and Diagnostics.",
]) {
  test(`reject workspace feedback: ${text}`, async () => {
    await journey(
      { events: [text] },
      /SETUP_ACTION_UNCONFIRMED:Verify workspace/,
    );
  });
}

for (const outcome of [
  unknown,
  "This action could not be completed. Review the current status or see Diagnostics for details.",
]) {
  test(`original workspace failure survives later green refresh: ${outcome}`, async () => {
    await journey(
      {
        events: [
          `Verify workspace: ${pending}`,
          `Verify workspace: ${outcome}`,
          checked(),
        ],
      },
      /SETUP_ACTION_UNCONFIRMED:Verify workspace/,
    );
  });
  test(`original attachment failure survives later green refresh: ${outcome}`, async () => {
    await journey(
      { name: "Check attachment", events: [pending, outcome, attachment] },
      /SETUP_ACTION_UNCONFIRMED:Check attachment/,
    );
  });
}

test("another workspace action receipt does not replace the verification result", async () => {
  await journey({
    extraWorkspaceFeedback:
      "Save access: Workspace access saved. Verify it again before using the new access.",
    events: [checked()],
  });
});

test("ambiguous duplicate verification receipts fail", async () => {
  await journey(
    {
      previous: "Verify workspace: Prior request",
      extraWorkspaceFeedback: checked(),
      events: [`Verify workspace: ${pending}`, checked()],
    },
    /SETUP_ACTION_UNCONFIRMED:Verify workspace/,
  );
});

test("current specific attachment success", async () => {
  await journey({
    name: "Check attachment",
    previous: "Prior feedback",
    events: [pending, attachment],
  });
});

for (const text of [
  generic,
  "Computer ready",
  `${attachment} Extra`,
  "Attachment check request completed. Current attachment is not confirmed; review the connection status and Diagnostics.",
]) {
  test(`reject attachment feedback: ${text}`, async () => {
    await journey(
      { name: "Check attachment", events: [text] },
      /SETUP_ACTION_UNCONFIRMED:Check attachment/,
    );
  });
}

test("pending original command times out without another click", async () => {
  await journey(
    { events: [`Verify workspace: ${pending}`] },
    /FAKE_OBSERVATION_TIMEOUT/,
  );
});

test("pending attachment command times out without another click", async () => {
  await journey(
    { name: "Check attachment", events: [pending] },
    /FAKE_OBSERVATION_TIMEOUT/,
  );
});

for (const [name, message] of [
  [
    "Add workspace…",
    "Selection received. Confirm read-only access below to add it.",
  ],
  [
    "Connect this Mac",
    "Local connection started. Verify Farol in ChatGPT to confirm external access.",
  ],
  [
    "Check connection",
    "Local connection checked. Access from ChatGPT has a separate verification.",
  ],
  // The existing credentials-save fault journey intentionally expects this
  // partial result, then independently asserts the retained start refusal.
  [
    "Save & connect",
    "Credentials saved. The connection step did not complete. Review its status before another action; keep the saved key.",
  ],
]) {
  test(`retain the exact existing expectation for ${name}`, async () => {
    await journey({
      name,
      previous: "Prior feedback",
      events: [pending, message],
    });
  });
}

test("platform-refused original click is propagated without retry", async () => {
  const refused = new Error("EPERM: original click refused");
  await journey({ clickError: refused }, (error) => error === refused);
});

test("new workspace approval requires the exact newly saved read-only root", async () => {
  await journey({
    name: "Add selected workspace read-only",
    before: [],
    after: [workspace],
    events: [
      pending,
      `Workspace access saved: ${root}. Saved access: Read-only. Check access before using it.`,
    ],
  });
});

test("old generic workspace approval cannot replace the specific result", async () => {
  await journey(
    {
      name: "Add selected workspace read-only",
      before: [],
      after: [workspace],
      events: [
        "Approval request completed. Only workspaces in the approved list below have saved access.",
      ],
    },
    /SETUP_ACTION_UNCONFIRMED:Add selected workspace read-only/,
  );
});

test("file policy caller observes current completion within Settings", async () => {
  await journey({
    name: "Save file permissions",
    scope: ".settings-page",
    events: [
      pending,
      "Request completed. Review its recorded result in Diagnostics and the current status below.",
    ],
  });
});

test("unsupported action has no generic-success fallback or click", async () => {
  const fake = fakePage({ name: "Unmapped command" });
  try {
    await assert.rejects(
      setupAction(fake.page, "Unmapped command"),
      /SETUP_ACTION_UNSUPPORTED/,
    );
    assert.equal(fake.clicks(), 0);
  } finally {
    fake.close();
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const helper = "../e2e/current-react-setup.mjs";
const { setupAction } = await import(helper);

// In-memory DOM and scripted bootstrap only. Execute the actual helper's page
// callbacks; no app, network, native host, filesystem or profile is involved.
type Observation = { result: string[] | null; observer: MutationObserver };
const root = "/controlled/project";
const checked = `Workspace access checked: ${root}. Saved access: Read & write.`;
const verified = `Verify workspace: ${checked}`;
const connected =
  "Local connection started. Verify Farol in ChatGPT to confirm external access.";
const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "checkVisibility",
);

beforeEach(() => {
  // jsdom has no layout. Model the relevant native checkVisibility rules:
  // display:none/hidden ancestors and non-summary content of closed details.
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value(this: Element) {
      for (
        let element: Element | null = this;
        element;
        element = element.parentElement
      ) {
        if (
          element.hasAttribute("hidden") ||
          getComputedStyle(element).display === "none"
        )
          return false;
        const parent: Element | null = element.parentElement;
        if (
          parent instanceof HTMLDetailsElement &&
          !parent.open &&
          element !== parent.querySelector("summary")
        )
          return false;
      }
      return true;
    },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (visibilityDescriptor)
    Object.defineProperty(
      Element.prototype,
      "checkVisibility",
      visibilityDescriptor,
    );
  else Reflect.deleteProperty(Element.prototype, "checkVisibility");
});

function settings(added = true, ready = false) {
  return {
    computer: {
      generation: 2,
      workspaces: added
        ? [{ workspaceId: "workspace", root, access: "write" }]
        : [],
    },
    setup: {
      computer: {
        verified: added
          ? { workspaceId: "workspace", configRevision: 2 }
          : null,
        reachable: "reachable",
        outcomeUnknown: false,
      },
    },
    connectors: {
      secureMcp: { runtime: { state: ready ? "ready" : "stopped" } },
    },
  };
}

function workspace(receipt = "") {
  return `<section class="workspace-detail">
    <div class="workspace-path"><code>${root}</code></div>
    <div class="workspace-feedback">
      <details class="workspace-technical"><summary>Access details and activity</summary>
        ${receipt ? `<p role="status">${receipt}</p>` : ""}
      </details>
    </div>
    <button>Verify workspace</button>
  </section>`;
}

function mount(receipt = "") {
  document.body.innerHTML = `<div class="setup-page"><div class="settings-page">
    <div class="workspace-add"><button>Add workspace…</button></div>
    ${workspace(receipt)}
  </div></div>`;
}

function element(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing fixture element: ${selector}`);
  return node;
}

async function feedback(text: string, technical = false) {
  element(".workspace-feedback").innerHTML = technical
    ? `<details class="workspace-technical"><summary>Access details and activity</summary><p role="status">${text}</p></details>`
    : `<p role="status">${text}</p>`;
  // Separate observer deliveries just as separate UI renders would do.
  await Promise.resolve();
}

function pageAdapter(onClick: () => Promise<void>, initial = settings()) {
  let current = initial;
  const bootstrap = vi.fn(() => ({
    configuration: { status: "ready", settings: current },
  }));
  vi.stubGlobal("farolNext", { bootstrap });
  let observation: Observation | null = null;
  let disposed = false;
  const clicks: string[] = [];
  const page = {
    async evaluate<T>(callback: () => T) {
      return callback();
    },
    async evaluateHandle(
      callback: (args: {
        scope: string;
        verify: boolean;
        add: boolean;
      }) => Observation,
      args: { scope: string; verify: boolean; add: boolean },
    ) {
      observation = callback(args);
      const value = observation;
      return {
        async evaluate<T>(callback: (value: Observation) => T) {
          return callback(value);
        },
        async dispose() {
          disposed = true;
        },
      };
    },
    locator(selector: string) {
      const visible = selector.includes(":visible");
      const nodes = [
        ...document.querySelectorAll(selector.replaceAll(":visible", "")),
      ].filter((node) => !visible || node.checkVisibility());
      return {
        async innerText() {
          expect(nodes).toHaveLength(1);
          return nodes[0]!.textContent;
        },
        getByRole(role: string, options: { name: string; exact: boolean }) {
          expect(role).toBe("button");
          expect(options.exact).toBe(true);
          return {
            async click() {
              expect(
                observation,
                "observer armed before original click",
              ).not.toBeNull();
              const buttons = nodes
                .flatMap((node) => [...node.querySelectorAll("button")])
                .filter(
                  (node) =>
                    node.checkVisibility() && node.textContent === options.name,
                );
              expect(buttons).toHaveLength(1);
              clicks.push(options.name);
              await onClick();
            },
          };
        },
      };
    },
    async waitForFunction(
      callback: (value: Observation) => boolean,
      _handle: unknown,
    ) {
      await Promise.resolve();
      // All scripted renders have already delivered their observer callbacks.
      // Fail deterministically instead of using a real browser timeout.
      if (!observation || !callback(observation))
        throw new Error("TEST_OBSERVATION_TIMEOUT");
    },
  };
  return {
    page,
    bootstrap,
    clicks,
    setSettings(next: ReturnType<typeof settings>) {
      current = next;
    },
    get disposed() {
      return disposed;
    },
    get result() {
      return observation?.result;
    },
  };
}

describe("Setup action DOM receipt observer (in-memory only)", () => {
  it("accepts Verify success inside closed technical details on a visible workspace", async () => {
    mount();
    const adapter = pageAdapter(async () => {
      await feedback("Verify workspace: Saving or checking…");
      await feedback(verified, true);
    });
    await setupAction(adapter.page, "Verify workspace");
    expect(element(".workspace-technical p").checkVisibility()).toBe(false);
    expect(element(".workspace-detail").checkVisibility()).toBe(true);
    expect(adapter.result).toEqual([verified]);
    expect(adapter.clicks).toEqual(["Verify workspace"]);
    expect(adapter.disposed).toBe(true);
  });

  it.each([false, true])(
    "accepts hidden Add composed success, connection ready=%s",
    async (ready) => {
      mount();
      const adapter = pageAdapter(async () => {
        const button = element(".workspace-add button");
        button.textContent = "Connecting workspace…";
        await feedback("Saving or checking…");
        await feedback("Workspace selected. Saving access…");
        await feedback(
          `Workspace access saved: ${root}. Saved access: Read & write.`,
          true,
        );
        await feedback(verified, true);
        expect(adapter.result).toBeNull();
        adapter.setSettings(settings(true, ready));
        if (ready) {
          const activity = document.createElement("details");
          activity.className = "workspace-activity";
          activity.innerHTML = `<summary>Workspace activity</summary><p role="status">${connected}</p>`;
          element(".settings-page").prepend(activity);
          await Promise.resolve();
        }
        expect(adapter.result).toBeNull();
        button.textContent = "Add workspace…";
        await Promise.resolve();
      }, settings(false));
      await setupAction(adapter.page, "Add workspace…");
      if (ready)
        expect(element(".workspace-activity p").checkVisibility()).toBe(false);
      expect(element(".workspace-technical p").checkVisibility()).toBe(false);
      expect(adapter.clicks).toEqual(["Add workspace…"]);
      expect(adapter.bootstrap).toHaveBeenCalledTimes(2);
      expect(adapter.disposed).toBe(true);
    },
  );

  it.each(["Verify workspace", "Add workspace…"])(
    "keeps %s's first refusal/unknown even after later success",
    async (name) => {
      for (const outcome of [
        "Request refused: access denied.",
        "Outcome unknown. Review before another action.",
      ]) {
        mount();
        const verify = name === "Verify workspace";
        const original = verify ? `Verify workspace: ${outcome}` : outcome;
        const adapter = pageAdapter(async () => {
          await feedback(
            verify
              ? "Verify workspace: Saving or checking…"
              : "Saving or checking…",
          );
          await feedback(original);
          expect(adapter.result).toEqual([original]);
          await feedback(verified, true);
          adapter.setSettings(settings());
        }, settings(verify));
        await expect(setupAction(adapter.page, name)).rejects.toThrow(
          "SETUP_ACTION_UNCONFIRMED",
        );
        expect(adapter.result).toEqual([original]);
        expect(adapter.clicks).toEqual([name]);
        expect(adapter.disposed).toBe(true);
      }
    },
  );

  it.each(["Verify workspace", "Add workspace…"])(
    "does not let retained hidden success satisfy a new pending %s",
    async (name) => {
      mount(verified);
      const adapter = pageAdapter(async () => {
        const pending = document.createElement("p");
        pending.setAttribute("role", "status");
        pending.textContent =
          name === "Verify workspace"
            ? "Verify workspace: Saving or checking…"
            : "Saving or checking…";
        element(".workspace-feedback").prepend(pending);
        element(".workspace-add button").textContent = "Connecting workspace…";
        await Promise.resolve();
      });
      await expect(setupAction(adapter.page, name)).rejects.toThrow(
        "TEST_OBSERVATION_TIMEOUT",
      );
      expect(adapter.result).toBeNull();
      expect(adapter.clicks).toEqual([name]);
      expect(adapter.disposed).toBe(true);
    },
  );

  it.each(["hidden", 'style="display:none"'])(
    "ignores dormant page and workspace receipts with %s ancestors",
    async (hidden) => {
      mount();
      const adapter = pageAdapter(async () => {
        await feedback("Verify workspace: Saving or checking…");
        const dormant = document.createElement("div");
        dormant.innerHTML = `<div ${hidden}><div class="settings-page">
        ${workspace(verified)}<p role="status">${connected}</p>
        <details class="workspace-activity"><summary>Workspace activity</summary><p role="status">${connected}</p></details>
      </div></div><div ${hidden}>${workspace(verified)}</div>`;
        element(".setup-page").append(dormant);
        await Promise.resolve();
        expect(adapter.result).toBeNull();
        await feedback(verified, true);
      });
      await setupAction(adapter.page, "Verify workspace");
      expect(adapter.result).toEqual([verified]);
      await feedback("Verify workspace: Outcome unknown.");
      // The original latched result stays fixed through later renders.
      expect(adapter.result).toEqual([verified]);
      expect(adapter.clicks).toEqual(["Verify workspace"]);
      expect(adapter.disposed).toBe(true);
    },
  );

  it("ignores the previous Save receipt throughout a new Add action", async () => {
    mount("Save access: Workspace access saved. Current access is checked.");
    const adapter = pageAdapter(async () => {
      const pending = document.createElement("p");
      pending.setAttribute("role", "status");
      pending.textContent = "Saving or checking…";
      element(".workspace-feedback").append(pending);
      element(".workspace-add button").textContent = "Connecting workspace…";
      await Promise.resolve();
      expect(adapter.result).toBeNull();
      pending.textContent = verified;
      element(".workspace-technical").append(pending);
      adapter.setSettings(settings());
      await Promise.resolve();
      expect(adapter.result).toBeNull();
      element(".workspace-add button").textContent = "Add workspace…";
      await Promise.resolve();
    }, settings(false));
    await setupAction(adapter.page, "Add workspace…");
    expect(adapter.result).toEqual([checked]);
    expect(adapter.clicks).toEqual(["Add workspace…"]);
    expect(element(".workspace-technical").textContent).toContain(
      "Save access:",
    );
  });

  it("accepts the original receipt node changing from old success through pending to success", async () => {
    mount(verified);
    const adapter = pageAdapter(async () => {
      const receipt = element(".workspace-technical p");
      receipt.textContent = "Verify workspace: Saving or checking…";
      await Promise.resolve();
      expect(adapter.result).toBeNull();
      receipt.textContent = verified;
      await Promise.resolve();
    });
    await setupAction(adapter.page, "Verify workspace");
    expect(adapter.result).toEqual([verified]);
    expect(adapter.clicks).toEqual(["Verify workspace"]);
  });

  it("ignores dormant Add page activity while accepting the active exact result", async () => {
    mount();
    const adapter = pageAdapter(async () => {
      await feedback("Saving or checking…");
      const dormant = document.createElement("div");
      dormant.hidden = true;
      dormant.innerHTML = `<div class="settings-page"><p role="status">Request refused.</p>
        <details class="workspace-activity"><summary>Workspace activity</summary><p role="status">${connected}</p></details>
        ${workspace(verified)}</div>`;
      element(".setup-page").append(dormant);
      await Promise.resolve();
      expect(adapter.result).toBeNull();
      adapter.setSettings(settings());
      await feedback(verified, true);
    }, settings(false));
    await setupAction(adapter.page, "Add workspace…");
    expect(adapter.result).toEqual([checked]);
    expect(adapter.clicks).toEqual(["Add workspace…"]);
  });

  it("requires the exact hidden Verify receipt, not a near-match success", async () => {
    mount();
    const adapter = pageAdapter(async () => {
      await feedback("Verify workspace: Saving or checking…");
      await feedback(`${verified} Extra result.`, true);
    });
    await expect(setupAction(adapter.page, "Verify workspace")).rejects.toThrow(
      "SETUP_ACTION_UNCONFIRMED",
    );
    expect(adapter.clicks).toEqual(["Verify workspace"]);
    expect(adapter.disposed).toBe(true);
  });
});

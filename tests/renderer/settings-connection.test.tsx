import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { unavailableConnectionStatus } from "../../apps/desktop/renderer/connection-status";
import { deferred, settings } from "./fixture";
import { change, mount, readySettings } from "./setup-fixture";

// Pins the Setup "Connect this Mac" page (ConnectMac) and "Sign in" page
// (SignInStep) through the real renderer and controller with scripted
// configuration replies. No live tunnel, helper or ChatGPT account: only the
// commands the pages send and the states they present for them.
const key = "synthetic-key-do-not-retain";
const tunnel = "synthetic-tunnel";

type Settings = ReturnType<typeof readySettings>;
function stored(runtime: "none" | "unreachable" | "ready" = "none") {
  const value = readySettings();
  if (runtime === "none") value.connectors.secureMcp.runtime = null;
  if (runtime === "unreachable")
    value.connectors.secureMcp.runtime!.state = "unreachable";
  return value;
}
function receipt(
  command: Extract<
    ProductConfigurationCommand,
    { kind: "connector.save-and-connect" }
  >,
) {
  return {
    kind: command.kind,
    operationId: command.operationId,
    buildId: command.buildId,
    state: "completed" as const,
    stoppedAt: "complete" as const,
    credentials: "saved" as const,
    connection: "connected" as const,
    code: null,
    externalVerification: "not-proven" as const,
  };
}
async function connection(
  options: {
    value?: Settings;
    connectionStatus?: Parameters<typeof mount>[0] extends infer O
      ? O extends { connectionStatus?: infer S }
        ? S
        : never
      : never;
  } = {},
) {
  const h = await mount({ step: "connection", ...options });
  const sent = () =>
    vi
      .mocked(h.f.api.configure)
      .mock.calls.map(([command]) => command as ProductConfigurationCommand)
      .filter((command) => command.kind !== "chatgpt.observe-sign-in");
  const inputs = () =>
    h.host.querySelectorAll<HTMLInputElement>(".connection-credentials input");
  const gate = () => h.host.querySelector<HTMLElement>(".setup-gate-status")!;
  const reflect = () => ({ ok: true as const, snapshot: h.configuration() });
  return { ...h, sent, inputs, gate, reflect };
}
async function signin(signIn: "authenticated" | "signed_out" | "unknown") {
  const h = await mount({ step: "signin", signIn });
  const sent = () =>
    vi
      .mocked(h.f.api.configure)
      .mock.calls.map(([command]) => command as ProductConfigurationCommand)
      .filter((command) => command.kind !== "chatgpt.observe-sign-in");
  const section = () =>
    h.host.querySelector<HTMLElement>('section[aria-label="ChatGPT sign-in"]')!;
  const gate = () => h.host.querySelector<HTMLElement>(".setup-gate-status")!;
  return { ...h, sent, section, gate };
}
const texts = (parent: Element, selector: string) =>
  [...parent.querySelectorAll(selector)].map((e) => e.textContent);
const fieldNote = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('.connection-credentials ~ p[role="status"]');
const hint = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>(".connection-credentials ~ p")].find(
    (p) => p.textContent === "Enter your tunnel ID and key, then connect.",
  );

describe("Setup Connect this Mac page", () => {
  it("lays out a first-run profile", async () => {
    const h = await connection({ value: settings() });
    const intro = h.host.querySelector(".setup-wizard-intro")!;
    expect(intro.querySelector("h1")?.textContent).toBe("Connect this Mac");
    const section = h.host.querySelector(
      'section[aria-label="Create a tunnel and a key"]',
    )!;
    expect(section.querySelector(":scope > h3")?.textContent).toBe(
      "1. Create a tunnel and a key",
    );
    expect(section.querySelector(".setup-walkthrough")).toBeTruthy();
    const open = h.button("Open OpenAI Tunnels")!;
    expect(open.className).toBe("text-button");
    expect(open.type).toBe("button");
    const form = h.host.querySelector<HTMLFormElement>(
      "form.connection-credentials",
    )!;
    expect(form.getAttribute("autocomplete")).toBe("off");
    expect(texts(form, "label.setting-row")).toEqual(["Tunnel ID", "Key"]);
    const [tunnelField, keyField] = h.inputs();
    expect(tunnelField!.className).toBe("field");
    expect(tunnelField!.maxLength).toBe(160);
    expect(tunnelField!.required).toBe(true);
    expect(tunnelField!.disabled).toBe(false);
    expect(tunnelField!.value).toBe("");
    expect(keyField!.className).toBe("field");
    expect(keyField!.type).toBe("password");
    expect(keyField!.getAttribute("autocomplete")).toBe("new-password");
    expect(keyField!.getAttribute("spellcheck")).toBe("false");
    expect(keyField!.maxLength).toBe(512);
    expect(keyField!.placeholder).toBe("Paste your key");
    expect(keyField!.value).toBe("");
    expect(keyField!.getAttribute("aria-describedby")).toBe(
      "connection-key-hint",
    );
    const keyHint = h.host.querySelector("#connection-key-hint")!;
    expect(keyHint.className).toBe("description connection-key-hint");
    expect(keyHint.textContent).toBe(
      "Your key is saved privately on this Mac.",
    );
    const actions = form.querySelector(".connection-actions")!;
    expect(texts(actions, "button")).toEqual(["Connect"]);
    const connect = h.button("Connect")!;
    expect(connect.className).toBe("primary");
    expect(connect.disabled).toBe(true);
    expect(h.button("Disconnect")).toBeUndefined();
    expect(actions.querySelector('[role="status"]')).toBeNull();
    expect(fieldNote(h.host)).toBeNull();
    const prompt = hint(h.host)!;
    expect(prompt.className).toBe("description");
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("missing");
    expect(status.querySelector("strong")?.textContent).toBe("Your next step");
    expect(status.querySelector("p")?.textContent).toBe(
      "Connection has no current confirmed check. Complete this step before continuing.",
    );
    expect(texts(status, "button")).toEqual(["Read the setup guide"]);
    expect(h.button("Continue")!.disabled).toBe(true);
    expect(h.sent()).toEqual([]);
  });

  it("opens the OpenAI Tunnels help page from the walkthrough link", async () => {
    const h = await connection();
    h.reply(async () => h.reflect());
    await act(async () => h.button("Open OpenAI Tunnels")!.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toEqual({
      kind: "onboarding.open-help",
      destination: "tunnels",
    });
  });

  it("shows a saved key with its tunnel and offers Connect", async () => {
    const h = await connection({ value: stored("none") });
    const [tunnelField, keyField] = h.inputs();
    expect(tunnelField!.value).toBe(tunnel);
    expect(keyField!.placeholder).toBe("••••••••");
    expect(h.host.querySelector("#connection-key-hint")?.textContent).toBe(
      "Key saved on this Mac. Paste a new key only to replace it.",
    );
    const connect = h.button("Connect")!;
    expect(connect.className).toBe("primary");
    expect(connect.disabled).toBe(false);
    expect(h.button("Disconnect")).toBeUndefined();
    expect(hint(h.host)).toBeTruthy();
    expect(fieldNote(h.host)).toBeNull();
    expect(h.gate().getAttribute("data-result-state")).toBe("missing");
    expect(h.button("Continue")!.disabled).toBe(true);
  });

  it("shows a live connection with Disconnect and no Connect button", async () => {
    const h = await connection({ value: readySettings() });
    const actions = h.host.querySelector(".connection-actions")!;
    const done = actions.querySelector('[role="status"]')!;
    expect(done.textContent).toBe("✓ Connected");
    expect(done.className).toBe("setup-success");
    expect(h.button("Connect")).toBeUndefined();
    const stop = h.button("Disconnect")!;
    expect(stop.className).toBe("subtle");
    expect(stop.type).toBe("button");
    expect(stop.disabled).toBe(false);
    expect(hint(h.host)).toBeUndefined();
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("data-result-state")).toBe("success");
    expect(status.querySelector("strong")?.textContent).toBe(
      "Ready to continue",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "This Mac is connected. Continue to add your app in ChatGPT.",
    );
    expect(h.button("Continue")!.disabled).toBe(false);
  });

  it("says the connection is only saved while the live transport needs attention", async () => {
    const h = await connection({
      value: readySettings(),
      connectionStatus: {
        ...unavailableConnectionStatus,
        state: "unavailable",
        validUntilMillis: Date.now() + 100_000,
        detail: "The current connection is unavailable.",
      },
    });
    const done = h.host.querySelector('.connection-actions [role="status"]')!;
    expect(done.textContent).toBe("Connection saved");
    expect(done.hasAttribute("class")).toBe(false);
    expect(h.button("Connect")).toBeUndefined();
    expect(h.button("Disconnect")).toBeTruthy();
    expect(h.gate().getAttribute("data-result-state")).toBe("success");
  });

  it("asks to reconnect when the saved runtime is not reachable", async () => {
    const h = await connection({ value: stored("unreachable") });
    expect(h.button("Connect")!.disabled).toBe(false);
    expect(h.button("Disconnect")!.disabled).toBe(false);
    expect(hint(h.host)).toBeTruthy();
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("stale");
    expect(status.querySelector("p")?.textContent).toBe(
      "The connection details changed or need checking again. Connect using the current details.",
    );
  });

  it("shows Save and connect for an edited key on a running connection", async () => {
    const h = await connection({ value: readySettings() });
    await change(h.inputs()[1]!, key);
    const actions = h.host.querySelector(".connection-actions")!;
    expect(texts(actions, "button")).toEqual([
      "Save and connect",
      "Disconnect",
    ]);
    expect(h.button("Save and connect")!.disabled).toBe(false);
    expect(h.host.textContent).not.toContain("✓ Connected");
  });

  it.each([
    [
      "an invalid tunnel ID",
      "bad tunnel",
      "",
      "Copy the complete tunnel ID from OpenAI Tunnels, without spaces.",
    ],
    [
      "a tunnel ID without a key",
      tunnel,
      "",
      "Paste the key shown when you created it in OpenAI.",
    ],
    [
      "a key with spaces",
      tunnel,
      "key with spaces",
      "Paste the complete key without spaces or line breaks.",
    ],
  ])(
    "explains %s and keeps Connect disabled",
    async (_name, id, secret, note) => {
      const h = await connection({ value: settings() });
      await change(h.inputs()[0]!, id);
      if (secret) await change(h.inputs()[1]!, secret);
      const message = fieldNote(h.host)!;
      expect(message.className).toBe("description");
      expect(message.textContent).toBe(note);
      expect(h.button("Connect")!.disabled).toBe(true);
      expect(hint(h.host)).toBeTruthy();
      await act(async () =>
        h.host
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      expect(h.sent()).toEqual([]);
    },
  );

  it("starts a stored connection and then checks its health", async () => {
    const h = await connection({ value: stored("none") });
    h.reply(async () => h.reflect());
    await h.click("Connect");
    expect(h.sent()).toEqual([
      { kind: "connector.start" },
      { kind: "connector.check-health" },
    ]);
  });

  it("repairs an unreachable runtime and then checks its health", async () => {
    const h = await connection({ value: stored("unreachable") });
    h.reply(async () => h.reflect());
    await h.click("Connect");
    expect(h.sent()).toEqual([
      { kind: "connector.repair" },
      { kind: "connector.check-health" },
    ]);
  });

  it("submits the form with Enter the same way as Connect", async () => {
    const h = await connection({ value: stored("none") });
    h.reply(async () => h.reflect());
    await act(async () =>
      h.host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await vi.waitFor(() => expect(h.sent()).toHaveLength(2));
    expect(h.sent().map((c) => c.kind)).toEqual([
      "connector.start",
      "connector.check-health",
    ]);
  });

  it("discovers the helper, saves the key and connects, then checks health", async () => {
    const h = await connection({ value: settings() });
    let value = settings();
    h.reply(async (command) => {
      if (command.kind === "connector.discover-client") {
        value = { ...value, revision: 2 };
        value.connectors.secureMcp.tunnelClient =
          readySettings().connectors.secureMcp.tunnelClient;
      }
      if (command.kind === "connector.save-and-connect") {
        value = { ...readySettings(), revision: 3 };
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          connectorSetup: receipt(command),
        };
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await change(h.inputs()[0]!, tunnel);
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    await h.click("Connect");
    expect(h.sent()).toEqual([
      { kind: "connector.discover-client" },
      {
        kind: "connector.save-and-connect",
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        buildId: "3".repeat(64),
        tunnelId: tunnel,
        runtimeKey: key,
      },
      { kind: "connector.check-health" },
    ]);
    expect(h.inputs()[1]!.value).toBe("");
    expect(
      h.host.querySelector('.connection-actions [role="status"]')?.textContent,
    ).toBe("✓ Connected");
    expect(h.gate().getAttribute("data-result-state")).toBe("success");
    expect(h.button("Continue")!.disabled).toBe(false);
  });

  it("stops the running connection, saves the new key and checks health", async () => {
    const h = await connection({ value: readySettings() });
    let value = readySettings();
    h.reply(async (command) => {
      if (command.kind === "connector.stop") {
        value = { ...value, revision: 2 };
        value.connectors.secureMcp.runtime = null;
      }
      if (command.kind === "connector.save-and-connect") {
        value = { ...readySettings(), revision: 3 };
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          connectorSetup: receipt(command),
        };
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await change(h.inputs()[1]!, key);
    await h.click("Save and connect");
    expect(h.sent()).toEqual([
      { kind: "connector.stop" },
      {
        kind: "connector.save-and-connect",
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        buildId: "3".repeat(64),
        tunnelId: tunnel,
        runtimeKey: key,
      },
      { kind: "connector.check-health" },
    ]);
    expect(h.inputs()[1]!.value).toBe("");
  });

  it("disconnects with one stop command", async () => {
    const h = await connection({ value: readySettings() });
    h.reply(async () => h.reflect());
    await h.click("Disconnect");
    expect(h.sent()).toEqual([{ kind: "connector.stop" }]);
  });

  it("shows the connecting state and blocks the form while a command is pending", async () => {
    const h = await connection({ value: stored("none") });
    const pending = deferred<unknown>();
    h.reply(() => pending.promise);
    await h.click("Connect");
    const busy = h.button("Connecting…")!;
    expect(busy.disabled).toBe(true);
    expect(busy.className).toBe("primary");
    expect(h.inputs()[0]!.disabled).toBe(true);
    expect(h.inputs()[1]!.disabled).toBe(true);
    expect(hint(h.host)).toBeUndefined();
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("pending");
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.querySelector("strong")?.textContent).toBe("Checking…");
    expect(status.querySelector("p")?.textContent).toBe(
      "Connection check is still in progress. Wait for its result.",
    );
    expect(h.button("Continue")!.disabled).toBe(true);
    await act(async () => pending.resolve(h.reflect()));
  });

  it("reports a refused start and offers the setup guide", async () => {
    const h = await connection({ value: stored("none") });
    h.reply(async () => ({
      ok: false,
      error: "CONNECTOR_RUNTIME_UNREACHABLE",
      snapshot: h.configuration(),
    }));
    await h.click("Connect");
    expect(h.sent()).toEqual([{ kind: "connector.start" }]);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("refused");
    expect(status.querySelector("strong")?.textContent).toBe(
      "This step needs attention",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Connection could not be checked. Review this step before continuing.",
    );
    expect(texts(status, "button")).toEqual(["Read the setup guide"]);
    expect(hint(h.host)).toBeUndefined();
    expect(h.button("Connect")!.disabled).toBe(false);
    expect(h.button("Continue")!.disabled).toBe(true);
    h.reply(async () => h.reflect());
    await act(async () =>
      status.querySelector<HTMLButtonElement>("button")!.click(),
    );
    await vi.waitFor(() =>
      expect(h.sent().at(-1)).toEqual({
        kind: "onboarding.open-help",
        destination: "setup-guide",
      }),
    );
  });

  it("explains a missing connection helper and points to the installation guide", async () => {
    const value = readySettings();
    value.connectors.secureMcp.tunnelClient = null;
    const h = await connection({ value });
    h.reply(async () => ({
      ok: false,
      error: "TUNNEL_CLIENT_DISCOVERY_FAILED",
      snapshot: h.configuration(),
    }));
    await h.click("Connect");
    expect(h.sent()).toEqual([{ kind: "connector.discover-client" }]);
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("refused");
    expect(status.querySelector("p")?.textContent).toBe(
      "Farol could not verify its bundled connection helper. Reinstall Farol from a trusted release.",
    );
    expect(texts(status, "button")).toEqual(["Read the installation guide"]);
    expect(hint(h.host)).toBeUndefined();
  });

  it.each([
    "CONNECTOR_CREDENTIAL_STORE_FAILED",
    "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
    "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  ])(
    "fences the page and drops the key after a failed save reported as %s",
    async (error) => {
      const h = await connection({ value: stored("none") });
      h.reply(async () => ({ ok: false, error, snapshot: h.configuration() }));
      await change(h.inputs()[1]!, key);
      await h.click("Connect");
      expect(h.sent().map((c) => c.kind)).toEqual([
        "connector.save-and-connect",
      ]);
      const status = h.gate();
      expect(status.getAttribute("data-result-state")).toBe("unknown");
      expect(status.querySelector("p")?.textContent).toBe(
        "Connection result could not be confirmed. Refresh its saved result; do not repeat the action.",
      );
      expect(h.button("Connect")!.disabled).toBe(true);
      expect(h.inputs()[1]!.value).toBe("");
    },
  );

  it("never continues past a refused stop", async () => {
    const h = await connection({ value: readySettings() });
    h.reply(async () => ({
      ok: false,
      error: "CONNECTOR_RUNTIME_UNREACHABLE",
      snapshot: h.configuration(),
    }));
    await change(h.inputs()[1]!, key);
    await h.click("Save and connect");
    expect(h.sent()).toEqual([{ kind: "connector.stop" }]);
    // The refused stop leaves the earlier healthy connection in place.
    expect(h.gate().getAttribute("data-result-state")).toBe("success");
    expect(h.button("Disconnect")!.disabled).toBe(false);
    expect(h.inputs()[1]!.value).toBe("");
  });

  it("fences the page after a connect whose outcome is unknown", async () => {
    const h = await connection({ value: stored("none") });
    h.reply(async () => {
      throw Error("scripted lost reply");
    });
    await h.click("Connect");
    expect(h.sent()).toEqual([{ kind: "connector.start" }]);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("unknown");
    expect(status.querySelector("strong")?.textContent).toBe(
      "Check the last result",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Connection result could not be confirmed. Refresh its saved result; do not repeat the action.",
    );
    expect(texts(status, "button")).toEqual(["Refresh status"]);
    expect(h.button("Connect")!.disabled).toBe(true);
    expect(h.button("Open OpenAI Tunnels")!.disabled).toBe(true);
    expect(h.button("Continue")!.disabled).toBe(true);
    expect(hint(h.host)).toBeUndefined();
    await h.click("Connect");
    expect(h.sent()).toHaveLength(1);
  });

  it("fences the page after a disconnect whose outcome is unknown", async () => {
    const h = await connection({ value: readySettings() });
    h.reply(async () => {
      throw Error("scripted lost reply");
    });
    await h.click("Disconnect");
    expect(h.sent()).toEqual([{ kind: "connector.stop" }]);
    expect(h.gate().getAttribute("data-result-state")).toBe("unknown");
    expect(h.button("Disconnect")!.disabled).toBe(true);
    expect(h.button("Continue")!.disabled).toBe(true);
  });
});

describe("Setup Sign in page", () => {
  it("asks a signed-out profile to sign in", async () => {
    const h = await signin("signed_out");
    expect(h.host.querySelector(".setup-wizard-intro h1")?.textContent).toBe(
      "Sign in to ChatGPT",
    );
    expect(texts(h.section(), ":scope > p")).toEqual([
      "Sign in to your ChatGPT account, then return here.",
    ]);
    expect(h.section().querySelector("p")!.className).toBe("description");
    expect(texts(h.section(), "button")).toEqual(["Sign in"]);
    const action = h.button("Sign in")!;
    expect(action.className).toBe("primary");
    expect(action.type).toBe("button");
    expect(action.disabled).toBe(false);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("missing");
    expect(status.querySelector("strong")?.textContent).toBe("Your next step");
    expect(status.querySelector("p")?.textContent).toBe(
      "Sign-in has no current confirmed check. Complete this step before continuing.",
    );
    expect(texts(status, "button")).toEqual(["Read the setup guide"]);
    expect(h.button("Continue")!.disabled).toBe(true);
    h.reply(async () => ({ ok: true, snapshot: h.configuration() }));
    await h.click("Sign in");
    expect(h.sent()).toEqual([{ kind: "chatgpt.open-sign-in" }]);
  });

  it("offers Open ChatGPT when the sign-in status could not be read", async () => {
    const h = await signin("unknown");
    expect(texts(h.section(), ":scope > p")).toEqual([
      "Sign in to your ChatGPT account, then return here.",
    ]);
    expect(texts(h.section(), "button")).toEqual(["Open ChatGPT"]);
    expect(h.button("Open ChatGPT")!.className).toBe("primary");
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("missing");
    expect(status.querySelector("p")?.textContent).toBe(
      "Farol could not read your ChatGPT sign-in status. Choose Check again to read the current session.",
    );
    expect(texts(status, "button")).toEqual(["Check again"]);
    h.reply(async () => ({ ok: true, snapshot: h.configuration() }));
    await h.click("Open ChatGPT");
    expect(h.sent()).toEqual([{ kind: "chatgpt.open-browser" }]);
  });

  it("checks a signed-in page and then lets the owner continue", async () => {
    const h = await signin("authenticated");
    expect(texts(h.section(), ":scope > p")).toEqual([
      "You’re signed in. Check sign-in to continue.",
    ]);
    expect(texts(h.section(), "button")).toEqual(["Check sign-in"]);
    expect(h.button("Check sign-in")!.className).toBe("primary");
    expect(h.button("Continue")!.disabled).toBe(true);
    h.reply(async () => ({
      ok: true,
      snapshot: { status: "ready", settings: readySettings() },
      evidence: {
        kind: "chatgpt.readiness",
        state: "authenticated",
        code: null,
      },
    }));
    await h.click("Check sign-in");
    expect(h.sent()).toEqual([{ kind: "chatgpt.verify" }]);
    expect(h.section().children).toHaveLength(0);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("data-result-state")).toBe("success");
    expect(status.querySelector("strong")?.textContent).toBe(
      "✓ Sign-in checked",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Your ChatGPT sign-in is confirmed. Continue to choose workspaces.",
    );
    expect(h.button("Continue")!.disabled).toBe(false);
  });

  it("shows a check in progress and blocks the action", async () => {
    const h = await signin("authenticated");
    const pending = deferred<unknown>();
    h.reply(() => pending.promise);
    await h.click("Check sign-in");
    expect(texts(h.section(), ":scope > p")).toEqual(["Checking sign-in…"]);
    const action = h.button("Sign in")!;
    expect(action.disabled).toBe(true);
    expect(action.className).toBe("primary");
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("pending");
    expect(status.querySelector("p")?.textContent).toBe(
      "Sign-in check is still in progress. Wait for its result.",
    );
    expect(h.button("Continue")!.disabled).toBe(true);
    await act(async () =>
      pending.resolve({ ok: true, snapshot: h.configuration() }),
    );
  });

  it("fences the page after a check whose outcome is unknown", async () => {
    const h = await signin("authenticated");
    h.reply(async () => {
      throw Error("scripted lost reply");
    });
    await h.click("Check sign-in");
    expect(h.sent()).toEqual([{ kind: "chatgpt.verify" }]);
    expect(texts(h.section(), ":scope > p")).toEqual([
      "Sign in to your ChatGPT account, then return here.",
    ]);
    const action = h.button("Sign in")!;
    expect(action.disabled).toBe(true);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("unknown");
    expect(status.querySelector("strong")?.textContent).toBe(
      "Check the last result",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Sign-in result could not be confirmed. Refresh its saved result; do not repeat the action.",
    );
    expect(texts(status, "button")).toEqual(["Refresh status"]);
    expect(h.button("Continue")!.disabled).toBe(true);
    await act(async () => action.click());
    expect(h.sent()).toHaveLength(1);
  });

  it("reports a refused check", async () => {
    const h = await signin("authenticated");
    h.reply(async () => ({
      ok: false,
      error: "CHATGPT_PAGE_UNREACHABLE",
      snapshot: h.configuration(),
    }));
    await h.click("Check sign-in");
    expect(h.sent()).toEqual([{ kind: "chatgpt.verify" }]);
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("refused");
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.querySelector("strong")?.textContent).toBe(
      "This step needs attention",
    );
    expect(h.button("Continue")!.disabled).toBe(true);
  });
});

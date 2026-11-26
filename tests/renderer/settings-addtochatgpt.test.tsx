import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { deferred } from "./fixture";
import { change, mount, readySettings } from "./setup-fixture";

// Pins the Setup "Add to ChatGPT" page (the AddToChatGPT component) through the
// real renderer and controller with scripted configuration replies. No live
// ChatGPT, tunnel or native evidence: only the commands the page sends and the
// states it presents for them.
const runtimeGeneration = "a".repeat(64);
const challengeSha256 = "c".repeat(64);
const buildId = "3".repeat(64);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const lostResult = "scripted lost acknowledgement";

function named() {
  const value = readySettings();
  value.connectors.secureMcp.chatgptApp = {
    name: "Farol",
    tunnelId: "synthetic-tunnel",
    connectorGeneration: 1,
  };
  return value;
}
function unconfirmed() {
  const value = named();
  value.setup.connect.outcomeUnknown = true;
  value.connectors.secureMcp.appVerificationPending = true;
  return value;
}
async function attach(
  options: { value?: ReturnType<typeof readySettings> } = {},
) {
  const h = await mount({
    step: "attachment",
    value: options.value ?? readySettings(),
    signIn: "authenticated",
  });
  await h.confirmSignIn();
  vi.mocked(h.f.api.configure).mockClear();
  const sent = () =>
    vi
      .mocked(h.f.api.configure)
      .mock.calls.map(([command]) => command as ProductConfigurationCommand)
      .filter((command) => command.kind !== "chatgpt.observe-sign-in");
  const nameField = () =>
    h.host.querySelector<HTMLInputElement>('[aria-label="ChatGPT app name"]')!;
  const gate = () => h.host.querySelector<HTMLElement>(".setup-gate-status")!;
  const reads = () =>
    sent().filter((c) => c.kind === "connector.check-attachment");
  return { ...h, sent, nameField, gate, reads };
}
const texts = (parent: Element, selector: string) =>
  [...parent.querySelectorAll(selector)].map((e) => e.textContent);
const reflect = (h: { configuration(): unknown }) => async () => ({
  ok: true as const,
  snapshot: h.configuration(),
});

describe("Setup Add to ChatGPT page", () => {
  it("lays out the app section for a first-run profile", async () => {
    const h = await attach();
    const section = h.host.querySelector(
      'section[aria-label="Create the ChatGPT app"]',
    )!;
    expect(section.querySelector("h3")?.textContent).toBe(
      "1. Add your app in ChatGPT",
    );
    expect(texts(section, ":scope > p")).toEqual([
      "Create a new app, or use the one already connected to this tunnel.",
      "Use this Mac’s tunnel ID in ChatGPT. A matching app name does not guarantee that the app connects to this Mac.",
    ]);
    expect(section.querySelector(":scope > p.description")).toBeTruthy();
    expect(section.querySelector("p.setup-connection-hint")?.className).toBe(
      "description setup-connection-hint",
    );
    const details = section.querySelector<HTMLElement>("dl.setup-app-values")!;
    expect(details.getAttribute("aria-label")).toBe(
      "Connection details for this Mac",
    );
    expect(details.getAttribute("tabindex")).toBe("-1");
    expect(texts(details, "dt")).toEqual([
      "Name",
      "Connection",
      "App authentication",
    ]);
    const input = h.nameField();
    expect(input.className).toBe("field");
    expect(input.value).toBe("Farol");
    expect(input.maxLength).toBe(64);
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe(
      "chatgpt-app-name-hint",
    );
    const hint = h.host.querySelector("#chatgpt-app-name-hint")!;
    expect(hint.className).toBe("description");
    expect(hint.textContent).toBe(
      "Use the exact name shown in ChatGPT. For a separate test app, use Farol Dev.",
    );
    expect(texts(details, "dd").slice(1)).toEqual([
      "Tunnel · synthetic-tunnel",
      "No additional sign-in" +
        "Choose None in the app’s authentication settings. Your ChatGPT account stays signed in separately.",
    ]);
    expect(h.button("Save app name")).toBeUndefined();
    expect(h.host.querySelector('[role="status"]')?.textContent).not.toContain(
      "Enter 1–64",
    );
  });

  it("lays out the check section and the footer Test action", async () => {
    const h = await attach();
    const section = h.host.querySelector(
      'section[aria-label="Test in ChatGPT"]',
    )!;
    expect(section.className).toBe("setup-test");
    expect(section.querySelector("h3")?.textContent).toBe(
      "2. Check the connection",
    );
    const blocked = section.querySelector("#setup-test-blocked")!;
    expect(blocked.className).toBe("description");
    expect(blocked.textContent).toBe(
      "Farol opens a separate chat, selects Instant and sends one test message to your app. The reply confirms that ChatGPT can reach this Mac — without reading file contents.",
    );
    const status = h.gate();
    expect(status.className).toBe("setup-result setup-gate-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("data-result-state")).toBe("missing");
    expect(status.hasAttribute("data-confirmation-pending")).toBe(false);
    expect(status.querySelector("strong")?.textContent).toBe(
      "Ready when your app is added",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Add the app above, then run the check once.",
    );
    expect(texts(status, "button")).toEqual([]);
    expect(section.lastElementChild?.textContent).toBe(
      "Create the app above, then run the check once.",
    );
    const footer = h.host.querySelector(".setup-wizard-footer")!;
    const test = h.button("Test in ChatGPT")!;
    expect(
      footer.querySelector(".setup-test-action-slot")?.contains(test),
    ).toBe(true);
    expect(section.contains(test)).toBe(false);
    expect(test.className).toBe("primary");
    expect(test.type).toBe("button");
    expect(test.disabled).toBe(false);
    expect(test.hasAttribute("aria-describedby")).toBe(false);
    expect(test.hasAttribute("title")).toBe(false);
  });

  it("opens the ChatGPT Apps help page from the walkthrough link", async () => {
    const h = await attach();
    const open = h.button("Open ChatGPT Apps")!;
    expect(open.className).toBe("text-button");
    await act(async () => open.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toEqual({
      kind: "onboarding.open-help",
      destination: "chatgpt",
    });
  });

  it("explains a Mac without a tunnel and blocks the test", async () => {
    const h = await mount({ step: "attachment" });
    expect(h.host.querySelector(".setup-app-values")?.textContent).toContain(
      "ConnectionTunnel · Connect this Mac first",
    );
    const note = h.host.querySelector('.setup-app-values p[role="status"]')!;
    expect(note.textContent).toBe(
      "Enter 1–64 letters, numbers, spaces, periods, underscores or hyphens. Start with a letter or number.",
    );
    expect(h.button("Save app name")).toBeUndefined();
    expect(
      h.host.querySelector(".setup-test")?.lastElementChild?.textContent,
    ).toBe(
      "Finish sign-in, workspace and connection checks before testing in ChatGPT.",
    );
    expect(h.button("Test in ChatGPT")!.disabled).toBe(true);
    await act(async () => h.button("Test in ChatGPT")!.click());
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind !== "chatgpt.observe-sign-in"),
    ).toEqual([]);
  });

  it("offers the saved name and defaults a Dev build to Farol Dev", async () => {
    const value = readySettings();
    value.connectors.secureMcp.chatgptApp = {
      name: "Farol Preview",
      tunnelId: "synthetic-tunnel",
      connectorGeneration: 1,
    };
    const h = await attach({ value });
    expect(h.nameField().value).toBe("Farol Preview");
    expect(h.button("Save app name")).toBeUndefined();
  });

  it.each([
    ["dev", "Farol Dev"],
    ["owner-preview", "Farol Preview"],
  ] as const)(
    "defaults the %s environment to %s",
    async (environment, name) => {
      const h = await attach();
      await h.renderSetup({ ...h.c.getSnapshot(), environment }, h.c);
      expect(h.nameField().value).toBe(name);
    },
  );

  it("shows Save app name for an edited name and sends the exact selection", async () => {
    const h = await attach();
    await change(h.nameField(), "Farol Dev");
    const save = h.button("Save app name")!;
    expect(save.className).toBe("subtle");
    expect(save.type).toBe("button");
    expect(save.disabled).toBe(false);
    expect(
      h.host.querySelector(".setup-test .description:last-child")?.textContent,
    ).toBe("Save the app name above before preparing a new test.");
    h.reply(reflect(h));
    await act(async () => save.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toEqual({
      kind: "connector.select-chatgpt-app",
      name: "Farol Dev",
      tunnelId: "synthetic-tunnel",
      connectorGeneration: 1,
    });
  });

  it.each(["", "-leading hyphen", "has/slash", "x".repeat(65)])(
    "refuses to save or test the invalid name %j",
    async (invalid) => {
      const h = await attach();
      await change(h.nameField(), invalid);
      // maxLength is not enforced for scripted input; the schema is.
      const note = [...h.host.querySelectorAll('p[role="status"]')].find((p) =>
        p.textContent?.startsWith("Enter 1–64"),
      )!;
      expect(note.className).toBe("description");
      expect(note.textContent).toBe(
        "Enter 1–64 letters, numbers, spaces, periods, underscores or hyphens. Start with a letter or number.",
      );
      expect(h.button("Save app name")?.disabled ?? true).toBe(true);
      expect(h.button("Test in ChatGPT")!.disabled).toBe(true);
      await act(async () => h.button("Test in ChatGPT")!.click());
      expect(h.sent()).toEqual([]);
    },
  );

  it("selects the app and then sends the embedded app test", async () => {
    const h = await attach();
    let saved = readySettings();
    const verifying = deferred<unknown>();
    h.reply((command) => {
      if (command.kind === "connector.select-chatgpt-app") {
        saved = structuredClone(saved);
        saved.revision = 2;
        saved.connectors.secureMcp.chatgptApp = {
          name: command.name,
          tunnelId: command.tunnelId,
          connectorGeneration: command.connectorGeneration,
        };
        return { ok: true, snapshot: { status: "ready", settings: saved } };
      }
      return verifying.promise;
    });
    await change(h.nameField(), "Farol Dev");
    expect(h.button("Test in ChatGPT")!.disabled).toBe(false);
    await act(async () => h.button("Test in ChatGPT")!.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(2));
    expect(h.sent()).toEqual([
      {
        kind: "connector.select-chatgpt-app",
        name: "Farol Dev",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 1,
      },
      { kind: "connector.verify-app" },
    ]);
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      connectionCheckReturn: true,
    });
    await act(async () =>
      verifying.resolve({ ok: true, snapshot: h.configuration() }),
    );
  });

  it("sends only the embedded app test when the selected app is current", async () => {
    const h = await attach({ value: named() });
    const verifying = deferred<unknown>();
    h.reply(() => verifying.promise);
    await act(async () => h.button("Test in ChatGPT")!.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toEqual({ kind: "connector.verify-app" });
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      connectionCheckReturn: true,
    });
    await act(async () =>
      verifying.resolve({ ok: true, snapshot: h.configuration() }),
    );
  });

  it("does not send the test when the app selection is refused", async () => {
    const h = await attach();
    h.reply(async () => ({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: h.configuration(),
    }));
    await act(async () => h.button("Test in ChatGPT")!.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toMatchObject({ kind: "connector.select-chatgpt-app" });
    expect(h.c.getSnapshot().destination.area).toBe("setup");
  });

  it("shows a verified app as connected with its workspace evidence", async () => {
    const h = await attach({ value: readySettings(true) });
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("success");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.querySelector("strong")?.textContent).toBe(
      "ChatGPT is connected",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "ChatGPT reached this Mac and confirmed the approved workspace access.",
    );
    const success = h.host.querySelector(".setup-test .setup-success")!;
    expect(success.getAttribute("role")).toBe("status");
    expect(success.querySelector("strong")?.textContent).toBe(
      "✓ Everything works",
    );
    expect(success.querySelector("p")?.textContent).toBe(
      "ChatGPT used Farol, reached this Mac and verified access to the approved workspace. No file contents were read.",
    );
    expect(h.host.querySelector("h3")?.textContent).toBe(
      "1. Add your app in ChatGPT",
    );
    expect(h.button("Prepare new test")).toBeUndefined();
    expect(h.button("Show connection details")).toBeUndefined();
  });

  it("presents a completed Setup as a saved app with an optional test", async () => {
    const value = readySettings(true);
    value.setup.journey.dismissed = true;
    const h = await attach({ value });
    expect(texts(h.host, ".settings-page h3")).toEqual([
      "Your ChatGPT app",
      "Connection test",
    ]);
    expect(h.host.textContent).toContain(
      "Your app was added and tested during setup.",
    );
    expect(h.host.textContent).not.toContain(
      "Create a new app, or use the one already connected to this tunnel.",
    );
    const status = h.gate();
    expect(status.getAttribute("data-result-state")).toBe("success");
    expect(status.querySelector("strong")?.textContent).toBe(
      "App added and tested",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "Setup is saved. View Home for the current connection status, or run a new test below when you need one.",
    );
    expect(h.host.querySelector("#setup-test-blocked")?.textContent).toBe(
      "A new connection test is optional. Current connection status is shown on Home.",
    );
    expect(
      h.host.querySelector(".setup-test .setup-success")?.textContent,
    ).toContain("✓ Everything works");
    expect(h.button("Test in ChatGPT")!.hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  it("offers a fresh test preparation when the challenge is spent", async () => {
    const value = named();
    value.connectors.secureMcp.challenge = null;
    const h = await attach({ value });
    const prepare = h.button("Prepare new test")!;
    expect(prepare.className).toBe("primary");
    expect(prepare.disabled).toBe(false);
    expect(h.host.querySelector(".setup-test")?.textContent).toContain(
      "Prepare a fresh test for this app by refreshing this Mac’s connection. Your saved key and workspace settings stay in place.",
    );
    expect(h.button("Test in ChatGPT")!.disabled).toBe(true);
    h.reply(reflect(h));
    await act(async () => prepare.click());
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    expect(h.sent()[0]).toEqual({ kind: "connector.repair" });
  });

  it.each([
    [
      "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
      "The ChatGPT check did not finish. Check that the app name below matches the app you added in ChatGPT and that it uses this tunnel.",
    ],
    [
      "CHATGPT_COMPOSER_DRAFT_PRESENT",
      "Message blocked before send because the composer already had text. Your draft was preserved; finish or clear it, then retry.",
    ],
  ])("reports the refused test %s", async (error, cause) => {
    const h = await attach({ value: named() });
    h.reply(async () => ({
      ok: false,
      error,
      snapshot: h.configuration(),
    }));
    await act(async () => h.button("Test in ChatGPT")!.click());
    await h.navigate("attachment");
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("data-result-state")).toBe("refused");
    expect(status.querySelector("strong")?.textContent).toBe(
      "The check stopped",
    );
    expect(status.querySelector("p")?.textContent).toBe(cause);
    expect(texts(status, "button")).toEqual(["Read the setup guide"]);
    expect(h.host.querySelector("#setup-test-blocked")?.textContent).toContain(
      "Farol opens a separate chat",
    );
    expect(h.host.querySelector(".setup-test")?.textContent).not.toContain(
      "Create the app above, then run the check once.",
    );
    h.reply(reflect(h));
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

  it("fences the page after a test whose outcome is unknown", async () => {
    const h = await attach({ value: named() });
    h.reply(async () => {
      throw Error(lostResult);
    });
    await act(async () => h.button("Test in ChatGPT")!.click());
    await h.navigate("attachment");
    expect(h.sent()).toEqual([{ kind: "connector.verify-app" }]);
    const status = h.gate();
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("data-result-state")).toBe("unknown");
    expect(status.getAttribute("data-confirmation-pending")).toBe("true");
    expect(status.querySelector("strong")?.textContent).toBe(
      "Waiting for confirmation",
    );
    expect(status.querySelector("p")?.textContent).toBe(
      "This Mac has not received confirmation. Check the saved result, or compare the app’s tunnel ID with the connection shown above.",
    );
    expect(texts(status, "button")).toEqual(["Refresh status"]);
    const test = h.button("Test in ChatGPT")!;
    expect(test.disabled).toBe(true);
    expect(test.getAttribute("aria-describedby")).toBe("setup-test-blocked");
    expect(test.title).toBe(
      "Check the saved result first. The earlier test has no confirmed outcome.",
    );
    expect(h.host.querySelector("#setup-test-blocked")?.textContent).toBe(
      "An earlier test has no confirmed result. It will not be repeated. Refresh status to check its saved result.",
    );
    expect(h.host.textContent).toContain(
      "Farol checks the saved confirmation automatically when you return here. Refresh status checks again without sending a message. The earlier test stays in Unresolved actions.",
    );
    expect(h.host.querySelector(".setup-review-connection")?.className).toBe(
      "text-button setup-review-connection",
    );
    expect(h.nameField().disabled).toBe(true);
    expect(h.button("Prepare new test")).toBeUndefined();
  });

  it("reviews connection details without sending anything", async () => {
    const h = await attach({ value: unconfirmed() });
    const details = h.host.querySelector<HTMLElement>(
      '[aria-label="Connection details for this Mac"]',
    )!;
    const scroll = vi.fn();
    details.scrollIntoView = scroll;
    vi.mocked(h.f.api.configure).mockClear();
    await h.click("Show connection details");
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(details);
    expect(h.sent()).toEqual([]);
  });

  it("sends the scoped separate-app test once and fences a retry", async () => {
    const h = await attach({ value: unconfirmed() });
    expect(h.host.querySelector("#setup-test-blocked")?.textContent).toBe(
      "Test in ChatGPT sends one new test message after confirmation. The earlier result stays in Activity and will not be repeated.",
    );
    const test = h.button("Test in ChatGPT")!;
    expect(test.disabled).toBe(false);
    expect(test.getAttribute("aria-describedby")).toBe("setup-test-blocked");
    const verifying = deferred<unknown>();
    h.reply(() => verifying.promise);
    await act(async () => test.click());
    await vi.waitFor(() =>
      expect(
        h.sent().filter((c) => c.kind === "connector.verify-separate-app"),
      ).toHaveLength(1),
    );
    expect(h.sent().at(-1)).toEqual({
      kind: "connector.verify-separate-app",
      expected: {
        ownerAuthorized: true,
        appName: "Farol",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 1,
        computerGeneration: 1,
        runtimeGeneration,
        buildId,
        challengeSha256,
        workspaceId,
      },
    });
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      connectionCheckReturn: true,
    });
    await act(async () =>
      verifying.resolve({
        ok: false,
        error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
        snapshot: h.configuration(),
      }),
    );
    await h.navigate("attachment");
    expect(h.button("Test in ChatGPT")!.disabled).toBe(true);
    expect(
      h.sent().filter((c) => c.kind === "connector.verify-separate-app"),
    ).toHaveLength(1);
  });

  it("reads a pending confirmation on arrival and says what it found", async () => {
    const h = await mount({
      step: "attachment",
      value: unconfirmed(),
    });
    const reads = vi
      .mocked(h.f.api.configure)
      .mock.calls.filter(([c]) => c.kind === "connector.check-attachment");
    expect(reads).toHaveLength(1);
    expect(reads[0]![0]).toEqual({ kind: "connector.check-attachment" });
    expect(h.host.querySelector(".setup-confirmation-read")?.textContent).toBe(
      "Status updated from this Dev’s saved confirmation.",
    );
    expect(
      h.host.querySelector(".setup-confirmation-read")?.getAttribute("role"),
    ).toBe("status");
  });

  it("shows the read in progress and blocks a second read", async () => {
    const h = await attach({ value: unconfirmed() });
    const reading = deferred<unknown>();
    h.reply(() => reading.promise);
    await h.click("Refresh status");
    await vi.waitFor(() => expect(h.reads()).toHaveLength(1));
    expect(h.gate().querySelector("strong")?.textContent).toBe(
      "Checking confirmation…",
    );
    const busy = h.button("Refreshing…")!;
    expect(busy.disabled).toBe(true);
    expect(busy.className).toBe("text-button");
    await act(async () =>
      reading.resolve({ ok: true, snapshot: h.configuration() }),
    );
    expect(h.button("Refresh status")!.disabled).toBe(false);
    expect(h.reads()).toHaveLength(1);
  });

  it.each([
    [
      "an applied read",
      async (h: Awaited<ReturnType<typeof attach>>) => ({
        ok: true,
        snapshot: h.configuration(),
      }),
      "Status updated from this Dev’s saved confirmation.",
    ],
    [
      "an absent confirmation",
      async (h: Awaited<ReturnType<typeof attach>>) => ({
        ok: false,
        error: "CONNECTOR_ATTACHMENT_NOT_FOUND",
        snapshot: h.configuration(),
      }),
      "No confirmation has reached this Dev. The earlier test remains unconfirmed.",
    ],
    [
      "a lost reply",
      async () => {
        throw Error(lostResult);
      },
      "The status read could not be confirmed. The saved attempt has been kept; it will not be repeated.",
    ],
    [
      "another refusal",
      async (h: Awaited<ReturnType<typeof attach>>) => ({
        ok: false,
        error: "CONNECTOR_ATTACHMENT_INVALID",
        snapshot: h.configuration(),
      }),
      "Status refreshed. No new confirmation is available; no message was sent.",
    ],
  ])("explains %s after Refresh status", async (_name, scripted, message) => {
    const h = await attach({ value: unconfirmed() });
    h.reply(() => scripted(h));
    await h.click("Refresh status");
    await vi.waitFor(() =>
      expect(
        h.host.querySelector(".setup-confirmation-read")?.textContent,
      ).toBe(message),
    );
    expect(h.reads().at(-1)).toEqual({ kind: "connector.check-attachment" });
    expect(h.button("Test in ChatGPT")).toBeTruthy();
  });
});

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred, settings } from "./fixture";
import {
  mount,
  change,
  readySettings,
  workspaceId,
  selectionId,
} from "./setup-fixture";

describe("Settings", () => {
  it("shows only General, Appearance and Keyboard shortcuts in the shell", async () => {
    const h = await mount({ page: "general", shell: true });
    const nav = h.host.querySelector('[aria-label="Settings navigation"]')!;
    expect(
      [...nav.querySelectorAll("button")].map((x) => x.textContent?.trim()),
    ).toEqual(["General", "Appearance", "Keyboard shortcuts"]);
    expect(h.host.textContent).not.toContain("Start page");
    expect(h.host.querySelector("details")).toBeNull();
    expect(h.button("Open Setup")).toBeTruthy();
    expect(h.button("Save support file…")).toBeTruthy();
    expect(h.button("Check for updates")).toBeTruthy();
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("opens Setup and exports support only after an explicit click", async () => {
    const h = await mount({ page: "general" });
    await h.click("Save support file…");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "support.export",
    });
    await h.click("Open Setup");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "overview",
    });
  });
  it.each([
    "folders",
    "computer",
    "connection",
    "diagnostics",
    "model",
  ] as const)(
    "routes retired %s links to their remaining home",
    async (page) => {
      const h = await mount({ page });
      expect(h.c.getSnapshot().destination).toMatchObject(
        page === "folders" || page === "computer"
          ? { area: "setup", setupStep: "folders" }
          : page === "connection"
            ? { area: "setup", setupStep: "connection" }
            : { area: "settings", page: "general" },
      );
      expect(h.host.querySelectorAll("details")).toHaveLength(0);
    },
  );
  it("keeps appearance and shortcut controls usable", async () => {
    const h = await mount({ page: "appearance" });
    expect(h.host.querySelector('select[aria-label="Typeface"]')).toBeTruthy();
    await act(async () =>
      h.c.navigate({ area: "settings", page: "shortcuts" }),
    );
    await h.click("Save shortcuts");
    expect(h.f.api.setNavigationShortcuts).toHaveBeenCalledTimes(1);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("uses the existing update preference and manual check routes", async () => {
    const h = await mount({ page: "general" });
    await h.click("Check for updates");
    expect(h.f.api.installedUpdate).toHaveBeenLastCalledWith({
      kind: "check",
    });
    expect(h.host.textContent).toContain("Update check completed");
  });
  it("blocks support changes across remount after an unknown result", async () => {
    const h = await mount({ page: "general" });
    h.reply(async () => {
      throw new Error("scripted transport loss");
    });
    await h.click("Save support file…");
    await h.remount();
    expect(h.button("Save support file…")?.disabled).toBe(true);
    expect(h.host.textContent).not.toContain("Diagnostics");
  });
});

describe("Workspace rows", () => {
  it("shows saved access and a real Works check without hidden detail pages", async () => {
    const value = readySettings();
    const h = await mount({ step: "folders", value });
    expect(h.host.textContent).toContain("✓ Works");
    expect(h.button("Continue")?.disabled).toBe(false);
    expect(
      h.host
        .querySelector('select[aria-label="Access for project"]')
        ?.getAttribute("value"),
    ).not.toBe("write");
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("does not promote an unchecked second workspace", async () => {
    const value = readySettings();
    value.computer.workspaces.push({
      ...value.computer.workspaces[0]!,
      workspaceId: selectionId,
      root: "/approved/second",
      accessCheck: null,
    });
    const h = await mount({ step: "folders", value });
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(h.host.querySelectorAll(".setup-success")).toHaveLength(1);
    expect(h.button("Check access")).toBeTruthy();
  });
  it("verifies immediately after the native picker and approval", async () => {
    const h = await mount({ step: "folders" });
    let value = settings();
    let rev = 1;
    h.reply((command) => {
      if (command.kind === "computer.choose-workspace")
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          evidence: { kind: "computer.workspace-pick", selectionId },
        };
      if (command.kind === "computer.add-workspace") {
        value = { ...readySettings(), revision: ++rev };
        value.connectors.secureMcp.runtime = null;
        value.computer.workspaces[0]!.access = "write";
        value.computer.workspaces[0]!.accessCheck = null;
        value.setup.computer.verified = null;
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          evidence: { kind: "computer.workspace-selection", workspaceId },
        };
      }
      if (command.kind === "computer.verify-workspace") {
        value = { ...readySettings(), revision: ++rev };
        value.computer.workspaces[0]!.access = "write";
        value.connectors.secureMcp.runtime = null;
        return { ok: true, snapshot: { status: "ready", settings: value } };
      }
      return {
        ok: false,
        error: "WORKSPACE_NOT_FOUND",
        snapshot: { status: "ready", settings: value },
      };
    });
    await h.click("+ Add workspace");
    expect(
      vi.mocked(h.f.api.configure).mock.calls.map(([c]) => c.kind),
    ).toEqual([
      "computer.choose-workspace",
      "computer.add-workspace",
      "computer.verify-workspace",
    ]);
    expect(h.host.textContent).toContain("✓ Works");
    expect(h.button("Continue")?.disabled).toBe(false);
  });
  it("never approves a cancelled picker or reuses old selection evidence", async () => {
    const h = await mount({ step: "folders" });
    h.reply(() => ({
      ok: false,
      error: "WORKSPACE_SELECTION_CANCELLED",
      snapshot: h.configuration(),
    }));
    await h.click("+ Add workspace");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.button("Continue")?.disabled).toBe(true);
  });
  it("maps Commands to the existing shared policy and stops on an unknown save", async () => {
    const value = readySettings();
    value.connectors.secureMcp.runtime = null;
    const h = await mount({ step: "folders", value });
    const lost = deferred<unknown>();
    h.reply((command) =>
      command.kind === "computer.update-commands"
        ? lost.promise
        : { ok: true, snapshot: h.configuration() },
    );
    const checkbox = h.host.querySelector<HTMLInputElement>(
      '[aria-label="Commands for project"]',
    )!;
    await act(async () => checkbox.click());
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "computer.update-commands",
      commands: "workspace",
    });
    expect(h.button("Continue")?.disabled).toBe(true);
    await act(async () =>
      lost.resolve({
        ok: false,
        error: "SETTINGS_WRITE_FAILED",
        snapshot: h.configuration(),
      }),
    );
    await h.remount();
    expect(
      h.host.querySelector<HTMLInputElement>(
        '[aria-label="Commands for project"]',
      )!.disabled,
    ).toBe(true);
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  });
});

describe("Connection", () => {
  it("keeps Connect disabled for incomplete or invalid fields", async () => {
    const h = await mount({ step: "connection" });
    expect(h.button("Connect")?.disabled).toBe(true);
    const fields = h.host.querySelectorAll<HTMLInputElement>(
      ".connection-credentials input",
    );
    await change(fields[0]!, "invalid tunnel");
    await change(fields[1]!, "synthetic-key-do-not-retain");
    expect(h.button("Connect")?.disabled).toBe(true);
    await change(fields[0]!, "synthetic-tunnel");
    expect(h.button("Connect")?.disabled).toBe(false);
  });
  it("discovers the helper, saves and connects, then checks health from one click", async () => {
    const h = await mount({ step: "connection" });
    let value = settings();
    h.reply((command) => {
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
          connectorSetup: {
            kind: command.kind,
            operationId: command.operationId,
            buildId: command.buildId,
            state: "completed",
            stoppedAt: "complete",
            credentials: "saved",
            connection: "connected",
            code: null,
            externalVerification: "not-proven",
          },
        };
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    const fields = h.host.querySelectorAll<HTMLInputElement>(
      ".connection-credentials input",
    );
    await change(fields[0]!, "synthetic-tunnel");
    await change(fields[1]!, "synthetic-key-do-not-retain");
    await h.click("Connect");
    expect(
      vi.mocked(h.f.api.configure).mock.calls.map(([c]) => c.kind),
    ).toEqual([
      "connector.discover-client",
      "connector.save-and-connect",
      "connector.check-health",
    ]);
    expect(h.host.textContent).toContain("✓ Connected");
    expect(h.button("Continue")?.disabled).toBe(false);
    expect(fields[1]!.value).toBe("");
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(
      "synthetic-key-do-not-retain",
    );
  });
  it.each([
    "CONNECTOR_CREDENTIAL_SAVE_FAILED",
    "TUNNEL_CLIENT_DISCOVERY_FAILED",
    "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  ])("shows plain failure and one recovery action for %s", async (error) => {
    const h = await mount({ step: "connection" });
    h.reply(() => ({ ok: false, error, snapshot: h.configuration() }));
    const fields = h.host.querySelectorAll<HTMLInputElement>(
      ".connection-credentials input",
    );
    await change(fields[0]!, "synthetic-tunnel");
    await change(fields[1]!, "synthetic-key-do-not-retain");
    await h.click("Connect");
    const failure = h.host.querySelector('[role="alert"]')!;
    expect(failure).toBeTruthy();
    expect(failure.querySelectorAll("button")).toHaveLength(1);
    expect(failure.textContent).not.toMatch(
      /Diagnostics|OUTCOME|CONNECTION|DISCOVERY/u,
    );
    expect(h.button("Continue")?.disabled).toBe(true);
  });
  it("does not let a failed health check enable Continue on a ready runtime", async () => {
    const h = await mount({ step: "connection", value: readySettings() });
    h.reply(() => ({
      ok: false,
      error: "CONNECTOR_POLLING_EXPIRED",
      snapshot: h.configuration(),
    }));
    await h.click("Connect");
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(h.host.textContent).not.toContain("✓ Connected");
  });
  it("does not save credentials after navigating away during helper discovery", async () => {
    const h = await mount({ step: "connection" });
    const fields = h.host.querySelectorAll<HTMLInputElement>(
      ".connection-credentials input",
    );
    await change(fields[0]!, "synthetic-tunnel");
    await change(fields[1]!, "synthetic-key-do-not-retain");
    const wait = deferred<unknown>();
    h.reply(() => wait.promise);
    await h.click("Connect");
    await h.navigate("folders");
    await act(async () =>
      wait.resolve({
        ok: true,
        snapshot: {
          status: "ready",
          settings: { ...readySettings(), revision: 2 },
        },
      }),
    );
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.c.getSnapshot().destination.setupStep).toBe("folders");
  });
  it("does not dispatch a composing credential or duplicate pending Connect", async () => {
    const h = await mount({ step: "connection" });
    const fields = h.host.querySelectorAll<HTMLInputElement>(
      ".connection-credentials input",
    );
    await change(fields[0]!, "synthetic-tunnel");
    await change(fields[1]!, "synthetic-key-do-not-retain");
    const form = h.host.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(h.f.api.configure).not.toHaveBeenCalled();
    await act(async () =>
      form.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    const pending = deferred<unknown>();
    h.reply(() => pending.promise);
    await h.click("Connect");
    await h.click("Connecting…");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve({
        ok: false,
        error: "TUNNEL_CLIENT_DISCOVERY_FAILED",
        snapshot: h.configuration(),
      }),
    );
  });
});

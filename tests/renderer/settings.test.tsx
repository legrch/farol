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
    ).toEqual(["Back to Farol", "General", "Appearance", "Keyboard shortcuts"]);
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
  it("rejects retired Settings destinations without rewriting them", async () => {
    const h = await mount({ page: "general" });
    const before = h.c.getSnapshot().destination;
    for (const page of [
      "folders",
      "computer",
      "connection",
      "diagnostics",
      "model",
    ])
      h.c.navigate({ area: "settings", page } as never);
    expect(h.c.getSnapshot().destination).toBe(before);
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
  });
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
  it("opens existing update recovery from General without an update command", async () => {
    // DOM-only modal methods; native update recovery is outside this fixture.
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const h = await mount({ page: "general", shell: true });
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await h.click("Update recovery…");
    expect(h.c.getSnapshot().overlay).toBe("update-recovery");
    expect(
      h.host.querySelector('dialog[aria-label="Update recovery"]'),
    ).toBeTruthy();
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    expect(h.f.api.configure).not.toHaveBeenCalled();
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
  it("removes a workspace from its row after the connection is stopped", async () => {
    const value = readySettings();
    value.connectors.secureMcp.runtime = null;
    const h = await mount({ step: "folders", value });
    const removed = structuredClone(value);
    removed.revision++;
    removed.computer.generation++;
    removed.computer.workspaces = [];
    h.reply(() => ({
      ok: true,
      snapshot: { status: "ready", settings: removed },
    }));
    await h.click("Remove project");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "computer.remove-workspace",
      workspaceId,
    });
    expect(h.button("Remove project")).toBeUndefined();
    expect(h.button("Continue")?.disabled).toBe(true);
  });
  it("stops a connection, changes row access, checks the grant and reconnects", async () => {
    let value = readySettings();
    const h = await mount({ step: "folders", value });
    h.reply((command) => {
      value = structuredClone(value);
      value.revision++;
      if (command.kind === "connector.stop") {
        value.connectors.secureMcp.runtime = null;
      } else if (command.kind === "computer.update-access") {
        value.computer.generation++;
        value.computer.workspaces[0]!.access = command.access;
        value.computer.workspaces[0]!.accessCheck = null;
      } else if (command.kind === "computer.verify-workspace") {
        value.computer.workspaces[0]!.accessCheck = {
          ...readySettings().computer.workspaces[0]!.accessCheck!,
          computerGeneration: value.computer.generation,
          checkId: command.checkId,
        };
      } else if (command.kind === "connector.start") {
        value.connectors.secureMcp.runtime = {
          ...readySettings().connectors.secureMcp.runtime!,
          computerGeneration: value.computer.generation,
          runtimeGeneration: "e".repeat(64),
        };
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await change(
      h.host.querySelector<HTMLSelectElement>(
        '[aria-label="Access for project"]',
      )!,
      "write",
    );
    expect(
      vi.mocked(h.f.api.configure).mock.calls.map(([command]) => command.kind),
    ).toEqual([
      "connector.stop",
      "computer.update-access",
      "computer.verify-workspace",
      "connector.start",
    ]);
    expect(
      h.host.querySelector<HTMLSelectElement>(
        '[aria-label="Access for project"]',
      )!.value,
    ).toBe("write");
  });
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
        value.computer.workspaces[0]!.access = "read";
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
        value.computer.workspaces[0]!.access = "read";
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
    expect(h.f.api.configure).toHaveBeenCalledWith({
      kind: "computer.add-workspace",
      selectionId,
      access: "read",
    });
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
  it("reconnects a previously connected tunnel after adding a verified workspace", async () => {
    let value = readySettings();
    const h = await mount({ step: "folders", value });
    h.reply((command) => {
      value = structuredClone(value);
      if (command.kind === "computer.choose-workspace")
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          evidence: { kind: "computer.workspace-pick", selectionId },
        };
      value.revision++;
      if (command.kind === "computer.add-workspace") {
        value.computer.generation++;
        value.computer.workspaces[0]!.access = "read";
        value.computer.workspaces[0]!.accessCheck = null;
        value.connectors.secureMcp.runtime = null;
        return {
          ok: true,
          snapshot: { status: "ready", settings: value },
          evidence: { kind: "computer.workspace-selection", workspaceId },
        };
      }
      if (command.kind === "computer.verify-workspace") {
        value.computer.workspaces[0]!.accessCheck = {
          ...readySettings().computer.workspaces[0]!.accessCheck!,
          computerGeneration: value.computer.generation,
          checkId: command.checkId,
        };
      }
      if (command.kind === "connector.start")
        value.connectors.secureMcp.runtime = {
          ...readySettings().connectors.secureMcp.runtime!,
          computerGeneration: value.computer.generation,
          runtimeGeneration: "e".repeat(64),
        };
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await h.click("+ Add workspace");
    expect(
      vi.mocked(h.f.api.configure).mock.calls.map(([command]) => command.kind),
    ).toEqual([
      "computer.choose-workspace",
      "computer.add-workspace",
      "computer.verify-workspace",
      "connector.start",
    ]);
  });
  it("enables Git user settings with the Commands choice and verifies the workspace", async () => {
    let value = readySettings();
    value.computer.commands = "workspace";
    value.computer.filePolicy = "approved-roots-v1";
    value.connectors.secureMcp.runtime = null;
    const h = await mount({ step: "folders", value });
    const checkbox = h.host.querySelector<HTMLInputElement>(
      '[aria-label="Commands for project"]',
    )!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(h.host.textContent).toContain(
      "including Git history, hooks and your Git configuration.",
    );
    expect(h.f.api.configure).not.toHaveBeenCalled();
    h.reply((command) => {
      value = structuredClone(value);
      value.revision++;
      const workspace = value.computer.workspaces[0]!;
      if (command.kind === "computer.update-git-history") {
        value.computer.generation++;
        workspace.gitHistoryApproved = command.approved;
      } else if (command.kind === "computer.verify-workspace") {
        workspace.accessCheck = {
          ...readySettings().computer.workspaces[0]!.accessCheck!,
          computerGeneration: value.computer.generation,
          checkId: command.checkId,
        };
        value.setup.computer.verified = {
          ...readySettings().setup.computer.verified!,
          configRevision: value.computer.generation,
        };
      }
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await act(async () => checkbox.click());
    expect(
      vi.mocked(h.f.api.configure).mock.calls.map(([command]) => command.kind),
    ).toEqual([
      "computer.verify-workspace",
      "computer.update-git-history",
      "computer.verify-workspace",
    ]);
    expect(h.f.api.configure).toHaveBeenCalledWith({
      kind: "computer.update-git-history",
      workspaceId,
      approved: true,
    });
    expect(
      h.host.querySelector<HTMLInputElement>(
        '[aria-label="Commands for project"]',
      )!.checked,
    ).toBe(true);
  });
  it("shows legacy command access as unchecked and one click begins its guarded approval", async () => {
    const value = readySettings();
    value.computer.commands = "workspace";
    value.connectors.secureMcp.runtime = null;
    const h = await mount({ step: "folders", value });
    const checkbox = h.host.querySelector<HTMLInputElement>(
      '[aria-label="Commands for project"]',
    )!;
    expect(checkbox.checked).toBe(false);
    expect(h.button("Allow workspace commands")).toBeUndefined();
    expect(h.f.api.configure).not.toHaveBeenCalled();
    const lost = deferred<unknown>();
    h.reply(() => lost.promise);
    await act(async () => checkbox.click());
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "computer.update-file-policy",
      filePolicy: "approved-roots-v1",
    });
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
  it("maps Commands to the existing shared policy and stops on an unknown save", async () => {
    const value = readySettings();
    value.computer.filePolicy = "approved-roots-v1";
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
  it("stops the current connection before replacing credentials and never continues after a refused stop", async () => {
    const h = await mount({ step: "connection", value: readySettings() });
    h.reply(() => ({
      ok: false,
      error: "CONNECTOR_RUNTIME_UNREACHABLE",
      snapshot: h.configuration(),
    }));
    await change(
      h.host.querySelector<HTMLInputElement>(
        '.connection-credentials input[type="password"]',
      )!,
      "synthetic-replacement-key",
    );
    await h.click("Save and connect");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "connector.stop",
    });
    expect(h.button("Disconnect")?.disabled).toBe(false);
  });
  it("disconnects once and withdraws connection success after the saved stop", async () => {
    const value = readySettings();
    const h = await mount({ step: "connection", value });
    const pending = deferred<unknown>();
    h.reply(() => pending.promise);
    expect(h.button("Disconnect")?.disabled).toBe(false);
    await h.click("Disconnect");
    await h.click("Disconnect");
    expect(h.button("Disconnect")?.disabled).toBe(true);
    expect(h.button("Connect")?.disabled).toBe(true);
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "connector.stop",
    });
    const stopped = structuredClone(value);
    stopped.revision++;
    stopped.connectors.secureMcp.runtime = null;
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: { status: "ready", settings: stopped },
      }),
    );
    expect(h.button("Disconnect")).toBeUndefined();
    expect(h.host.textContent).not.toContain("✓ Connected");
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(h.button("Connect")?.disabled).toBe(false);
  });
  it.each(["transport", "save"])(
    "retains the disconnect %s unknown fence across navigation, refresh and remount",
    async (failure) => {
      const value = readySettings();
      const h = await mount({ step: "connection", value });
      h.reply(() => {
        if (failure === "transport") throw new Error("scripted stop loss");
        return {
          ok: false,
          error: "SETTINGS_WRITE_FAILED",
          snapshot: h.configuration(),
        };
      });
      await h.click("Disconnect");
      expect(h.button("Disconnect")?.disabled).toBe(true);
      expect(h.button("Connect")?.disabled).toBe(true);
      expect(h.button("Continue")?.disabled).toBe(true);
      await h.navigate("folders");
      await h.navigate("connection");
      await act(async () => h.c.refresh());
      await h.remount();
      await h.click("Disconnect");
      await h.click("Connect");
      expect(h.button("Disconnect")?.disabled).toBe(true);
      expect(h.button("Connect")?.disabled).toBe(true);
      expect(h.f.api.configure).toHaveBeenCalledTimes(1);
      expect(h.host.textContent).toContain("could not be confirmed");
    },
  );
  it("offers disconnect for an unhealthy retained runtime, but fences unknown runtime state", async () => {
    const value = readySettings();
    value.connectors.secureMcp.runtime!.state = "unreachable";
    const h = await mount({ step: "connection", value });
    expect(h.button("Disconnect")?.disabled).toBe(false);
    value.revision++;
    value.connectors.secureMcp.runtime!.state = "outcome_unknown";
    await h.publish(value);
    expect(h.button("Disconnect")?.disabled).toBe(true);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
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
    await act(async () => {
      await h.c.configure(
        { kind: "connector.check-health" },
        "settings:connector.check-health:",
      );
    });
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

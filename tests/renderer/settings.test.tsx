import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/ui/renderer/settings";
import { WindowController } from "../../src/ui/renderer/controller";
import type { SettingsPage } from "../../src/ui/renderer/contract";
import {
  ProductConfigurationCommandSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { bootstrap, deferred, fixture, settings } from "./fixture";

// DOM/adapter fixtures only: no native chooser, filesystem, provider or updater proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const controllers: WindowController[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const c of controllers.splice(0)) c.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const workspaceId = "22222222-2222-4222-8222-222222222222";
const selectionId = "33333333-3333-4333-8333-333333333333";
function withFolder() {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: ["/approved/project/private"],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  return ProductSettingsSchema.parse(value);
}
async function mount(
  page: SettingsPage = "general",
  value: ProductSettings = settings(),
  environment: "preview" | "dev" = "preview",
) {
  const f = fixture();
  const configuration = { status: "ready" as const, settings: value };
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    environment,
    configuration,
  });
  vi.mocked(f.api.configure).mockResolvedValue({
    ok: true,
    snapshot: configuration,
  });
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "settings", page });
  controllers.push(c);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return snapshot.destination.area === "settings" ? (
      <Settings snapshot={snapshot} facade={c} />
    ) : null;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    ),
  );
  const visible = (element: Element) => !element.closest("div[hidden]");
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (item) => visible(item) && item.textContent === text,
    );
    if (!found) throw new Error(`Button not found: ${text}`);
    return found;
  };
  const field = (text: string) => {
    const label = [...host.querySelectorAll("label")].find(
      (item) =>
        visible(item) &&
        [...item.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim() === text,
    );
    const found = label?.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,select,textarea");
    if (!found) throw new Error(`Field not found: ${text}`);
    return found;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const pageTo = async (next: SettingsPage) => {
    await act(async () => c.navigate({ page: next }));
  };
  const calls = () =>
    vi.mocked(f.api.configure).mock.calls.map(([command]) => command);
  return {
    f,
    c,
    host,
    root,
    button,
    field,
    click,
    pageTo,
    calls,
    configuration,
    async remount() {
      await act(async () => root.render(null));
      await act(async () =>
        root.render(
          <StrictMode>
            <View />
          </StrictMode>,
        ),
      );
    },
  };
}
async function change(
  field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
function proof(value: ProductSettings) {
  return {
    profile: "farol-next",
    configRevision: value.computer.generation,
    workspaceId,
    runtimeGeneration: "a".repeat(64),
    buildId: "3".repeat(64),
    protocol: "secure-mcp",
    verifiedAt: "2026-10-02T20:00:00.000Z",
  };
}
function connectionSettings() {
  const value = withFolder();
  const timestamp = "2026-10-02T20:00:00.000Z";
  const buildId = "3".repeat(64),
    runtimeGeneration = "a".repeat(64);
  value.setup.chatgpt.verified = proof(value);
  value.setup.computer.verified = proof(value);
  value.setup.computer.reachable = "reachable";
  value.setup.connect.verified = proof(value);
  const connector = value.connectors.secureMcp;
  connector.tunnelId = "owner-tunnel";
  connector.credential = "stored";
  connector.tunnelClient = {
    executablePath: "/approved/tunnel",
    executableSha256: "b".repeat(64),
    version: "1.0.0",
    protocol: "openai-tunnel-client/v1",
    verifiedAt: timestamp,
  };
  connector.runtime = {
    state: "ready",
    connectorGeneration: 1,
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    observedAt: timestamp,
  };
  connector.challenge = {
    value: selectionId,
    challengeSha256: "c".repeat(64),
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    preparedAt: timestamp,
  };
  connector.chatgptApp = {
    name: "My Farol",
    tunnelId: "owner-tunnel",
    connectorGeneration: 1,
  };
  connector.attachment = {
    tunnelId: "owner-tunnel",
    workspaceId,
    connectorGeneration: 1,
    runtimeGeneration,
    computerGeneration: 1,
    buildId,
    challengeSha256: "c".repeat(64),
    receiptSha256: "d".repeat(64),
    verifiedAt: timestamp,
  };
  return value;
}
describe("bounded Settings writer", () => {
  it("renders all nine approved pages in StrictMode without effects or saves", async () => {
    const h = await mount();
    for (const page of [
      "general",
      "appearance",
      "folders",
      "computer",
      "connection",
      "model",
      "shortcuts",
      "updates",
      "diagnostics",
    ] as const)
      await h.pageTo(page);
    expect(
      [...h.host.querySelectorAll("h2")].map((node) => node.textContent),
    ).toEqual([
      "General",
      "Appearance",
      "Folders",
      "This Mac",
      "Connection",
      "Model",
      "Shortcuts",
      "Updates",
      "Diagnostics",
    ]);
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.f.api.installedUpdate).toHaveBeenCalledTimes(1); // Window bootstrap status only.
    await act(async () => h.root.unmount());
    roots.splice(roots.indexOf(h.root), 1);
    expect(h.f.listeners.size).toBe(10);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("keeps a draft across background events and page changes; saves only explicit navigation", async () => {
    const value = settings();
    value.general.activityDetail = "technical";
    const h = await mount("general", value);
    await change(h.field("Start page"), "settings");
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.pageTo("folders");
    await h.pageTo("general");
    expect(h.field("Start page").value).toBe("settings");
    expect(h.calls()).toEqual([]);
    await h.click("Save navigation");
    expect(h.calls()).toEqual([
      {
        kind: "general.update",
        openAtLaunch: "settings",
        sidebarDefault: "full",
        activityDetail: "technical",
      },
    ]);
    expect(h.host.textContent).toContain(
      "Remembering the last choice is not supported",
    );
  });
  it("changes appearance through facade only on user selection", async () => {
    const h = await mount("appearance");
    await h.click("Light");
    expect(h.button("Light").getAttribute("aria-pressed")).toBe("true");
    await h.click("System");
    expect(h.button("System").getAttribute("aria-pressed")).toBe("true");
    await h.click("Graphite");
    expect(h.button("Graphite").getAttribute("aria-pressed")).toBe("true");
    await change(h.field("Accent"), "amber");
    await change(h.field("Font"), "system");
    expect(h.c.getSnapshot().appearance).toEqual({
      theme: "graphite",
      accent: "amber",
      font: "system",
    });
    expect(h.calls()).toEqual([]);
  });
  it("adds only a newly evidenced native selection and starts read-only without granting access", async () => {
    const h = await mount("folders");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: { kind: "computer.workspace-pick", selectionId },
    });
    await h.click("Add folder…");
    expect(h.calls()).toEqual([{ kind: "computer.choose-workspace" }]);
    await h.click("Add selected folder read-only");
    expect(h.calls()[1]).toEqual({
      kind: "computer.add-workspace",
      selectionId,
    });
    expect(
      h
        .calls()
        .every(
          (command) =>
            ProductConfigurationCommandSchema.safeParse(command).success,
        ),
    ).toBe(true);
  });
  it.each(["folders", "model"] as const)(
    "does not adopt another facade intention's %s evidence",
    async (page) => {
      const h = await mount(page);
      const waiting = deferred<unknown>();
      const ownEvidence =
        page === "folders"
          ? { kind: "computer.workspace-pick", selectionId }
          : {
              kind: "model.config-preview",
              configPath: "/approved/config.toml",
              providerBlockStatus: "install",
              providerSelectionRequested: false,
            };
      vi.mocked(h.f.api.configure)
        .mockReturnValueOnce(waiting.promise)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: h.configuration,
          evidence: ownEvidence,
        });
      await h.click(
        page === "folders" ? "Add folder…" : "Preview model configuration",
      );
      await act(async () => {
        await h.c.configure(
          page === "folders"
            ? { kind: "computer.choose-workspace" }
            : { kind: "model.preview", selectAsDefault: false },
          "another-parent-intention",
        );
      });
      await act(async () =>
        waiting.resolve({
          ok: true,
          snapshot: h.configuration,
          evidence: ownEvidence,
        }),
      );
      if (page === "folders")
        expect(h.host.textContent).not.toContain(
          "Add selected folder read-only",
        );
      else expect(h.button("Apply reviewed configuration").disabled).toBe(true);
      expect(h.calls()).toHaveLength(2);
    },
  );
  it("never adds a cancelled picker or reuses evidence invalidated by refresh", async () => {
    const h = await mount("folders");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "WORKSPACE_PICKER_CANCELLED",
      snapshot: h.configuration,
    });
    await h.click("Add folder…");
    expect(h.button("Add folder…").disabled).toBe(false); // A deliberate retry may follow a known refusal; rendering never retries.
    expect(h.host.textContent).not.toContain("Add selected folder read-only");
    expect(h.calls()).toHaveLength(1);
    const other = await mount("folders");
    vi.mocked(other.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: other.configuration,
      evidence: { kind: "computer.workspace-pick", selectionId },
    });
    await other.click("Add folder…");
    await act(async () => other.c.refresh());
    expect(other.host.textContent).not.toContain(
      "Add selected folder read-only",
    );
    expect(other.host.textContent).toContain("selection is no longer current");
  });
  it("fences duplicate, unknown and stale actions without a retry", async () => {
    const h = await mount("folders");
    const wait = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
    await act(async () => {
      h.button("Add folder…").click();
      h.button("Add folder…").click();
    });
    expect(h.calls()).toHaveLength(1);
    await act(async () => wait.reject(new Error("private failure payload")));
    expect(h.button("Add folder…").disabled).toBe(true);
    await h.click("Add folder…");
    await act(async () => h.c.refresh());
    expect(h.button("Add folder…").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    expect(h.host.textContent).toContain("Outcome unknown");
    expect(h.host.textContent).not.toContain("private failure payload");
    const stale = await mount("folders");
    await act(async () =>
      stale.f.emit("runtime", {
        state: "offline",
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      }),
    );
    await stale.click("Add folder…");
    expect(stale.calls()).toHaveLength(0);
  });
  it("keeps exclusions stable during IME and validates relative paths before saving", async () => {
    const h = await mount("folders", withFolder());
    const input = h.field("Excluded paths for project");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await change(input, "private\ncache");
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.click("Save exclusions");
    expect(h.calls()).toEqual([]);
    expect(input.value).toBe("private\ncache");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await h.click("Save exclusions");
    expect(h.calls()[0]).toEqual({
      kind: "computer.update-exclusions",
      workspaceId,
      excludedPaths: ["private", "cache"],
    });
    await change(input, "../secret");
    await h.click("Save exclusions");
    expect(h.calls()).toHaveLength(1);
    await change(input, "private\nprivate");
    await h.click("Save exclusions");
    expect(h.calls()).toHaveLength(1);
  });
  it("separates guarded writes, expanded Git approval and access/workspace checks", async () => {
    const h = await mount("folders", withFolder());
    await h.click("Allow guarded changes");
    await h.click("Approve expanded Git access");
    await h.click("Check access");
    await h.click("Verify workspace");
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "write" },
      { kind: "computer.update-git-history", workspaceId, approved: true },
      { kind: "computer.check-folder", workspaceId },
      { kind: "computer.verify-workspace", workspaceId },
    ]);
    expect(h.host.textContent).toContain("Check access needed");
  });
  it("rejects stale folder checks and retains a draft when scope changes", async () => {
    const value = withFolder();
    value.setup.computer.verified = proof(value);
    value.setup.computer.reachable = "reachable";
    const h = await mount("folders", value);
    expect(h.host.textContent).toContain("Access checked");
    const input = h.field("Excluded paths for project");
    await change(input, "draft");
    const next = structuredClone(value);
    next.revision++;
    next.computer.generation++;
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: { status: "ready", settings: next },
    });
    await act(async () => h.c.refresh());
    expect(input.value).toBe("draft");
    expect(h.button("Save exclusions").disabled).toBe(true);
    expect(h.host.textContent).toContain("Check access needed");
    await h.click("Reload saved exclusions");
    expect(input.value).toBe("private");
    expect(h.button("Save exclusions").disabled).toBe(false);
  });
  it("uses all real command policies and never performs an Astra host check", async () => {
    const h = await mount("computer");
    for (const commands of ["verification", "workspace", "none"]) {
      await change(h.field("Command policy"), commands);
      await h.click("Apply command policy");
    }
    expect(h.calls()).toEqual(
      ["verification", "workspace", "none"].map((commands) => ({
        kind: "computer.update-commands",
        commands,
      })),
    );
    expect(h.calls().some((command) => command.kind.startsWith("host."))).toBe(
      false,
    );
    expect(h.host.textContent).toContain("Both exclude network access");
  });
  it("keeps credentials in explicit input only, saves explicitly, and clears the field", async () => {
    const h = await mount("connection");
    const secret = "explicit-test-key-000000000000";
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await change(h.field("Runtime key"), secret);
    await act(async () => h.f.emit("route", { state: "loaded" }));
    expect(h.calls()).toEqual([]);
    expect(h.field("Runtime key").value).toBe(secret);
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
    expect(h.host.textContent).not.toContain(secret);
    await h.click("Save connection");
    expect(h.calls()).toEqual([
      {
        kind: "connector.configure",
        tunnelId: "owner-tunnel",
        runtimeKey: secret,
      },
    ]);
    expect(h.field("Runtime key").value).toBe("");
    await h.click("Save connection");
    expect(h.calls()[1]).toEqual({
      kind: "connector.configure",
      tunnelId: "owner-tunnel",
      runtimeKey: null,
    });
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(secret);
  });
  it("does not clear or submit a composing credential", async () => {
    const h = await mount("connection");
    const input = h.field("Runtime key");
    await change(h.field("Tunnel ID"), "owner-tunnel");
    await act(async () =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await change(input, "explicit-test-key-000000000000");
    await h.click("Save connection");
    expect(input.value).toBe("explicit-test-key-000000000000");
    expect(h.calls()).toEqual([]);
  });
  it("does not label a running local service Ready without current attachment evidence", async () => {
    const h = await mount("connection", withFolder());
    expect(h.c.getSnapshot().runtime).toBe("ready");
    expect(
      h.host.querySelector('section[aria-label="This Mac connection"] .badges')
        ?.textContent,
    ).not.toBe("Computer ready");
    expect(h.button("Start connection").disabled).toBe(true);
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
    await h.click("Sign in");
    await h.click("Choose tunnel client…");
    expect(h.calls()).toEqual([
      { kind: "chatgpt.open-sign-in" },
      { kind: "connector.select-client" },
    ]);
  });
  it("requires current correlated attachment for Ready and sends a Dev app check once", async () => {
    const value = connectionSettings();
    const h = await mount("connection", value, "dev");
    const badge = () =>
      h.host.querySelector('section[aria-label="This Mac connection"] .badges')
        ?.textContent;
    expect(badge()).toBe("Computer ready");
    await h.click("Check attachment");
    await h.click("Check local connection");
    await h.click("Check in ChatGPT once");
    await h.click("Check in ChatGPT once");
    expect(h.calls()).toEqual([
      { kind: "connector.check-attachment" },
      { kind: "connector.check-health" },
      { kind: "connector.verify-app" },
    ]);
    const next = structuredClone(value);
    next.revision++;
    next.connectors.secureMcp.runtime!.runtimeGeneration = "e".repeat(64);
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      environment: "dev",
      configuration: { status: "ready", settings: next },
    });
    await act(async () => h.c.refresh());
    expect(badge()).toBe("Connection check needed");
    next.setup.connect.outcomeUnknown = true;
    await act(async () => h.c.refresh());
    expect(badge()).toBe("Outcome unknown");
    expect(h.button("Check attachment").disabled).toBe(true);
    expect(h.calls().some((command) => command.kind.startsWith("host."))).toBe(
      false,
    );
  });

  it("binds app selection to exact current tunnel/generation and checks only Dev", async () => {
    const value = withFolder();
    value.connectors.secureMcp.tunnelId = "owner-tunnel";
    const h = await mount("connection", value, "dev");
    await change(h.field("ChatGPT app name"), "My Farol");
    await h.click("Select ChatGPT app");
    expect(h.calls()).toEqual([
      {
        kind: "connector.select-chatgpt-app",
        name: "My Farol",
        tunnelId: "owner-tunnel",
        connectorGeneration: 1,
      },
    ]);
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
  });
  it("requires an explicit matching current model preview before Apply and hides raw config", async () => {
    const h = await mount("model");
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    const preview = {
      kind: "model.config-preview",
      configPath: "/approved/config.toml",
      providerBlockStatus: "install",
      providerSelectionRequested: false,
      providerBlockDiff: "untrusted-private-literal",
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview,
    });
    await h.click("Preview model configuration");
    expect(h.button("Apply reviewed configuration").disabled).toBe(false);
    expect(h.host.textContent).not.toContain("untrusted-private-literal");
    await h.click("Apply reviewed configuration");
    expect(h.calls()).toEqual([
      { kind: "model.preview", selectAsDefault: false },
      { kind: "model.apply", selectAsDefault: false },
    ]);
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    await h.click("Roll back managed configuration");
    expect(h.calls()[2]).toEqual({ kind: "model.rollback" });
  });
  it.each(["conflict", "insecure_permissions", "symlink", "malformed"])(
    "blocks unsafe model preview %s",
    async (providerBlockStatus) => {
      const h = await mount("model");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: {
          kind: "model.config-preview",
          configPath: "/approved/config.toml",
          providerBlockStatus,
          providerSelectionRequested: false,
        },
      });
      await h.click("Preview model configuration");
      expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    },
  );
  it("invalidates model review after background refresh or changing default selection", async () => {
    const h = await mount("model");
    const response = {
      ok: true,
      snapshot: h.configuration,
      evidence: {
        kind: "model.config-preview",
        configPath: "/approved/config.toml",
        providerBlockStatus: "install",
        providerSelectionRequested: false,
      },
    };
    vi.mocked(h.f.api.configure).mockResolvedValue(response);
    await h.click("Preview model configuration");
    await act(async () => h.c.refresh());
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
    await h.click("Preview model configuration");
    const check = h.host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => check.click());
    expect(h.button("Apply reviewed configuration").disabled).toBe(true);
  });
  it("reports shortcut gap and opens update review without restart; checks once", async () => {
    const h = await mount("shortcuts");
    expect(h.host.textContent).toContain("Section keys use ⌘");
    expect(h.f.api.setNavigationShortcuts).not.toHaveBeenCalled();
    await h.pageTo("updates");
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await h.click("Review update");
    expect(h.c.getSnapshot().overlay).toBe("update");
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    await h.click("Check for updates once");
    await h.click("Check for updates once");
    expect(h.f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "check",
    });
  });
  it("exports diagnostics explicitly and observes only the existing pending edit", async () => {
    const h = await mount("diagnostics");
    await h.click("Export support diagnostics…");
    expect(h.calls()).toEqual([{ kind: "support.export" }]);
    const value = withFolder();
    value.computer.pendingEdit = {
      operationId: selectionId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-02T20:00:00.000Z",
    };
    const pending = await mount("diagnostics", value);
    expect(pending.button("Export support diagnostics…").disabled).toBe(true);
    await pending.click("Observe existing edit");
    expect(pending.calls()).toEqual([
      { kind: "computer.observe-workspace-edit", operationId: selectionId },
    ]);
  });
});
it("R35 configurable shortcut form rejects duplicate keys and saves explicitly once", async () => {
  const h = await mount("shortcuts");
  const computer = h.host.querySelector<HTMLSelectElement>(
    '[aria-label="This Mac shortcut"]',
  )!;
  await change(computer, "1");
  await h.click("Save shortcuts");
  expect(h.host.textContent).toContain("Choose distinct section keys");
  expect(h.f.api.setNavigationShortcuts).not.toHaveBeenCalled();
  await change(computer, "2");
  const sidebar = h.host.querySelector<HTMLSelectElement>(
    '[aria-label="Toggle sidebar shortcut"]',
  )!;
  await change(sidebar, "b");
  await h.click("Save shortcuts");
  expect(h.f.api.setNavigationShortcuts).toHaveBeenCalledExactlyOnceWith({
    browser: 1,
    computer: 2,
    activity: 3,
    settings: 4,
    sidebar: "b",
  });
  expect(h.host.textContent).toContain("Shortcuts saved and active");
  await h.click("Restore default choices");
  expect(sidebar.value).toBe("s");
});
it("R18 a known refusal permits deliberate retry after resolving the cause, with no render retry", async () => {
  const h = await mount("general");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: false,
    error: "SETTINGS_INPUT_INVALID",
    snapshot: h.configuration,
  });
  await h.click("Save navigation");
  expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  await h.pageTo("appearance");
  await h.pageTo("general");
  expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  await act(async () => h.c.refresh());
  await h.click("Save navigation");
  expect(h.f.api.configure).toHaveBeenCalledTimes(2);
});

it("R25 R29 unavailable facade projection retains dirty forms and fences commands", async () => {
  const h = await mount("general");
  const snapshot = h.c.getSnapshot();
  const render = async (
    configuration: typeof snapshot.configuration,
    status: typeof snapshot.status,
  ) =>
    act(async () =>
      h.root.render(
        <StrictMode>
          <Settings
            snapshot={{ ...snapshot, configuration, status }}
            facade={h.c}
          />
        </StrictMode>,
      ),
    );
  await render(snapshot.configuration, "current");
  const field = h.field("Start page");
  await change(field, "activity");
  await render({ status: "error", error: "SETTINGS_READ_FAILED" }, "stale");
  expect(h.field("Start page")).toBe(field);
  expect(field.value).toBe("activity");
  expect(h.host.textContent).toContain("Your drafts are retained");
  expect(h.button("Save navigation").disabled).toBe(true);
  await h.click("Save navigation");
  expect(h.calls()).toEqual([]);
  await render({ status: "ready", settings: settings(2) }, "current");
  expect(h.field("Start page")).toBe(field);
  expect(field.value).toBe("activity");
  expect(h.button("Save navigation").disabled).toBe(false);
  expect(h.calls()).toEqual([]);
});

const editOperationId = "44444444-4444-4444-8444-444444444444";
function writableFolder() {
  const value = withFolder();
  value.computer.workspaces[0]!.access = "write";
  value.setup.computer.verified = proof(value);
  value.setup.computer.reachable = "reachable";
  return value;
}
function editPreview(operationId = editOperationId) {
  return {
    kind: "computer.workspace-edit-preview" as const,
    operationId,
    workspaceId,
    relativePath: "file.txt",
    bytes: 123,
    beforeSha256: "b".repeat(64),
    expiresAt: "2099-10-04T20:00:00.000Z",
  };
}
type SettingsHarness = Awaited<ReturnType<typeof mount>>;
async function prepareEdit(
  h: SettingsHarness,
  evidence: unknown = editPreview(),
) {
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: h.configuration,
    evidence,
  });
  await h.click("Prepare edit…");
}
describe("R07 R15 R17 R20 guarded edit controls (injected DOM only)", () => {
  it("prepares explicitly, presents metadata as text, and applies one bounded replacement", async () => {
    const h = await mount("folders", writableFolder());
    expect(h.calls()).toEqual([]);
    expect(h.button("Apply edit").disabled).toBe(true);
    await prepareEdit(h, {
      ...editPreview(),
      relativePath: "<script>alert(1)</script>.txt",
    });
    expect(h.host.querySelector("script")).toBeNull();
    expect(h.host.textContent).toContain("123 bytes");
    expect(h.host.textContent).toContain("b".repeat(64));
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await change(h.field("Old text"), "exact\nold text");
    await change(h.field("New text"), "replacement\ntext");
    expect(h.button("Apply edit").disabled).toBe(false);
    await h.click("Apply edit");
    await h.click("Apply edit");
    expect(h.calls()).toEqual([
      { kind: "computer.prepare-workspace-edit", workspaceId },
      {
        kind: "computer.apply-workspace-edit",
        operationId: editOperationId,
        oldText: "exact\nold text",
        newText: "replacement\ntext",
      },
    ]);
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.field("Old text").value).toBe("exact\nold text");
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain("Use Diagnostics");
  });
  it("uses the original schema bounds and permits an empty replacement", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    expect(h.field("Old text").getAttribute("maxlength")).toBe("32768");
    expect(h.field("New text").getAttribute("maxlength")).toBe("32768");
    await change(h.field("Old text"), "x".repeat(32_769));
    expect(h.button("Apply edit").disabled).toBe(true);
    await change(h.field("Old text"), "x");
    await change(h.field("New text"), "y".repeat(32_769));
    expect(h.button("Apply edit").disabled).toBe(true);
    await change(h.field("New text"), "");
    await h.click("Apply edit");
    expect(h.calls()[1]).toEqual({
      kind: "computer.apply-workspace-edit",
      operationId: editOperationId,
      oldText: "x",
      newText: "",
    });
  });
  it.each([
    "read",
    "unverified",
    "wrong-build",
    "wrong-generation",
    "wrong-workspace",
    "missing-identity",
    "unknown",
    "unchecked",
  ])("requires verified current write access: %s", async (condition) => {
    const value = writableFolder();
    const folder = value.computer.workspaces[0]!;
    if (condition === "read") folder.access = "read";
    if (condition === "unverified") value.setup.computer.verified = null;
    if (condition === "wrong-build")
      value.setup.computer.verified!.buildId = "c".repeat(64);
    if (condition === "wrong-generation") value.computer.generation++;
    if (condition === "wrong-workspace")
      value.setup.computer.verified!.workspaceId = selectionId;
    if (condition === "missing-identity") delete folder.rootIdentity;
    if (condition === "unknown") value.setup.computer.outcomeUnknown = true;
    if (condition === "unchecked") folder.accessCheck = null;
    const h = await mount("folders", value);
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toEqual([]);
  });
  it("cancels only the selected operation explicitly, with no mount/page cancellation", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    await h.pageTo("general");
    await h.pageTo("folders");
    expect(h.calls()).toHaveLength(1);
    await h.click("Cancel edit");
    await h.click("Cancel edit");
    expect(h.calls()[1]).toEqual({
      kind: "computer.cancel-workspace-edit",
      operationId: editOperationId,
    });
    expect(h.calls()).toHaveLength(2);
    expect(h.button("Apply edit").disabled).toBe(true);
  });
  it("requires a fresh correlated Prepare to regain the same unconsumed preview after remount", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    await h.remount();
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    await prepareEdit(h);
    expect(h.button("Cancel edit").disabled).toBe(false);
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(false);
    expect(h.calls()).toHaveLength(2);
  });
  it("regains a reused preview only by explicit Prepare after leaving Settings", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    await act(async () => h.c.navigate({ area: "home" }));
    expect(h.host.textContent).toBe("");
    await act(async () => h.c.navigate({ area: "settings", page: "folders" }));
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    await prepareEdit(h);
    expect(h.button("Cancel edit").disabled).toBe(false);
    await h.click("Cancel edit");
    expect(h.calls()[2]).toEqual({
      kind: "computer.cancel-workspace-edit",
      operationId: editOperationId,
    });
  });
  it.each([
    "workspaceId",
    "relativePath",
    "beforeSha256",
    "bytes",
    "expiresAt",
  ] as const)(
    "rejects changed metadata for the same ambient operation: %s",
    async (field) => {
      const h = await mount("folders", writableFolder());
      await prepareEdit(h);
      await h.remount();
      const changed = {
        workspaceId: selectionId,
        relativePath: "other.txt",
        beforeSha256: "c".repeat(64),
        bytes: 125,
        expiresAt: "2099-10-05T20:00:00.000Z",
      };
      await prepareEdit(h, {
        ...editPreview(),
        [field]: changed[field],
      });
      expect(h.button("Apply edit").disabled).toBe(true);
      expect(h.button("Cancel edit").disabled).toBe(true);
    },
  );
  it.each(["foreign-workspace", "expired", "malformed", "absent"])(
    "rejects mismatched or missing preview: %s",
    async (condition) => {
      const h = await mount("folders", writableFolder());
      const evidence =
        condition === "absent"
          ? undefined
          : {
              ...editPreview(),
              ...(condition === "foreign-workspace"
                ? { workspaceId: selectionId }
                : {}),
              ...(condition === "expired"
                ? { expiresAt: "2020-01-01T00:00:00.000Z" }
                : {}),
              ...(condition === "malformed"
                ? { beforeSha256: "bad-hash" }
                : {}),
            };
      // Do not use the default argument for the absent-evidence fixture.
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        ...(evidence ? { evidence } : {}),
      });
      await h.click("Prepare edit…");
      await change(h.field("Old text"), "old");
      expect(h.button("Apply edit").disabled).toBe(true);
      expect(h.button("Cancel edit").disabled).toBe(true);
      await h.click("Apply edit");
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("fences a pending Prepare and Apply synchronously across duplicate clicks", async () => {
    const h = await mount("folders", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    await change(h.field("Old text"), "old");
    const apply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(apply.promise);
    await act(async () => {
      h.button("Apply edit").click();
      h.button("Apply edit").click();
      h.button("Cancel edit").click();
    });
    expect(h.calls()).toHaveLength(2);
    await act(async () =>
      apply.resolve({ ok: true, snapshot: h.configuration }),
    );
  });
  it.each(["refused", "unknown"])(
    "consumes Apply permanently after %s",
    async (outcome) => {
      const h = await mount("folders", writableFolder());
      await prepareEdit(h);
      await change(h.field("Old text"), "old");
      if (outcome === "refused")
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: false,
          error: "WORKSPACE_MUTATION_PREVIEW_NOT_FOUND",
          snapshot: h.configuration,
        });
      else
        vi.mocked(h.f.api.configure).mockRejectedValueOnce(
          new Error("lost response"),
        );
      await h.click("Apply edit");
      await h.pageTo("general");
      await h.pageTo("folders");
      await h.click("Apply edit");
      expect(h.calls()).toHaveLength(2);
      expect(h.button("Apply edit").disabled).toBe(true);
      if (outcome === "unknown") {
        await h.click("Prepare edit…");
        expect(h.calls()).toHaveLength(2);
      } else {
        await prepareEdit(h); // A repeated consumed operation is never a new edit.
        expect(h.button("Apply edit").disabled).toBe(true);
      }
    },
  );
  it("blocks every Settings command after an unknown Prepare, including after remount", async () => {
    const h = await mount("folders", writableFolder());
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("lost response"),
    );
    await h.click("Prepare edit…");
    await h.remount();
    await h.click("Prepare edit…");
    await h.pageTo("general");
    await h.click("Save navigation");
    expect(h.calls()).toHaveLength(1);
  });
  it("allows a distinct new explicit edit after a known completion", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    await h.click("Apply edit");
    await prepareEdit(h, editPreview(selectionId));
    await h.click("Apply edit");
    expect(h.calls()).toHaveLength(4);
    expect(h.calls()[3]).toEqual({
      kind: "computer.apply-workspace-edit",
      operationId: selectionId,
      oldText: "old",
      newText: "",
    });
  });
  it("R25 R29 retains nodes, drafts, caret and IME across background and page changes", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    const old = h.field("Old text") as HTMLTextAreaElement;
    const replacement = h.field("New text");
    await change(old, "old\ntext");
    await change(replacement, "new\ntext");
    old.focus();
    old.setSelectionRange(2, 5);
    await act(async () =>
      old.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await act(async () => h.f.emit("route", { state: "loaded" }));
    await h.click("Apply edit");
    await h.click("Cancel edit");
    expect(h.calls()).toHaveLength(1);
    await h.pageTo("general");
    await h.pageTo("folders");
    expect(h.field("Old text")).toBe(old);
    expect(old.value).toBe("old\ntext");
    expect(old.selectionStart).toBe(2);
    expect(old.selectionEnd).toBe(5);
    expect(h.field("New text")).toBe(replacement);
    expect(replacement.value).toBe("new\ntext");
    await act(async () =>
      old.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await h.click("Apply edit");
    expect(h.calls()).toHaveLength(2);
  });
  it("rejects a refresh racing Prepare, even at the same revision", async () => {
    const h = await mount("folders", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await act(async () => h.c.refresh());
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.host.textContent).toContain("could not be confirmed");
  });
  it("rejects evidence after any foreign command transition during Prepare", async () => {
    const h = await mount("folders", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Prepare edit…");
    await act(async () =>
      h.c.configure({ kind: "support.export" }, "foreign:command"),
    );
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: editPreview(),
      }),
    );
    expect(h.button("Cancel edit").disabled).toBe(true);
    expect(h.host.textContent).toContain("could not be confirmed");
  });
  it.each([
    "revision",
    "generation",
    "read",
    "build",
    "stale",
    "expired",
    "foreign-evidence",
  ])(
    "rechecks the latest facade at click time, despite old rendered eligibility: %s",
    async (condition) => {
      const h = await mount("folders", writableFolder());
      await prepareEdit(h);
      await change(h.field("Old text"), "old");
      const current = h.c.getSnapshot();
      const configuration = structuredClone(h.configuration);
      const next = { ...current, configuration };
      if (condition === "revision") configuration.settings.revision++;
      if (condition === "generation")
        configuration.settings.computer.generation++;
      if (condition === "read")
        configuration.settings.computer.workspaces[0]!.access = "read";
      if (condition === "build") next.buildId = "c".repeat(64);
      if (condition === "stale") next.status = "stale";
      if (condition === "foreign-evidence" || condition === "expired")
        next.evidence = {
          revision: configuration.settings.revision,
          value: {
            ...editPreview(),
            ...(condition === "expired"
              ? { expiresAt: "2020-01-01T00:00:00.000Z" }
              : { operationId: selectionId }),
          },
        };
      vi.spyOn(h.c, "getSnapshot").mockReturnValue(next);
      await h.click("Apply edit");
      await h.click("Cancel edit");
      await h.click("Prepare edit…");
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("retains drafts but invalidates the review after an ordinary same-revision refresh", async () => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    const old = h.field("Old text");
    await change(old, "draft");
    await act(async () => h.c.refresh());
    expect(h.field("Old text")).toBe(old);
    expect(old.value).toBe("draft");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
  });
  it("fences Prepare while another Settings action or pending edit result is unresolved", async () => {
    const h = await mount("general", writableFolder());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    await h.click("Save navigation");
    await h.pageTo("folders");
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({ ok: true, snapshot: h.configuration }),
    );
    const value = writableFolder();
    value.computer.pendingEdit = {
      operationId: editOperationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-04T20:00:00.000Z",
    };
    const blocked = await mount("folders", value);
    await blocked.click("Prepare edit…");
    expect(blocked.calls()).toEqual([]);
  });
});

it("R11 R22 unmount during Prepare releases only observation and never adopts its late result", async () => {
  const h = await mount("folders", writableFolder());
  const subscribe = h.c.subscribe;
  const disposers: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(h.c, "subscribe").mockImplementation((listener) => {
    const dispose = vi.fn(subscribe(listener));
    disposers.push(dispose);
    return dispose;
  });
  const pending = deferred<unknown>();
  vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
  await h.click("Prepare edit…");
  const commandObservation = disposers[0]!;
  await h.remount();
  expect(commandObservation).toHaveBeenCalledOnce();
  expect(h.calls()).toHaveLength(1);
  await act(async () =>
    pending.resolve({
      ok: true,
      snapshot: h.configuration,
      evidence: editPreview(),
    }),
  );
  expect(h.button("Apply edit").disabled).toBe(true);
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.calls()).toHaveLength(1);
});
it("R07 rejects authority drift in a Prepare reply even with equal revision and generation", async () => {
  const h = await mount("folders", writableFolder());
  const next = structuredClone(h.configuration);
  next.settings.computer.workspaces[0]!.root = "/other/project";
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: next,
    evidence: editPreview(),
  });
  await h.click("Prepare edit…");
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.host.textContent).toContain("could not be confirmed");
});
it("checks expiry at dispatch time without needing a background render", async () => {
  const h = await mount("folders", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(editPreview().expiresAt));
  await h.click("Apply edit");
  await h.click("Cancel edit");
  expect(h.calls()).toHaveLength(1);
});
it("reads latest facade authority before Prepare when its rendered control is still enabled", async () => {
  const h = await mount("folders", writableFolder());
  const current = h.c.getSnapshot();
  const configuration = structuredClone(h.configuration);
  configuration.settings.computer.workspaces[0]!.access = "read";
  vi.spyOn(h.c, "getSnapshot").mockReturnValue({ ...current, configuration });
  await h.click("Prepare edit…");
  expect(h.calls()).toHaveLength(0);
});
it("R20 preserves result delivery and requires existing explicit acknowledgement before a new edit", async () => {
  const h = await mount("folders", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  const pending = structuredClone(h.configuration);
  pending.settings.revision++;
  pending.settings.computer.pendingEdit = {
    operationId: editOperationId,
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: 1,
    submittedAt: "2026-10-04T20:00:00.000Z",
  };
  const evidence = {
    kind: "computer.workspace-mutation",
    operationId: editOperationId,
    workspaceId,
    relativePath: "file.txt",
    operation: "edit",
    bytes: 120,
    replacements: 1,
    beforeSha256: "b".repeat(64),
    afterSha256: "c".repeat(64),
    resultRetention: "durable",
    redelivered: false,
  };
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: pending,
    evidence,
  });
  await h.click("Apply edit");
  expect(h.c.getSnapshot().workspaceEditDelivery).toBe(editOperationId);
  await h.remount();
  await h.click("Prepare edit…");
  expect(h.calls()).toHaveLength(2);
  await h.pageTo("diagnostics");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: pending,
    evidence: { ...evidence, redelivered: true },
  });
  await h.click("Observe existing edit");
  expect(h.calls()[2]).toEqual({
    kind: "computer.observe-workspace-edit",
    operationId: editOperationId,
  });
  expect(
    h.calls().some((command) => command.kind === "computer.ack-workspace-edit"),
  ).toBe(false);
  const settled = structuredClone(pending);
  settled.settings.revision++;
  settled.settings.computer.pendingEdit = null;
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: settled,
  });
  await act(async () => h.c.acknowledgeWorkspaceEdit(editOperationId));
  await h.pageTo("folders");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: settled,
    evidence: editPreview(selectionId),
  });
  await h.click("Prepare edit…");
  await change(h.field("Old text"), "next");
  expect(h.button("Apply edit").disabled).toBe(false);
});
it.each([false, true])(
  "settles unknown Apply only after exact Observe+ACK and enables a NEW edit (remount: %s)",
  async (remount) => {
    const h = await mount("folders", writableFolder());
    await prepareEdit(h);
    await change(h.field("Old text"), "old");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("response lost after dispatch"),
    );
    await h.click("Apply edit");
    const pending = structuredClone(h.configuration);
    pending.settings.revision++;
    pending.settings.computer.pendingEdit = {
      operationId: editOperationId,
      workspaceId,
      relativePath: "file.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-04T20:00:00.000Z",
    };
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: pending,
    });
    await act(async () => h.c.refresh());
    await h.pageTo("diagnostics");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: pending,
      evidence: {
        kind: "computer.workspace-mutation",
        operationId: editOperationId,
        workspaceId,
        relativePath: "file.txt",
        operation: "edit",
        bytes: 120,
        replacements: 1,
        beforeSha256: "b".repeat(64),
        afterSha256: "c".repeat(64),
        resultRetention: "durable",
        redelivered: true,
      },
    });
    await h.click("Observe existing edit");
    expect(h.c.getSnapshot().workspaceEditDelivery).toBe(editOperationId);
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.apply-workspace-edit:${editOperationId}`
      ]?.state,
    ).toBe("unknown");
    await h.pageTo("folders");
    expect(h.button("Prepare edit…").disabled).toBe(true);
    await h.click("Prepare edit…");
    expect(h.calls()).toHaveLength(3); // Observation alone does not retire the intent.

    const settled = structuredClone(pending);
    settled.settings.revision++;
    settled.settings.computer.pendingEdit = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
    });
    await act(async () => h.c.acknowledgeWorkspaceEdit(editOperationId));
    if (remount) await h.remount();
    await h.pageTo("folders");
    expect(
      h.c.getSnapshot().intents[
        `settings:computer.apply-workspace-edit:${editOperationId}`
      ]?.state,
    ).toBe("applied");
    expect(h.button("Prepare edit…").disabled).toBe(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
      evidence: editPreview(),
    });
    await h.click("Prepare edit…");
    await change(h.field("Old text"), "old");
    expect(h.button("Apply edit").disabled).toBe(true);
    expect(h.button("Cancel edit").disabled).toBe(true);
    await h.remount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
      evidence: editPreview(selectionId),
    });
    await h.click("Prepare edit…");
    await change(h.field("Old text"), "next");
    expect(h.button("Apply edit").disabled).toBe(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: settled,
    });
    await h.click("Apply edit");
    expect(
      h
        .calls()
        .filter((command) => command.kind === "computer.apply-workspace-edit")
        .map((command) => command.operationId),
    ).toEqual([editOperationId, selectionId]);
  },
);

it("retains consumed operation identity after a known refusal and remount", async () => {
  const h = await mount("folders", writableFolder());
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  vi.mocked(h.f.api.configure).mockResolvedValueOnce({
    ok: false,
    error: "WORKSPACE_MUTATION_IN_PROGRESS",
    snapshot: h.configuration,
  });
  await h.click("Apply edit");
  await h.remount();
  await prepareEdit(h);
  await change(h.field("Old text"), "old");
  expect(h.button("Apply edit").disabled).toBe(true);
  expect(h.button("Cancel edit").disabled).toBe(true);
  expect(h.calls()).toHaveLength(3);
});

describe("Computer-first setup and explicit reconnect", () => {
  it("shows the exact verified workspace and challenge without embedded login or automatic commands", async () => {
    const value = connectionSettings();
    value.setup.chatgpt.verified = null;
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const other = structuredClone(value.computer.workspaces[0]!);
    other.workspaceId = selectionId;
    other.root = "/other/folder";
    other.rootIdentity = { device: "1", inode: "3" };
    other.excludedPaths = [];
    other.accessCheck = {
      buildId: "3".repeat(64),
      computerGeneration: value.computer.generation,
      rootIdentity: other.rootIdentity,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    value.computer.workspaces.unshift(other);
    ProductSettingsSchema.parse(value);
    const h = await mount("connection", value);
    expect(h.c.getSnapshot().configuration?.status).toBe("ready");
    expect(h.host.textContent).toContain("Verify from external ChatGPT");
    const card = h.host.querySelector("[data-connector-challenge]");
    expect(card?.querySelectorAll("code")[0]?.textContent).toBe(selectionId);
    expect(card?.querySelectorAll("code")[1]?.textContent).toBe(workspaceId);
    expect(card?.textContent).toContain("/approved/project");
    expect(card?.textContent).not.toContain("/other/folder");
    for (const page of ["folders", "computer", "connection"] as const)
      await h.pageTo(page);
    expect(h.calls()).toEqual([]);
    expect(h.button("Check in ChatGPT once").disabled).toBe(true);
    expect(h.button("Check attachment").disabled).toBe(false);
  });
  it.each(["build", "runtime", "computer", "connector", "workspace", "stale"])(
    "hides a challenge with mismatched current provenance: %s",
    async (mismatch) => {
      const value = connectionSettings();
      value.connectors.secureMcp.attachment = null;
      value.setup.connect.verified = null;
      if (mismatch === "build")
        value.connectors.secureMcp.challenge!.buildId = "e".repeat(64);
      if (mismatch === "runtime")
        value.connectors.secureMcp.challenge!.runtimeGeneration = "e".repeat(
          64,
        );
      if (mismatch === "computer")
        value.connectors.secureMcp.challenge!.computerGeneration++;
      if (mismatch === "connector") value.connectors.secureMcp.generation++;
      if (mismatch === "workspace")
        value.setup.computer.verified!.workspaceId = selectionId;
      const h = await mount("connection", value);
      if (mismatch === "stale")
        await act(async () =>
          h.f.emit("runtime", {
            state: "offline",
            error: null,
            identity: null,
            embeddedNode: null,
            embeddedElectron: null,
          }),
        );
      expect(h.host.querySelector("[data-connector-challenge]")).toBeNull();
      expect(h.calls()).toEqual([]);
    },
  );
  it("double-click submits one Repair, never a renderer Stop/Start chain", async () => {
    const h = await mount("connection", connectionSettings());
    const pending = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(pending.promise);
    const reconnect = h.button("Reconnect");
    expect(h.button("Start connection").disabled).toBe(true);
    await act(async () => {
      reconnect.click();
      reconnect.click();
    });
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
    expect(h.button("Reconnect").disabled).toBe(true);
    await h.pageTo("folders");
    await h.pageTo("connection");
    await h.click("Reconnect");
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      pending.resolve({
        ok: false,
        error: "CONNECTOR_STOP_UNCONFIRMED",
        snapshot: h.configuration,
      }),
    );
    expect(h.host.textContent).toContain("CONNECTOR_STOP_UNCONFIRMED");
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
  });
  it.each([
    "pending",
    "unknown",
    "stale",
    "runtime-unknown",
    "runtime-stale",
    "unavailable",
  ])(
    "rechecks latest facade admission before reconnect, despite an enabled old control: %s",
    async (fence) => {
      const h = await mount("connection", connectionSettings());
      const next = { ...structuredClone(h.c.getSnapshot()) };
      if (fence === "pending" || fence === "unknown")
        next.intents = {
          ...next.intents,
          foreign: { id: "foreign", state: fence, code: null },
        };
      if (fence === "stale") next.status = "stale";
      if (fence === "unavailable") next.configuration = null;
      if (next.configuration?.status === "ready") {
        if (fence === "runtime-unknown")
          next.configuration.settings.connectors.secureMcp.runtime!.state =
            "outcome_unknown";
        if (fence === "runtime-stale")
          next.configuration.settings.connectors.secureMcp.runtime!
            .connectorGeneration++;
      }
      vi.spyOn(h.c, "getSnapshot").mockReturnValue(next);
      await h.click("Reconnect");
      expect(h.calls()).toEqual([]);
    },
  );
  it("lost Repair reply stays unknown through page changes and does not repeat", async () => {
    const h = await mount("connection", connectionSettings());
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("reply lost"));
    await h.click("Reconnect");
    await h.pageTo("folders");
    await h.pageTo("connection");
    await h.click("Reconnect");
    expect(h.calls()).toEqual([{ kind: "connector.repair" }]);
    expect(h.host.textContent).toContain("Outcome unknown");
    expect(h.button("Start connection").disabled).toBe(true);
  });
  it("explicit narrowing invalidates readiness and preserves drafts without auto reconnect", async () => {
    const value = connectionSettings();
    value.computer.workspaces[0]!.access = "write";
    const h = await mount("connection", value);
    await change(h.field("Tunnel ID"), "unsaved-tunnel");
    const tunnel = h.field("Tunnel ID");
    const narrowed = structuredClone(h.configuration);
    narrowed.settings.revision++;
    narrowed.settings.computer.generation++;
    narrowed.settings.computer.workspaces[0]!.access = "read";
    narrowed.settings.setup.computer.verified = null;
    narrowed.settings.connectors.secureMcp.attachment = null;
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: narrowed,
    });
    await h.pageTo("folders");
    await h.click("Use read-only");
    await h.pageTo("connection");
    expect(h.field("Tunnel ID")).toBe(tunnel);
    expect(tunnel.value).toBe("unsaved-tunnel");
    expect(
      h.host.querySelector('section[aria-label="This Mac connection"] .badges')
        ?.textContent,
    ).toBe("Setup needed");
    expect(h.button("Start connection").disabled).toBe(true);
    expect(h.button("Reconnect").disabled).toBe(true);
    expect(h.calls()).toEqual([
      { kind: "computer.update-access", workspaceId, access: "read" },
    ]);
  });
});

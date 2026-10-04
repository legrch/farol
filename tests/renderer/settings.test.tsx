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
    return <Settings snapshot={snapshot} facade={c} />;
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
      h.host.querySelector('section[aria-label="ChatGPT"] .badges')
        ?.textContent,
    ).not.toBe("Ready");
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
    const h = await mount("connection", value, "dev");
    const badge = () =>
      h.host.querySelector('section[aria-label="ChatGPT"] .badges')
        ?.textContent;
    expect(badge()).toBe("Ready");
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

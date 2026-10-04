import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatReadonly } from "../../src/ui/renderer/chat-readonly";
import { WindowController } from "../../src/ui/renderer/controller";
import type { ProductConfigurationEvidence } from "../../src/pkg/product-settings/contract";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { bootstrap, deferred, fixture, settings } from "./fixture";

// Component/controller fixtures only. No native picker, file read, provider,
// installed application, or visible browser verification is performed here.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const controllers: WindowController[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const workspaceId = "22222222-2222-4222-8222-222222222222";
const operationId = "44444444-4444-4444-8444-444444444444";
const otherWorkspaceId = "55555555-5555-4555-8555-555555555555";
const otherOperationId = "66666666-6666-4666-8666-666666666666";
function configured(revision = 1) {
  const value = settings(revision);
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  const proof = {
    profile: "farol-next",
    configRevision: value.computer.generation,
    workspaceId,
    runtimeGeneration: "a".repeat(64),
    buildId: "3".repeat(64),
    protocol: "secure-mcp" as const,
    verifiedAt: "2026-10-02T20:00:00.000Z",
  };
  value.setup.computer.verified = proof;
  value.setup.computer.reachable = "reachable";
  value.setup.chatgpt.verified = { ...proof, workspaceId: null };
  return {
    status: "ready" as const,
    settings: ProductSettingsSchema.parse(value),
  };
}
function preview(
  overrides: Partial<
    Extract<
      ProductConfigurationEvidence,
      { kind: "chatgpt.readonly-task-preview" }
    >
  > = {},
) {
  return {
    kind: "chatgpt.readonly-task-preview" as const,
    operationId,
    workspaceId,
    workspaceLabel: "Project",
    relativePath: "docs/readme.txt",
    bytes: 321,
    contextCharacters: 24000,
    contextLimit: 24000 as const,
    contextTruncated: true,
    excludedPaths: ["private"],
    expiresAt: "2026-10-04T23:59:00.000Z",
    ...overrides,
  };
}
async function mount(configuration = configured()) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration,
  });
  vi.mocked(f.api.configure).mockImplementation(async (command) => ({
    ok: true,
    snapshot: configuration,
    ...(command.kind === "chatgpt.prepare-readonly-task"
      ? { evidence: preview() }
      : {}),
  }));
  const c = new WindowController(f.api);
  await c.start();
  controllers.push(c);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return <ChatReadonly snapshot={snapshot} facade={c} />;
  }
  const render = async (key = "initial") => {
    await act(async () =>
      root.render(
        <StrictMode>
          <View key={key} />
        </StrictMode>,
      ),
    );
  };
  await render();
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!found) throw new Error(`Button not found: ${text}`);
    return found;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const select = async (id = workspaceId) => {
    await act(async () => {
      const field = host.querySelector("select")!;
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set?.call(field, id);
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const calls = () =>
    vi.mocked(f.api.configure).mock.calls.map(([command]) => command);
  return {
    f,
    c,
    host,
    root,
    render,
    button,
    click,
    select,
    calls,
    configuration,
  };
}
describe("ChatReadonly bounded component", () => {
  it("does not dispatch on StrictMode mount, rerender or remount; requires explicit folder selection", async () => {
    const h = await mount();
    expect(h.button("Choose file…").disabled).toBe(true);
    await h.render();
    await h.render("remounted");
    expect(h.calls()).toEqual([]);
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.f.api.snapshot).not.toHaveBeenCalled();
    expect(h.host.textContent).not.toMatch(/Send|sign.in|Open ChatGPT/iu);
    await h.select();
    expect(h.button("Choose file…").disabled).toBe(false);
    expect(h.calls()).toEqual([]);
  });
  it("prepares one selected file, shows safe metadata, and discards exactly that operation", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    expect(h.calls()).toEqual([
      { kind: "chatgpt.prepare-readonly-task", workspaceId },
    ]);
    expect(h.host.textContent).toContain("Project / docs/readme.txt");
    expect(h.host.textContent).toContain("321 bytes");
    expect(h.host.textContent).toContain("24000 of 24000 context characters");
    expect(h.host.textContent).toContain("Context is truncated");
    expect(h.host.textContent).toContain(operationId);
    expect(h.host.textContent).toContain("Configuration revision: 1");
    expect(h.host.textContent).toContain("Excluded: private");
    expect(h.host.querySelector("time")?.dateTime).toBe(preview().expiresAt);
    expect(h.button("Choose file…").disabled).toBe(true);
    await h.click("Discard preview");
    expect(h.calls()[1]).toEqual({
      kind: "chatgpt.cancel-readonly-task",
      operationId,
    });
    expect(h.host.textContent).toContain("The exact preview was discarded.");
    expect(h.host.textContent).not.toContain(operationId);
    expect(h.button("Choose file…").disabled).toBe(false);
    const first = Object.keys(h.c.getSnapshot().intents).find((id) =>
      id.startsWith("chat-readonly:prepare:"),
    );
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({ operationId: otherOperationId }),
    });
    await h.click("Choose file…");
    const next = Object.keys(h.c.getSnapshot().intents).filter((id) =>
      id.startsWith("chat-readonly:prepare:"),
    );
    expect(next).toHaveLength(2);
    expect(next[1]).not.toBe(first);
    expect(h.button("Discard preview").disabled).toBe(false);
    expect(h.f.api.task).not.toHaveBeenCalled();
  });
  it("latches double clicks before React disables Prepare and Discard", async () => {
    const h = await mount();
    const prepare = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(prepare.promise);
    await h.select();
    await act(async () => {
      const button = h.button("Choose file…");
      button.click();
      button.click();
    });
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      prepare.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: preview(),
      }),
    );
    const discard = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(discard.promise);
    await act(async () => {
      const button = h.button("Discard preview");
      button.click();
      button.click();
    });
    expect(h.calls()).toHaveLength(2);
    await act(async () =>
      discard.resolve({ ok: true, snapshot: h.configuration }),
    );
  });
  it("retires exactly a confirmed Discard even when a newer refresh retains its old evidence", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const retainedEvidence = h.c.getSnapshot().evidence;
    const discard = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(discard.promise);
    await h.click("Discard preview");
    // Begin a newer request without accepting its snapshot. The real controller
    // ignores the older Discard snapshot but still confirms its exact command.
    const refreshReply = deferred<unknown>();
    vi.mocked(h.f.api.bootstrap).mockReturnValueOnce(refreshReply.promise);
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = h.c.refresh();
    });
    await act(async () =>
      discard.resolve({ ok: true, snapshot: h.configuration }),
    );
    expect(h.c.getSnapshot().evidence).toBe(retainedEvidence);
    expect(h.button("Choose file…").disabled).toBe(false);
    expect(h.host.textContent).not.toContain(operationId);
    expect(h.host.querySelectorAll("button")).toHaveLength(1);
    await h.render("confirmed-discard-remount");
    expect(h.calls()).toHaveLength(2);
    await h.select();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({
        operationId: otherOperationId,
        relativePath: "docs/second.txt",
      }),
    });
    await h.click("Choose file…");
    expect(h.calls()).toEqual([
      { kind: "chatgpt.prepare-readonly-task", workspaceId },
      { kind: "chatgpt.cancel-readonly-task", operationId },
      { kind: "chatgpt.prepare-readonly-task", workspaceId },
    ]);
    expect(h.host.textContent).toContain("docs/second.txt");
    expect(h.button("Discard preview").disabled).toBe(false);
    await act(async () => {
      refreshReply.resolve({ ...bootstrap(), configuration: h.configuration });
      await refresh;
    });
    expect(h.host.textContent).toContain(otherOperationId);
    expect(h.calls()).toHaveLength(3);
  });
  it("does not project a different retained operation away after a confirmed Discard", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const discard = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(discard.promise);
    await h.click("Discard preview");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({ operationId: otherOperationId }),
    });
    await act(async () =>
      h.c.configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        "foreign-prepare",
      ),
    );
    await act(async () =>
      discard.resolve({ ok: true, snapshot: h.configuration }),
    );
    expect(h.c.getSnapshot().evidence?.value).toMatchObject({
      operationId: otherOperationId,
    });
    expect(h.host.textContent).toContain(otherOperationId);
    expect(h.host.textContent).not.toContain(operationId);
    expect(h.button("Choose file…").disabled).toBe(true);
    expect(h.button("Discard preview").disabled).toBe(true);
    await h.click("Choose file…");
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(3);
  });
  it("keeps operation and revision in optional Details and explains the preview in user terms", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const details = h.host.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(operationId);
    expect(details.textContent).toContain("Configuration revision: 1");
    const defaultView = h.host.cloneNode(true) as HTMLElement;
    defaultView.querySelectorAll("details").forEach((node) => node.remove());
    expect(defaultView.textContent).toContain("Nothing is sent to ChatGPT");
    expect(defaultView.textContent).not.toMatch(
      /existing preview owner|revision|operation|request correlation|interface/iu,
    );
    await act(async () => details.querySelector("summary")!.click());
    expect(h.calls()).toHaveLength(1);
  });
  it.each([
    "write",
    "unchecked",
    "wrong-build",
    "wrong-generation",
    "wrong-identity",
    "unverified-chatgpt",
  ])("offers no folder when verification is %s", async (condition) => {
    const configuration = configured();
    const workspace = configuration.settings.computer.workspaces[0]!;
    if (condition === "write") workspace.access = "write";
    if (condition === "unchecked")
      configuration.settings.setup.computer.verified = null;
    if (condition === "wrong-build")
      configuration.settings.setup.computer.verified!.buildId = "9".repeat(64);
    if (condition === "wrong-generation")
      configuration.settings.computer.generation++;
    if (condition === "wrong-identity")
      workspace.accessCheck = {
        buildId: "3".repeat(64),
        computerGeneration: 1,
        rootIdentity: { device: "9", inode: "9" },
        verifiedAt: "2026-10-02T20:00:00.000Z",
      };
    if (condition === "unverified-chatgpt")
      configuration.settings.setup.chatgpt.verified = null;
    const h = await mount(configuration);
    expect(h.host.querySelectorAll("option")).toHaveLength(1);
    await h.click("Choose file…");
    expect(h.calls()).toEqual([]);
  });
  it("rechecks live state if a click races a stale render", async () => {
    const h = await mount();
    await h.select();
    await act(async () => {
      h.f.emit("runtime", {
        state: "offline",
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      });
      h.button("Choose file…").click();
    });
    expect(h.calls()).toEqual([]);
    expect(h.button("Choose file…").disabled).toBe(true);
  });
  it("never cancels or acknowledges during remount, including while Prepare is in flight", async () => {
    const h = await mount();
    const reply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(reply.promise);
    await h.select();
    await h.click("Choose file…");
    await h.render("while-pending");
    await act(async () =>
      reply.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: preview(),
      }),
    );
    expect(h.host.textContent).toContain(operationId);
    expect(h.button("Discard preview").disabled).toBe(false);
    await h.render("again");
    expect(h.calls()).toHaveLength(1);
    expect(h.f.api.task).not.toHaveBeenCalled();
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(2);
  });
  it("retains exact window correlation through remount and a same-revision refresh", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const retained = h.c.getSnapshot().readPreview;
    await h.render("remounted");
    expect(h.button("Discard preview").disabled).toBe(false);
    await act(async () => h.c.refresh());
    expect(h.c.getSnapshot().evidence).toBeNull();
    expect(h.c.getSnapshot().readPreview).toBe(retained);
    expect(h.button("Choose file…").disabled).toBe(true);
    expect(h.button("Discard preview").disabled).toBe(false);
    expect(h.calls()).toHaveLength(1);
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(2);
    expect(h.c.getSnapshot().readPreview).toBeNull();
  });
  it("withdraws Discard after a configuration revision changes, without losing metadata", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    vi.mocked(h.f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      configuration: configured(2),
    });
    await act(async () => h.c.refresh());
    expect(h.host.textContent).toContain(operationId);
    expect(h.host.textContent).toContain("Configuration revision: 1");
    expect(h.button("Discard preview").disabled).toBe(true);
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(1);
  });
  it("does not bind preview evidence returned at a different revision", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: configured(2),
      evidence: preview(),
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(h.host.textContent).toContain("current state is unavailable");
  });
  it("does not bind evidence for another workspace", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({ workspaceId: otherWorkspaceId }),
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(h.host.textContent).toContain("current state is unavailable");
  });
  it("rejects a late preview when a newer same-revision configure crossed it", async () => {
    const h = await mount();
    const reply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(reply.promise);
    await h.select();
    await h.click("Choose file…");
    await act(async () =>
      h.c.configure(
        { kind: "computer.rename", name: "New name" },
        "other-action",
      ),
    );
    await act(async () =>
      reply.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: preview(),
      }),
    );
    expect(h.c.getSnapshot().evidence).toBeNull();
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(h.host.textContent).toContain("current state is unavailable");
    expect(h.calls()).toHaveLength(2);
  });
  it("rejects foreign same-revision evidence arriving after our preview but before its continuation", async () => {
    const h = await mount();
    const configure = h.c.configure.bind(h.c);
    vi.spyOn(h.c, "configure").mockImplementationOnce(async (command, id) => {
      const result = await configure(command, id);
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: preview({ operationId: otherOperationId }),
      });
      await configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        "foreign-prepare",
      );
      return result;
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.host.textContent).toContain(operationId);
    expect(h.c.getSnapshot().intents["foreign-prepare"]?.state).toBe("unknown");
    expect(h.c.getSnapshot().readPreview?.value.operationId).toBe(operationId);
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(
      h
        .calls()
        .every((command) => command.kind !== "chatgpt.cancel-readonly-task"),
    ).toBe(true);
  });
  it("does not cancel replacement evidence if its rendered Discard button is clicked before rerender", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({ operationId: otherOperationId }),
    });
    await act(async () => {
      await h.c.configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        "foreign-prepare",
      );
      h.button("Discard preview").click();
    });
    expect(h.calls()).toHaveLength(2);
    expect(h.button("Discard preview").disabled).toBe(true);
  });
  it.each(["prepare", "discard"])(
    "keeps unknown %s nonretryable through remount and refresh",
    async (action) => {
      const h = await mount();
      await h.select();
      if (action === "discard") await h.click("Choose file…");
      vi.mocked(h.f.api.configure).mockRejectedValueOnce(
        new Error("lost reply"),
      );
      await h.click(action === "prepare" ? "Choose file…" : "Discard preview");
      expect(h.host.textContent).toContain("The result is unknown");
      if (action === "discard") {
        expect(h.host.textContent).toContain(operationId);
        expect(h.c.getSnapshot().evidence?.value).toMatchObject({
          operationId,
        });
        expect(h.button("Discard preview").disabled).toBe(true);
      }
      const count = h.calls().length;
      await h.render("unknown-remount");
      expect(h.host.textContent).toContain("The result is unknown");
      await act(async () => h.c.refresh());
      await h.click("Choose file…");
      await h.click("Discard preview");
      expect(h.calls()).toHaveLength(count);
      expect(
        Object.values(h.c.getSnapshot().intents).some(
          (intent) => intent.state === "unknown",
        ),
      ).toBe(true);
    },
  );
  it("allows a fresh explicit picker after a confirmed picker cancellation", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "WORKSPACE_FILE_PICKER_CANCELLED",
      snapshot: h.configuration,
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.button("Choose file…").disabled).toBe(false);
    expect(h.host.textContent).toContain("Prepare was refused");
    await h.click("Choose file…");
    expect(h.calls()).toHaveLength(2);
    expect(h.button("Discard preview").disabled).toBe(false);
  });
  it("fences a well-formed requires-review refusal through remount", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CHATGPT_TASK_REQUIRES_REVIEW",
      snapshot: h.configuration,
    });
    await h.select();
    await h.click("Choose file…");
    await h.render("requires-review");
    expect(h.button("Choose file…").disabled).toBe(true);
    expect(h.host.textContent).toContain("current state is unavailable");
  });
  it("does not retry a refused Discard or interpret expiry as confirmed retirement", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({
        expiresAt: "2020-01-01T00:00:00.000Z",
        contextTruncated: false,
      }),
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.host.textContent).not.toContain("Context is truncated");
    expect(h.host.textContent).toContain(
      "An expired preview may still need to be discarded",
    );
    expect(h.button("Discard preview").disabled).toBe(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CHATGPT_TASK_PREVIEW_NOT_FOUND",
      snapshot: h.configuration,
    });
    await h.click("Discard preview");
    expect(h.host.textContent).toContain(operationId);
    expect(h.host.textContent).toContain("Discard was refused");
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(2);
  });
  it("cannot prepare while another facade action is pending or unknown", async () => {
    const h = await mount();
    await h.select();
    const reply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(reply.promise);
    let action!: ReturnType<WindowController["configure"]>;
    await act(async () => {
      action = h.c.configure(
        { kind: "computer.rename", name: "New name" },
        "other-action",
      );
      h.button("Choose file…").click();
    });
    expect(h.calls()).toHaveLength(1);
    expect(h.button("Choose file…").disabled).toBe(true);
    await act(async () => {
      reply.reject(new Error("lost reply"));
      await action;
    });
    await h.click("Choose file…");
    expect(h.calls()).toHaveLength(1);
    expect(h.button("Choose file…").disabled).toBe(true);
  });
  it("keeps an applied Prepare without evidence blocked, including after remount", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.host.textContent).toContain("current state is unavailable");
    expect(h.button("Discard preview").disabled).toBe(true);
    await h.render("no-evidence");
    await h.click("Choose file…");
    expect(h.calls()).toHaveLength(1);
  });
  it("remounts during Discard without repeating it and observes its confirmed completion", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const reply = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(reply.promise);
    await h.click("Discard preview");
    await h.render("discard-pending");
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(2);
    await act(async () =>
      reply.resolve({ ok: true, snapshot: h.configuration }),
    );
    expect(h.host.textContent).not.toContain(operationId);
    await h.select();
    expect(h.button("Choose file…").disabled).toBe(false);
    expect(h.calls()).toHaveLength(2);
  });
  it("checks Discard against live stale state even before React rerenders", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    await act(async () => {
      h.f.emit("tasks", { malformed: true });
      h.button("Discard preview").click();
    });
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
    expect(h.host.textContent).toContain(operationId);
  });
  it("uses explicit inspect then confirmation, retains account state across remount, and never sends", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const original = h.c.getSnapshot().readPreview!;
    const confirmationId = "77777777-7777-4777-8777-777777777777";
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({ account: { confirmationId, state: "observed" } }),
    });
    await h.click("Inspect current account");
    expect(h.calls()[1]).toEqual({
      kind: "chatgpt.inspect-readonly-account",
      operationId,
    });
    expect(h.c.getSnapshot().readPreview?.prepareIntention).toBe(
      original.prepareIntention,
    );
    await h.render("observed-remount");
    expect(h.button("Use this account").disabled).toBe(false);
    expect(h.calls()).toHaveLength(2);
    const approval = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(approval.promise);
    await act(async () => {
      h.button("Use this account").click();
      h.button("Use this account").click();
    });
    expect(h.calls()[2]).toEqual({
      kind: "chatgpt.approve-readonly-account",
      operationId,
      confirmationId,
    });
    await h.render("confirmation-pending");
    expect(h.button("Use this account").disabled).toBe(true);
    await act(async () =>
      approval.resolve({
        ok: true,
        snapshot: h.configuration,
        evidence: preview({ account: { confirmationId, state: "approved" } }),
      }),
    );
    await h.render("approved-remount");
    expect(h.host.textContent).toContain(
      "Account confirmed for this preview. Nothing has been sent.",
    );
    expect(h.c.getSnapshot().readPreview?.value.account?.state).toBe(
      "approved",
    );
    expect(h.calls()).toHaveLength(3);
    expect(h.f.api.task).not.toHaveBeenCalled();
    await h.click("Discard preview");
    expect(h.calls()[3]).toEqual({
      kind: "chatgpt.cancel-readonly-task",
      operationId,
    });
    expect(h.c.getSnapshot().readPreview).toBeNull();
  });
  it.each([
    "unknown",
    "wrong-operation",
    "wrong-confirmation",
    "wrong-metadata",
    "not-approved",
  ])(
    "keeps %s account confirmation unconfirmed across remount without another effect",
    async (variant) => {
      const h = await mount();
      await h.select();
      await h.click("Choose file…");
      const confirmationId = "77777777-7777-4777-8777-777777777777";
      vi.mocked(h.f.api.configure).mockResolvedValueOnce({
        ok: true,
        snapshot: h.configuration,
        evidence: preview({ account: { confirmationId, state: "observed" } }),
      });
      await h.click("Inspect current account");
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        variant === "unknown"
          ? {
              ok: false,
              snapshot: h.configuration,
              error: "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
            }
          : {
              ok: true,
              snapshot: h.configuration,
              evidence: preview({
                operationId:
                  variant === "wrong-operation"
                    ? otherOperationId
                    : operationId,
                relativePath:
                  variant === "wrong-metadata"
                    ? "different.txt"
                    : "docs/readme.txt",
                account: {
                  confirmationId:
                    variant === "wrong-confirmation"
                      ? otherOperationId
                      : confirmationId,
                  state: variant === "not-approved" ? "observed" : "approved",
                },
              }),
            },
      );
      await h.click("Use this account");
      expect(h.c.getSnapshot().readPreview?.value.account?.state).toBe(
        "observed",
      );
      await h.render("unknown-approval");
      expect(h.host.textContent).toContain("result is unknown");
      expect(h.button("Use this account").disabled).toBe(true);
      expect(h.button("Discard preview").disabled).toBe(true);
      await h.click("Use this account");
      expect(h.calls()).toHaveLength(3);
    },
  );
  it("keeps a known refused account inspection one-shot but permits exact Discard", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      snapshot: h.configuration,
      error: "CHATGPT_ACCOUNT_UNAVAILABLE",
    });
    await h.click("Inspect current account");
    await h.render("inspection-refused");
    expect(h.button("Inspect current account").disabled).toBe(true);
    expect(h.button("Discard preview").disabled).toBe(false);
    await h.click("Inspect current account");
    expect(h.calls()).toHaveLength(2);
    await h.click("Discard preview");
    expect(h.calls()).toHaveLength(3);
  });
  it("never upgrades inspection to approval without explicit confirmation", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({
        account: { confirmationId: otherOperationId, state: "approved" },
      }),
    });
    await h.click("Inspect current account");
    expect(Object.values(h.c.getSnapshot().intents)).toContainEqual(
      expect.objectContaining({
        state: "unknown",
        code: "READ_ACCOUNT_UNCONFIRMED",
      }),
    );
    expect(h.c.getSnapshot().readPreview?.value.account).toBeUndefined();
    expect(h.host.textContent).not.toContain("Account confirmed");
    await h.render("unexpected-approved-inspection");
    expect(h.host.textContent).not.toContain("Account confirmed");
    expect(h.calls()).toHaveLength(2);
  });
  it("does not show approval from rejected wrong-workspace metadata", async () => {
    const h = await mount();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.configuration,
      evidence: preview({
        workspaceId: otherWorkspaceId,
        account: { confirmationId: otherOperationId, state: "approved" },
      }),
    });
    await h.select();
    await h.click("Choose file…");
    expect(h.c.getSnapshot().readPreview).toBeNull();
    expect(h.host.textContent).not.toContain("Account confirmed");
    await h.render("uncorrelated-approved");
    expect(h.host.textContent).not.toContain("Account confirmed");
    expect(h.host.textContent).toContain("result is unknown");
  });
  it("does not display approval until its evidence intention is settled applied", async () => {
    const h = await mount();
    await h.select();
    await h.click("Choose file…");
    const retained = h.c.getSnapshot().readPreview!;
    const intention = "pending-approval";
    const snapshot = {
      ...h.c.getSnapshot(),
      intents: {
        ...h.c.getSnapshot().intents,
        [intention]: { id: intention, state: "pending" as const, code: null },
      },
      readPreview: {
        ...retained,
        evidenceIntention: intention,
        value: preview({
          account: { confirmationId: otherOperationId, state: "approved" },
        }),
      },
    };
    await act(async () =>
      h.root.render(<ChatReadonly snapshot={snapshot} facade={h.c} />),
    );
    expect(h.host.textContent).not.toContain("Account confirmed");
    expect(h.button("Discard preview").disabled).toBe(true);
    expect(h.calls()).toHaveLength(1);
  });
});

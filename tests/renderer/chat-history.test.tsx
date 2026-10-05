import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistory } from "../../src/ui/renderer/chat-history";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, fixture, deferred } from "./fixture";
// Component/controller only; no native window, app restart or provider evidence.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [],
  controllers: WindowController[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
  for (const c of controllers.splice(0)) c.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const context = { profileId: "profile", backendGeneration: "current" };
const entry = {
  key: { backendGeneration: "original", operationId: "operation" },
  turnId: "turn",
  turnGeneration: "1",
  resultId: "result",
  conversationId: "conversation",
};
const page = {
  context,
  value: { kind: "page", offset: 0, total: 1, entries: [entry] },
};
async function mount() {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    chatHistoryContext: context,
  });
  const read = vi.fn(async (): Promise<unknown> => page);
  const c = new WindowController({ ...f.api, chatHistory: read });
  controllers.push(c);
  await c.start();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return <ChatHistory snapshot={snapshot} facade={c} />;
  }
  const render = async (key = "initial") =>
    act(async () =>
      root.render(
        <StrictMode>
          <View key={key} />
        </StrictMode>,
      ),
    );
  await render();
  const button = (text: string) => {
    const b = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    if (!b) throw new Error(`missing ${text}`);
    return b;
  };
  return { f, c, read, host, render, button };
}
describe("Saved Chat answers", () => {
  it("reads only on click, coalesces pending clicks and renders retained text without actions", async () => {
    const f = await mount();
    expect(f.read).not.toHaveBeenCalled();
    const pending = deferred<unknown>();
    f.read.mockReturnValueOnce(pending.promise);
    await act(async () => {
      f.button("Load saved answers").click();
      f.button("Load saved answers").click();
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(page));
    const text = "Stored answer ☀\n<script>Send again</script>";
    f.read.mockResolvedValueOnce({
      context,
      value: { kind: "result", entry, text },
    });
    await act(async () => f.button("Read turn 1").click());
    expect(
      f.host.querySelector('[aria-label="Saved answer"]')?.textContent,
    ).toContain(text);
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("textarea")).toBeNull();
    expect(
      [...f.host.querySelectorAll("button")].some((b) =>
        /^(Send|Follow|Acknowledge)/u.test(b.textContent ?? ""),
      ),
    ).toBe(false);
    expect(f.f.api.configure).not.toHaveBeenCalled();
    expect(f.f.api.task).not.toHaveBeenCalled();
    expect(f.c.getSnapshot().activity).toEqual([]);
    await f.render("remount");
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[aria-label="Saved answer"]')).toBeNull();
  });
  it("hides content on verified bootstrap withdrawal and does not revive it on a new backend", async () => {
    const f = await mount();
    await act(async () => f.button("Load saved answers").click());
    f.read.mockResolvedValueOnce({
      context,
      value: { kind: "result", entry, text: "retained" },
    });
    await act(async () => f.button("Read turn 1").click());
    vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      chatHistoryContext: null,
    });
    await act(async () => f.c.refresh());
    expect(f.host.querySelector('[aria-label="Saved answer"]')).toBeNull();
    expect(f.button("Load saved answers").disabled).toBe(true);
    vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      chatHistoryContext: { ...context, backendGeneration: "next" },
    });
    await act(async () => f.c.refresh());
    expect(f.host.querySelector('[aria-label="Saved answer"]')).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it.each(["revive", "runtime-gap"])(
    "does not revive cached text after %s",
    async (fault) => {
      const f = await mount();
      await act(async () => f.button("Load saved answers").click());
      f.read.mockResolvedValueOnce({
        context,
        value: { kind: "result", entry, text: "old answer" },
      });
      await act(async () => f.button("Read turn 1").click());
      await act(async () => {
        if (fault === "revive") {
          vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
            ...bootstrap(),
            chatHistoryContext: null,
          });
          await f.c.refresh();
        } else
          f.f.emit("runtime", {
            state: "offline",
            error: null,
            identity: null,
            embeddedNode: null,
            embeddedElectron: null,
          });
        await f.c.refresh();
      });
      expect(f.c.getSnapshot().status).toBe("current");
      expect(f.host.querySelector('[aria-label="Saved answer"]')).toBeNull();
      expect(f.read).toHaveBeenCalledTimes(2);
    },
  );
  it("reports an empty catalogue and malformed-read failure without sending", async () => {
    const f = await mount();
    f.read.mockResolvedValueOnce({
      context,
      value: { kind: "page", offset: 0, total: 0, entries: [] },
    });
    await act(async () => f.button("Load saved answers").click());
    expect(f.host.textContent).toContain(
      "No saved answers from an earlier app session.",
    );
    f.read.mockResolvedValueOnce({
      context,
      value: { ...page.value, total: 2 },
    });
    await act(async () => f.button("Load saved answers").click());
    expect(f.host.textContent).toContain("Saved answers are unavailable.");
    expect(f.f.api.configure).not.toHaveBeenCalled();
  });
});

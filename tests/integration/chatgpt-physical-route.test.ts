import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));
import { ChatGptRoute } from "../../src/apps/desktop/chatgpt-route";
import type { PhysicalBinding } from "../../apps/desktop/chatgpt-physical-api";

function fixture(qualified = true, fixtureOrigin: string | null = null) {
  const homeUrl = fixtureOrigin
    ? `${fixtureOrigin}/chatgpt`
    : "https://chatgpt.com/";
  const route = new ChatGptRoute({
    homeUrl,
    initialUrl: homeUrl,
    e2eOrigin: fixtureOrigin,
    parent: () => null,
    partition: "persist:farol-dev-chatgpt",
    windowPresentation: { mode: "hidden" },
    ...(qualified
      ? { publicOutputProfile: "message-anchors-v1" as const }
      : {}),
  });
  let url = homeUrl;
  let nativeDestroyed = false;
  const nativeSession = {};
  const contents = Object.assign(new EventEmitter(), {
    id: 73,
    session: nativeSession,
    getURL: () => url,
    isDestroyed: () => nativeDestroyed,
    executeJavaScript: vi.fn(async (_script: string, _gesture: boolean) => ({
      readiness: "ready",
    })),
    setWindowOpenHandler: vi.fn(),
  });
  const surface = {
    webContents: contents,
    isDestroyed: () => false,
    destroy: vi.fn(() => {
      nativeDestroyed = true;
      contents.emit("destroyed");
    }),
    hide: vi.fn(),
    reveal: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(async (target: string) => {
      url = target;
    }),
  };
  Reflect.set(route, "routeWindow", surface);
  Reflect.set(route, "routeSession", nativeSession);
  Reflect.set(route, "load", "loaded");
  const snapshot = (): PhysicalBinding => {
    const method = Reflect.get(route, "chatPhysicalSnapshot") as () => {
      binding: PhysicalBinding;
    };
    return method.call(route).binding;
  };
  const harden = () =>
    (
      Reflect.get(route, "hardenContents") as (
        c: typeof contents,
        ready: boolean,
      ) => void
    ).call(route, contents, true);
  return {
    route,
    surface,
    contents,
    homeUrl,
    snapshot,
    harden,
    navigate: (next: string) => {
      url = next;
    },
  };
}

describe("ChatGptRoute physical mechanics wiring (mock native port)", () => {
  it("uses one facade per route and never allocates or focuses a surface", async () => {
    const h = fixture();
    expect(h.route.chatPhysical()).toBe(h.route.chatPhysical());
    const result = await h.route.chatPhysical().prepare(
      {
        operationId: "prepare",
        target: { kind: "new-saved" },
        deadlineMillis: Date.now() + 5_000,
      },
      () => true,
    );
    expect(result).toMatchObject({
      state: "prepared",
      binding: { phase: "home", conversationId: null, viewId: "73" },
    });
    expect(h.surface.loadURL).not.toHaveBeenCalled();
    expect(h.surface.focus).not.toHaveBeenCalled();
    expect(h.surface.reveal).not.toHaveBeenCalled();
    expect(h.contents.executeJavaScript).toHaveBeenCalledWith(
      expect.any(String),
      false,
    );
  });
  it("loads only the existing owned saved page, with no Task engine", async () => {
    const h = fixture();
    const task = vi.spyOn(h.route, "runReadonlyTask");
    expect(
      await h.route.chatPhysical().prepare(
        {
          operationId: "prepare",
          target: { kind: "owned-saved", conversationId: "actual-cid" },
          deadlineMillis: Date.now() + 5_000,
        },
        () => true,
      ),
    ).toMatchObject({
      state: "prepared",
      binding: { conversationId: "actual-cid" },
    });
    expect(h.surface.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://chatgpt.com/c/actual-cid",
    );
    expect(task).not.toHaveBeenCalled();
  });
  it("keeps the controlled fixture path in its qualified origin", async () => {
    const h = fixture(true, "http://127.0.0.1:41011");
    expect(
      await h.route.chatPhysical().prepare(
        {
          operationId: "prepare",
          target: { kind: "owned-saved", conversationId: "actual-cid" },
          deadlineMillis: Date.now() + 5_000,
        },
        () => true,
      ),
    ).toMatchObject({ state: "prepared" });
    expect(h.surface.loadURL).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:41011/chatgpt/c/actual-cid",
    );
  });
  it("fails closed when the route has no qualified source profile", async () => {
    const h = fixture(false);
    expect(
      await h.route.chatPhysical().prepare(
        {
          operationId: "prepare",
          target: { kind: "new-saved" },
          deadlineMillis: Date.now() + 5_000,
        },
        () => true,
      ),
    ).toMatchObject({ state: "refused" });
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
  });
  it("preserves document identity on SPA CID adoption, changing it on document load", () => {
    const h = fixture();
    h.harden();
    const before = h.snapshot();
    h.contents.emit(
      "did-start-navigation",
      {},
      "https://chatgpt.com/c/actual-cid",
      true,
      true,
    );
    h.navigate("https://chatgpt.com/c/actual-cid");
    h.contents.emit(
      "did-navigate-in-page",
      {},
      "https://chatgpt.com/c/actual-cid",
      true,
    );
    expect(h.snapshot()).toMatchObject({
      phase: "conversation",
      documentGeneration: before.documentGeneration,
    });
    h.contents.emit("did-start-navigation", {}, h.homeUrl, false, true);
    h.navigate(h.homeUrl);
    Reflect.set(h.route, "load", "loaded");
    expect(h.snapshot().documentGeneration).toBe(before.documentGeneration + 1);
  });
  it("confirms disposal only from the captured WebContents destruction event/readback", async () => {
    const h = fixture();
    const binding = h.snapshot();
    expect(
      await h.route.chatPhysical().dispose(
        {
          operationId: "dispose",
          binding,
          deadlineMillis: Date.now() + 5_000,
        },
        () => true,
      ),
    ).toMatchObject({ state: "destroyed", destroyedWebContentsId: "73" });
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.contents.listenerCount("destroyed")).toBe(0);
    expect(Reflect.get(h.route, "routeWindow")).toBeNull();
  });
  it("does not convert route disposal's void return into a destruction witness", async () => {
    const h = fixture();
    vi.spyOn(h.route, "dispose").mockImplementation(() => {
      Reflect.set(h.route, "routeWindow", null);
    });
    const binding = h.snapshot();
    expect(
      await h.route
        .chatPhysical()
        .dispose(
          { operationId: "dispose", binding, deadlineMillis: Date.now() + 20 },
          () => true,
        ),
    ).toMatchObject({ state: "unconfirmed" });
    expect(h.contents.listenerCount("destroyed")).toBe(0);
    expect(h.surface.destroy).not.toHaveBeenCalled();
  });
});

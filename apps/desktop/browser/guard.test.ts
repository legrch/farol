import { describe, expect, it } from "vitest";
import type { PhysicalBinding } from "../chatgpt-physical-api.ts";
import { prepareGuard, sessionGuard, type GuardView } from "./guard.ts";

const partition = "persist:farol-dev-chatgpt" as const;
const view = { viewId: "v1", viewGeneration: 1, partition };
const home = (documentGeneration = 1): PhysicalBinding => ({
  ...view,
  documentGeneration,
  url: "https://chatgpt.com/",
  phase: "home",
  conversationId: null,
});
const chat = (documentGeneration = 1, id = "abc"): PhysicalBinding => ({
  ...view,
  documentGeneration,
  url: `https://chatgpt.com/c/${id}`,
  phase: "conversation",
  conversationId: id,
});
type State = {
  current: boolean;
  failed: boolean;
  origin?: PhysicalBinding;
  physical?: PhysicalBinding;
  cid?: string;
};
const make = (state: State): GuardView => ({
  partition,
  e2eOrigin: null,
  current: () => state.current,
  failed: () => state.failed,
  origin: () => state.origin,
  physical: () => state.physical,
  cid: () => state.cid,
});
const fresh = (patch: Partial<State> = {}): State => ({
  current: true,
  failed: false,
  ...patch,
});
const newSaved = { mode: "new-saved", conversationId: "" } as const;

describe("browser session guard", () => {
  it("refuses before the origin is known or when no longer current", () => {
    expect(sessionGuard(make(fresh()))(home())).toBe(false);
    expect(
      sessionGuard(make(fresh({ origin: home(), current: false })))(home()),
    ).toBe(false);
  });

  it("refuses an invalid or different view", () => {
    const guard = sessionGuard(make(fresh({ origin: home() })));
    expect(guard(home())).toBe(true);
    expect(guard({ ...home(), viewId: "other" })).toBe(false);
    expect(guard({ ...home(), url: "https://evil.example/" })).toBe(false);
  });

  it("allows a Home origin to adopt a conversation only in a transition", () => {
    const state = fresh({ origin: home() });
    expect(sessionGuard(make(state))(chat())).toBe(false);
    expect(sessionGuard(make(state), true)(chat())).toBe(true);
    expect(sessionGuard(make(state), true)(home(2))).toBe(false);
  });

  it("pins a conversation origin and the adopted physical binding", () => {
    expect(sessionGuard(make(fresh({ origin: chat() })), true)(chat(3))).toBe(
      false,
    );
    const adopted = fresh({ origin: home(), cid: "abc", physical: chat() });
    expect(sessionGuard(make(adopted))(chat())).toBe(true);
    expect(sessionGuard(make(adopted))(chat(3))).toBe(false);
  });
});

describe("browser prepare guard", () => {
  const saved = { mode: "owned-saved", conversationId: "abc" } as const;

  it("admits the initial binding, then one navigation to the target", () => {
    const guard = prepareGuard(make(fresh()), newSaved);
    expect(guard(home())).toBe(true);
    expect(guard(home())).toBe(true);
  });

  it("refuses a destination other than the requested one", () => {
    const guard = prepareGuard(make(fresh()), saved);
    expect(guard(home())).toBe(true);
    expect(guard(chat(2, "other"))).toBe(false);
  });

  it("requires a new document epoch to leave the initial URL and fixes it", () => {
    const guard = prepareGuard(make(fresh()), saved);
    expect(guard(home())).toBe(true);
    expect(guard(chat(1))).toBe(false);
    const again = prepareGuard(make(fresh()), saved);
    expect(again(home())).toBe(true);
    expect(again(chat(2))).toBe(true);
    expect(again(chat(2))).toBe(true);
    expect(again(chat(3))).toBe(false);
  });

  it("is fenced for good after one rejection", () => {
    const guard = prepareGuard(make(fresh()), newSaved);
    expect(guard(home())).toBe(true);
    expect(guard(home(0))).toBe(false);
    expect(guard(home())).toBe(false);
  });

  it("starts from the prior binding of a retired slot", () => {
    const guard = prepareGuard(make(fresh()), saved, home(5));
    expect(guard(home(1))).toBe(false);
    const ok = prepareGuard(make(fresh()), saved, home(5));
    expect(ok(chat(6))).toBe(true);
  });

  it("is fenced by a failed session or a stale assignment", () => {
    expect(prepareGuard(make(fresh({ failed: true })), newSaved)(home())).toBe(
      false,
    );
    expect(
      prepareGuard(make(fresh({ current: false })), newSaved)(home()),
    ).toBe(false);
  });

  it("holds the prepared origin exactly once it is set", () => {
    const state = fresh();
    const guard = prepareGuard(make(state), newSaved);
    expect(guard(home())).toBe(true);
    state.origin = home();
    expect(guard(home())).toBe(true);
    expect(guard(chat())).toBe(false);
  });
});

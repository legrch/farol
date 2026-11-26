import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  actionFeedback,
  feedbackPage,
  intention,
  retainedSetupIntents,
  settledEdit,
  soleIntent,
  useSettingsAttention,
  useSettingsFeedback,
  useSetupIntents,
} from "./intents";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const edit = "settings:computer.apply-workspace-edit:op1";
const intent = (
  id: string,
  state: Intent["state"],
  code: string | null = null,
): Intent => ({ id, state, code });
const snap = (intents: Record<string, Intent>) =>
  ({ intents }) as unknown as WindowSnapshot;
const facade = () => ({}) as unknown as RendererFacade;

describe("intention", () => {
  it.each([
    [["a"], "settings:a:"],
    [["a", "w1"], "settings:a:w1"],
  ] as const)("%j", ([kind, id], want) => {
    expect(intention(kind, id)).toBe(want);
  });
});

describe("feedbackPage", () => {
  it("maps setup to the visible section and others to their page", () => {
    expect(feedbackPage({ area: "settings", page: "general" } as never)).toBe(
      "general",
    );
    const setup = feedbackPage({ area: "setup", setupStep: "signin" } as never);
    expect(setup.startsWith("setup:")).toBe(true);
  });
});

describe("settledEdit", () => {
  const pending = intent(edit, "pending");
  const applied = intent(edit, "applied");
  it.each([
    ["null result", null, snap({}), null],
    ["unretained", "unretained" as const, snap({}), null],
    [
      "other intent id",
      intent("x:y", "pending"),
      snap({ "x:y": applied }),
      null,
    ],
    ["no current entry", pending, snap({}), null],
    ["current is the same object", pending, snap({ [edit]: pending }), null],
    [
      "current still pending",
      pending,
      snap({ [edit]: intent(edit, "pending") }),
      null,
    ],
    [
      "current unknown",
      pending,
      snap({ [edit]: intent(edit, "unknown") }),
      null,
    ],
    ["current applied", pending, snap({ [edit]: applied }), applied],
    [
      "current refused",
      pending,
      snap({ [edit]: intent(edit, "refused") }),
      intent(edit, "refused"),
    ],
  ] as const)("%s", (_n, result, snapshot, want) => {
    expect(settledEdit(result as never, snapshot)).toEqual(want);
  });
});

describe("actionFeedback", () => {
  it.each([
    [intent("a", "pending"), "Saving or checking…"],
    [intent("a", "unknown"), /could not confirm/],
    [intent("a", "applied", "SETTINGS_WRITE_FAILED"), /could not confirm/],
    [intent("a", "refused"), /could not be completed/],
    [intent("a", "applied"), "Saved."],
  ] as const)("%j", (result, want) => {
    const text = actionFeedback(result);
    if (typeof want === "string") expect(text).toBe(want);
    else expect(text).toMatch(want);
  });
});

describe("soleIntent", () => {
  const a = intent("settings:k:", "applied");
  const b = intent("other", "applied");
  it("accepts when only the own intent changed", () => {
    expect(
      soleIntent(snap({ other: b }), snap({ other: b, [a.id]: a }), "k"),
    ).toBe(true);
  });
  it("rejects when a foreign intent changed or appeared", () => {
    expect(
      soleIntent(
        snap({ other: b }),
        snap({ other: intent("other", "refused") }),
        "k",
      ),
    ).toBe(false);
    expect(soleIntent(snap({}), snap({ other: b }), "k")).toBe(false);
  });
  it("honours an explicit id and ignores the default one", () => {
    expect(soleIntent(snap({}), snap({ mine: a }), "k", "mine")).toBe(true);
    expect(soleIntent(snap({}), snap({ [a.id]: a }), "k", "mine")).toBe(false);
  });
  it("accepts an unchanged snapshot", () => {
    expect(soleIntent(snap({ other: b }), snap({ other: b }), "k")).toBe(true);
  });
});

describe("retainedSetupIntents", () => {
  it("is empty without a window feedback store", () => {
    expect(retainedSetupIntents(facade(), snap({}))).toEqual([]);
  });
  it("returns retained intents, settled edits and an unretained marker", () => {
    const f = facade();
    let store!: ReturnType<typeof useSettingsFeedback>;
    const host = document.createElement("div");
    const root = createRoot(host);
    function Probe() {
      store = useSettingsFeedback(f);
      return null;
    }
    act(() => root.render(createElement(Probe)));
    store.intents = {
      plain: intent("plain", "unknown"),
      [edit]: intent(edit, "unknown"),
    };
    const settled = intent(edit, "applied");
    expect(retainedSetupIntents(f, snap({ [edit]: settled }))).toEqual([
      intent("plain", "unknown"),
      settled,
    ]);
    store.unretained = true;
    expect(retainedSetupIntents(f, snap({})).at(-1)).toEqual({
      id: "setup:unretained",
      state: "unknown",
      code: null,
    });
    act(() => root.unmount());
  });
});

describe("hooks", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => act(() => root?.unmount()));
  function mount(f: RendererFacade, snapshot: () => WindowSnapshot) {
    const seen: { intents: readonly Intent[]; attention: boolean }[] = [];
    let store!: ReturnType<typeof useSettingsFeedback>;
    function Probe() {
      store = useSettingsFeedback(f);
      seen.push({
        intents: useSetupIntents(f, snapshot()),
        attention: useSettingsAttention(f, snapshot()),
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Probe)));
    return { seen, store };
  }
  it("derives attention and intents, and re-renders on change", () => {
    const f = facade();
    const m = mount(f, () => snap({}));
    expect(m.seen.at(-1)).toEqual({ intents: [], attention: false });
    act(() => {
      m.store.intents = { a: intent("a", "unknown") };
      m.store.changed();
    });
    expect(m.seen.at(-1)).toEqual({
      intents: [intent("a", "unknown")],
      attention: true,
    });
    act(() => {
      m.store.intents = { a: intent("a", "applied") };
      m.store.changed();
    });
    expect(m.seen.at(-1)?.attention).toBe(false);
    act(() => {
      m.store.unretained = true;
      m.store.changed();
    });
    expect(m.seen.at(-1)?.attention).toBe(true);
  });
  it("does not raise attention for an unknown edit that settled", () => {
    const f = facade();
    const m = mount(f, () => snap({ [edit]: intent(edit, "applied") }));
    act(() => {
      m.store.intents = { [edit]: intent(edit, "unknown") };
      m.store.changed();
    });
    expect(m.seen.at(-1)?.attention).toBe(false);
  });
});

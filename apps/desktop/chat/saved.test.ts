import { describe, expect, it, vi } from "vitest";
import {
  savedChatFollowUpScript,
  type SavedChatPhysicalBinding,
} from "../../../src/apps/desktop/saved-chat-page-scripts";
import {
  createSavedChatFollowUp,
  createSavedChatProbes,
  type SavedChatSurfaceSnapshot,
} from "./saved";

const conversationUrl =
  "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";

const binding: SavedChatPhysicalBinding = {
  conversationId: "12345678-1234-4123-8123-123456789abc",
  conversationUrl,
  viewId: "42",
  viewGeneration: 1,
  documentGeneration: 7,
  partition: "persist:farol-app-chatgpt",
};
const selection = {
  model: "Test model",
  effort: "Light",
  connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
};
const request = {
  binding,
  selection,
  previous: { userId: "u1", assistantId: "a1" },
  operation: { id: "op2", state: "not-sent" as const },
  message: "Next",
  digest: "1ff57a29d7c42928a559a31e2e4bce3ee6ac34c2fdf30f7f063188b81822f6a7",
  evidenceId: "fixture-evidence",
  correlation: null,
};
const prepared = {
  state: "prepared",
  evidenceId: "fixture-evidence",
  selection,
};
const submitted = {
  state: "submitted",
  evidenceId: "fixture-evidence",
  selection,
};
const UNKNOWN = { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" };

function followUpHarness(
  input: {
    qualified?: boolean;
    requiredAppName?: string;
    binding?: SavedChatPhysicalBinding | null;
  } = {},
) {
  const state = {
    binding: input.binding === undefined ? binding : input.binding,
    window: {} as object | null,
  };
  const execute = vi.fn(
    async (_script: string, _gesture: boolean): Promise<unknown> => prepared,
  );
  const acquire = vi.fn(() => {
    const window = state.window;
    return {
      execute: (script: string, gesture: boolean) => {
        if (!window) throw new Error("Saved chat surface unavailable");
        return execute(script, gesture);
      },
      isCurrent: () => state.window === window,
    };
  });
  const run = createSavedChatFollowUp({
    qualified: () => input.qualified ?? true,
    requiredAppName: () => input.requiredAppName ?? "Farol DEV",
    binding: () => state.binding,
    acquire,
  });
  return { state, execute, acquire, run };
}

describe("a saved-chat follow-up before any script runs", () => {
  it("refuses an invalid request or action without touching the page", async () => {
    const h = followUpHarness();
    expect(await h.run({}, "prepare", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_INVALID",
    });
    expect(await h.run({}, "observe", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_INVALID",
    });
    expect(
      await h.run(request, "send" as unknown as "submit", () => true),
    ).toEqual({ state: "not-sent", code: "SAVED_CHAT_INVALID" });
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("stays unqualified until the public-output profile is selected", async () => {
    const h = followUpHarness({ qualified: false });
    expect(await h.run(request, "submit", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_UNQUALIFIED",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("refuses a missing or different physical binding as stale", async () => {
    const missing = followUpHarness({ binding: null });
    expect(await missing.run(request, "submit", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_BINDING_STALE",
    });
    const moved = followUpHarness({
      binding: { ...binding, documentGeneration: 8 },
    });
    expect(await moved.run(request, "observe", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_STALE",
    });
    expect(missing.execute).not.toHaveBeenCalled();
    expect(moved.execute).not.toHaveBeenCalled();
  });

  it("asks the caller with a frozen copy and treats a refusal or a throw as not authorized", async () => {
    const seen: unknown[] = [];
    const h = followUpHarness();
    expect(
      await h.run(request, "prepare", (value) => {
        seen.push(value);
        return false;
      }),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_UNQUALIFIED",
    });
    expect(seen).toEqual([binding]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).not.toBe(request.binding);
    expect(
      await h.run(request, "prepare", () => {
        throw new Error("callback failed");
      }),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_UNQUALIFIED",
    });
    expect(
      await h.run(request, "prepare", () => 1 as unknown as boolean),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_UNQUALIFIED",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("refuses a connector other than the app the route is bound to", async () => {
    const h = followUpHarness({ requiredAppName: "Other app" });
    expect(await h.run(request, "prepare", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_SELECTION_MISMATCH",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["unknown", "submitted"] as const)(
    "refuses a mutation whose original operation is %s",
    async (state) => {
      const h = followUpHarness();
      for (const action of ["prepare", "submit"] as const)
        expect(
          await h.run(
            { ...request, operation: { id: "op2", state } },
            action,
            () => true,
          ),
        ).toEqual({
          state: "not-sent",
          code: "SAVED_CHAT_OPERATION_UNSETTLED",
        });
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
});

describe("a saved-chat follow-up on the page", () => {
  it("runs exactly the follow-up script with a user gesture, once", async () => {
    const h = followUpHarness();
    expect(await h.run(request, "prepare", () => true)).toEqual(prepared);
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(
      savedChatFollowUpScript(
        { ...request, binding: request.binding },
        "prepare",
      ),
      true,
    );
  });

  it("answers a lost surface, binding or authority as unknown for Send and stale otherwise, without replay", async () => {
    const changes: Record<
      string,
      (h: ReturnType<typeof followUpHarness>) => boolean
    > = {
      view: (h) => {
        h.state.window = {};
        return true;
      },
      binding: (h) => {
        h.state.binding = { ...binding, documentGeneration: 8 };
        return true;
      },
      lease: () => false,
    };
    for (const [name, change] of Object.entries(changes)) {
      let admitted = true;
      const send = followUpHarness();
      send.execute.mockImplementation(async () => {
        admitted = change(send);
        return submitted;
      });
      expect(await send.run(request, "submit", () => admitted)).toEqual(
        UNKNOWN,
      );
      expect(send.execute, name).toHaveBeenCalledTimes(1);
      let preparedAdmitted = true;
      const prep = followUpHarness();
      prep.execute.mockImplementation(async () => {
        preparedAdmitted = change(prep);
        return prepared;
      });
      expect(
        await prep.run(request, "prepare", () => preparedAdmitted),
      ).toEqual({ state: "not-sent", code: "SAVED_CHAT_BINDING_STALE" });
      expect(prep.execute, name).toHaveBeenCalledTimes(1);
    }
  });

  it("classifies a thrown or rejected page script by action and never repeats it", async () => {
    const send = followUpHarness();
    send.execute.mockRejectedValue(new Error("Synthetic transport loss"));
    expect(await send.run(request, "submit", () => true)).toEqual(UNKNOWN);
    // The same operation and a replacement for the same previous turn are both
    // held back by the in-memory fuse; neither reaches the page.
    expect((await send.run(request, "submit", () => true)).state).not.toBe(
      "submitted",
    );
    expect(
      await send.run(
        { ...request, operation: { id: "replacement", state: "not-sent" } },
        "submit",
        () => true,
      ),
    ).toEqual({ state: "not-sent", code: "SAVED_CHAT_OPERATION_UNSETTLED" });
    expect(send.execute).toHaveBeenCalledTimes(1);

    const prepare = followUpHarness();
    prepare.execute.mockRejectedValue(new Error("boom"));
    expect(await prepare.run(request, "prepare", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
    const observe = followUpHarness();
    observe.execute.mockRejectedValue(new Error("boom"));
    expect(await observe.run(request, "observe", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
  });

  it("treats a window that vanished before the script as an unknown Send, still holding the fuse", async () => {
    const h = followUpHarness();
    h.state.window = null;
    expect(await h.run(request, "submit", () => true)).toEqual(UNKNOWN);
    expect(h.execute).not.toHaveBeenCalled();
    h.state.window = {};
    expect(await h.run(request, "submit", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_OPERATION_UNSETTLED",
    });
  });

  it("answers a malformed page result as unknown for Send and unsupported otherwise", async () => {
    for (const malformed of [undefined, "ok", { state: "submitted" }]) {
      const send = followUpHarness();
      send.execute.mockResolvedValue(malformed);
      expect(await send.run(request, "submit", () => true)).toEqual(UNKNOWN);
      const prep = followUpHarness();
      prep.execute.mockResolvedValue(malformed);
      expect(await prep.run(request, "prepare", () => true)).toEqual({
        state: "awaiting-owner",
        code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
      });
    }
  });

  it("does not accept a result state that belongs to another action", async () => {
    const send = followUpHarness();
    send.execute.mockResolvedValue(prepared);
    expect(await send.run(request, "submit", () => true)).toEqual(UNKNOWN);
    const prep = followUpHarness();
    prep.execute.mockResolvedValue(submitted);
    expect(await prep.run(request, "prepare", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
  });

  it("requires the page to echo the exact selection and evidence", async () => {
    const wrongSelection = {
      ...submitted,
      selection: { ...selection, effort: "Heavy" },
    };
    const send = followUpHarness();
    send.execute.mockResolvedValue(wrongSelection);
    expect(await send.run(request, "submit", () => true)).toEqual(UNKNOWN);
    const prep = followUpHarness();
    prep.execute.mockResolvedValue({
      ...prepared,
      selection: { ...selection, effort: "Heavy" },
    });
    expect(await prep.run(request, "prepare", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
    const evidence = followUpHarness();
    evidence.execute.mockResolvedValue({
      ...submitted,
      evidenceId: "someone-else",
    });
    expect(await evidence.run(request, "submit", () => true)).toEqual(UNKNOWN);
  });

  it("clears the dispatch fuse only for an exact not-sent answer", async () => {
    const h = followUpHarness();
    h.execute.mockResolvedValue({
      state: "not-sent",
      code: "SAVED_CHAT_SELECTION_UNSUPPORTED",
    });
    expect((await h.run(request, "submit", () => true)).state).toBe("not-sent");
    h.execute.mockResolvedValue(submitted);
    expect(await h.run(request, "submit", () => true)).toEqual(submitted);
    expect(h.execute).toHaveBeenCalledTimes(2);
    // Now it is held again: the same operation does not reach the page.
    expect(await h.run(request, "submit", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_OPERATION_UNSETTLED",
    });
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the fuse after an answer that is not a plain not-sent", async () => {
    const h = followUpHarness();
    h.execute.mockResolvedValue({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SELECTION_UNSUPPORTED",
    });
    await h.run(request, "submit", () => true);
    expect(await h.run(request, "submit", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_OPERATION_UNSETTLED",
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("holds a second mutation while one is pending, lets an observation through and releases afterwards", async () => {
    const h = followUpHarness();
    let finish!: (value: unknown) => void;
    h.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.run(request, "prepare", () => true);
    expect(await h.run(request, "prepare", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_OPERATION_UNSETTLED",
    });
    expect(await h.run(request, "submit", () => true)).toEqual({
      state: "not-sent",
      code: "SAVED_CHAT_OPERATION_UNSETTLED",
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    h.execute.mockResolvedValueOnce({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: { userId: "u2", messages: [], terminal: false },
    });
    expect((await h.run(request, "observe", () => true)).state).toBe(
      "observed",
    );
    finish(prepared);
    expect(await pending).toEqual(prepared);
    h.execute.mockResolvedValueOnce(prepared);
    expect(await h.run(request, "prepare", () => true)).toEqual(prepared);
  });

  it("releases the in-flight hold after a failure too", async () => {
    const h = followUpHarness();
    h.execute.mockRejectedValueOnce(new Error("boom"));
    await h.run(request, "prepare", () => true);
    h.execute.mockResolvedValueOnce(prepared);
    expect(await h.run(request, "prepare", () => true)).toEqual(prepared);
  });

  it.each([
    [
      "a foreign frame",
      { userId: "foreign", messages: [], terminal: false },
      "u2",
      "a2",
    ],
    [
      "the previous user",
      { userId: "u1", messages: [], terminal: false },
      "u1",
      "a2",
    ],
    [
      "the previous assistant",
      { userId: "u2", messages: [], terminal: false },
      "u2",
      "a1",
    ],
  ])(
    "will not correlate an observation of %s",
    async (_label, frame, userId, assistantId) => {
      const h = followUpHarness();
      h.execute.mockResolvedValue({
        state: "observed",
        userId,
        assistantId,
        frame,
      });
      expect(await h.run(request, "observe", () => true)).toEqual({
        state: "awaiting-owner",
        code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
      });
    },
  );

  it("will not correlate a frame that still holds the previous assistant message", async () => {
    const h = followUpHarness();
    h.execute.mockResolvedValue({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: {
        userId: "u2",
        messages: [
          { id: "a1", channel: "answer", text: "old", complete: true },
        ],
        terminal: false,
      },
    });
    expect(await h.run(request, "observe", () => true)).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
  });

  it("honors a known correlation and returns a matching observation", async () => {
    const observed = {
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: { userId: "u2", messages: [], terminal: false },
    };
    const h = followUpHarness();
    h.execute.mockResolvedValue(observed);
    expect(
      await h.run(
        { ...request, correlation: { userId: "u2", assistantId: "a2" } },
        "observe",
        () => true,
      ),
    ).toMatchObject({ state: "observed", userId: "u2" });
    expect(
      await h.run(
        { ...request, correlation: { userId: "u9", assistantId: null } },
        "observe",
        () => true,
      ),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
    expect(
      await h.run(
        { ...request, correlation: { userId: "u2", assistantId: "a9" } },
        "observe",
        () => true,
      ),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
  });
});

function surfaceHarness() {
  const identity = {};
  // Like a real window: once destroyed, reading its address throws.
  let urlReads = 0;
  const state = {
    window: identity as object | null,
    destroyed: false,
    loaded: true,
    url: conversationUrl,
    documentGeneration: 7,
  };
  const execute = vi.fn(
    async (_script: string, _gesture: boolean): Promise<unknown> => ({
      ok: true,
    }),
  );
  const load = vi.fn(async (url: string) => {
    state.url = url;
  });
  const snapshot = (): SavedChatSurfaceSnapshot | null =>
    state.window === null
      ? null
      : {
          surface: state.window,
          destroyed: state.destroyed,
          loaded: state.loaded,
          url: () => {
            urlReads += 1;
            if (state.destroyed) throw new Error("Object has been destroyed");
            return state.url;
          },
          documentGeneration: state.documentGeneration,
          execute,
          load,
        };
  const probes = createSavedChatProbes({
    snapshot,
    canonicalConversationUrl: (url) =>
      /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/.test(url) ? url : null,
  });
  return { state, execute, load, probes, urlReads: () => urlReads };
}

describe("a restricted saved-chat probe", () => {
  it("runs the script once with a gesture and returns its result", async () => {
    const h = surfaceHarness();
    expect(await h.probes.run("script", conversationUrl)).toEqual({ ok: true });
    expect(h.execute).toHaveBeenCalledExactlyOnceWith("script", true);
  });

  it.each([
    [
      "no window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = null),
    ],
    [
      "a destroyed window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
    ],
    [
      "a page that is not loaded",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ],
    [
      "another address",
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.url = "https://chatgpt.com/"),
    ],
  ])("runs nothing with %s", async (_label, change) => {
    const h = surfaceHarness();
    change(h);
    expect(await h.probes.run("script", conversationUrl)).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a replaced window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = {}),
    ],
    [
      "a destroyed window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
    ],
    [
      "no window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = null),
    ],
    [
      "a navigation",
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.url = "https://chatgpt.com/"),
    ],
    [
      "a new document",
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.documentGeneration += 1),
    ],
    [
      "a load that ended",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ],
  ])("discards the answer after %s", async (_label, change) => {
    const h = surfaceHarness();
    h.execute.mockImplementation(async () => {
      change(h);
      return { ok: true };
    });
    expect(await h.probes.run("script", conversationUrl)).toBeNull();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("lets a send navigate or reload but keeps the window identity", async () => {
    for (const change of [
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.url = "https://chatgpt.com/"),
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.documentGeneration += 1),
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ]) {
      const h = surfaceHarness();
      h.execute.mockImplementation(async () => {
        change(h);
        return { clicked: true };
      });
      expect(await h.probes.run("script", conversationUrl, true)).toEqual({
        clicked: true,
      });
    }
    for (const change of [
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = {}),
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = null),
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
    ]) {
      const h = surfaceHarness();
      h.execute.mockImplementation(async () => {
        change(h);
        return { clicked: true };
      });
      expect(await h.probes.run("script", conversationUrl, true)).toBeNull();
    }
  });

  it("never reads the address of a window that is destroyed or not loaded", async () => {
    for (const change of [
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ]) {
      const h = surfaceHarness();
      change(h);
      await expect(h.probes.run("script", conversationUrl)).resolves.toBeNull();
      expect(h.urlReads()).toBe(0);
      expect(h.execute).not.toHaveBeenCalled();
    }
  });

  it("answers null, not an error, when the window is destroyed during the script", async () => {
    for (const allowNavigation of [false, true]) {
      const h = surfaceHarness();
      h.execute.mockImplementation(async () => {
        h.state.destroyed = true;
        return { ok: true };
      });
      await expect(
        h.probes.run("script", conversationUrl, allowNavigation),
      ).resolves.toBeNull();
      // One read before the script; none after a destroyed window.
      expect(h.urlReads()).toBe(1);
    }
  });

  it("does not read the address after a send that may navigate", async () => {
    const h = surfaceHarness();
    await expect(
      h.probes.run("script", conversationUrl, true),
    ).resolves.toEqual({ ok: true });
    expect(h.urlReads()).toBe(1);
  });

  it("answers null when the script throws and never runs it again", async () => {
    const h = surfaceHarness();
    h.execute.mockRejectedValue(new Error("Synthetic transport loss"));
    expect(await h.probes.run("script", conversationUrl, true)).toBeNull();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});

describe("loading a saved conversation", () => {
  it("loads a canonical address and confirms the same window shows it", async () => {
    const h = surfaceHarness();
    h.state.url = "https://chatgpt.com/";
    expect(await h.probes.load(conversationUrl)).toBe(true);
    expect(h.load).toHaveBeenCalledExactlyOnceWith(conversationUrl);
  });

  it("refuses an address that is not canonical before touching the window", async () => {
    const h = surfaceHarness();
    expect(await h.probes.load("https://chatgpt.com/c/short")).toBe(false);
    expect(h.load).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = null),
    ],
    [
      "a destroyed window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
    ],
    [
      "a page that is not loaded",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ],
  ])("does not load with %s", async (_label, change) => {
    const h = surfaceHarness();
    change(h);
    expect(await h.probes.load(conversationUrl)).toBe(false);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("never reads the address of a window that is destroyed or not loaded", async () => {
    for (const change of [
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ]) {
      const h = surfaceHarness();
      change(h);
      await expect(h.probes.load(conversationUrl)).resolves.toBe(false);
      expect(h.urlReads()).toBe(0);
      expect(h.load).not.toHaveBeenCalled();
    }
  });

  it("answers false, not an error, when the window is destroyed during the load", async () => {
    const h = surfaceHarness();
    h.load.mockImplementation(async () => {
      h.state.destroyed = true;
    });
    await expect(h.probes.load(conversationUrl)).resolves.toBe(false);
    expect(h.urlReads()).toBe(0);
  });

  it("answers false when the address throws after the load", async () => {
    const h = surfaceHarness();
    h.load.mockImplementation(async () => {
      // Unreadable although `destroyed` does not show it.
      Object.defineProperty(h.state, "url", {
        get() {
          throw new Error("Object has been destroyed");
        },
      });
    });
    await expect(h.probes.load(conversationUrl)).resolves.toBe(false);
  });

  it("answers false when the load rejects, without a second load", async () => {
    const h = surfaceHarness();
    h.load.mockRejectedValue(new Error("net::ERR_FAILED"));
    expect(await h.probes.load(conversationUrl)).toBe(false);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a replaced window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.window = {}),
    ],
    [
      "a destroyed window",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.destroyed = true),
    ],
    [
      "a load that ended",
      (h: ReturnType<typeof surfaceHarness>) => (h.state.loaded = false),
    ],
    [
      "another address",
      (h: ReturnType<typeof surfaceHarness>) =>
        (h.state.url = "https://chatgpt.com/"),
    ],
  ])("answers false after %s", async (_label, change) => {
    const h = surfaceHarness();
    h.load.mockImplementation(async () => {
      change(h);
    });
    expect(await h.probes.load(conversationUrl)).toBe(false);
  });
});

describe("a bounded saved-chat read", () => {
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  function boundedHarness(answer: () => Promise<unknown>) {
    const h = surfaceHarness();
    h.execute.mockImplementation(answer);
    const clock = {
      t: 1_000,
      timers: [] as { callback: () => void; ms: number; cancelled: boolean }[],
    };
    const probes = createSavedChatProbes({
      snapshot: () => ({
        surface: h.state.window as object,
        destroyed: false,
        loaded: true,
        url: () => h.state.url,
        documentGeneration: h.state.documentGeneration,
        execute: h.execute,
        load: h.load,
      }),
      canonicalConversationUrl: (url) => url,
      clock: {
        now: () => clock.t,
        after: (callback, ms) => {
          const timer = { callback, ms, cancelled: false };
          clock.timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
    });
    return { probes, clock, execute: h.execute };
  }

  it("rejects with a timeout, never an unreadable page, when the page never answers within its budget", async () => {
    const h = boundedHarness(() => new Promise<unknown>(() => undefined));
    const settled = vi.fn();
    const pending = h.probes.run("script", conversationUrl, false, 2_000).then(
      (value) => {
        settled(value);
        return value;
      },
      (error: unknown) => {
        settled(error);
        throw error;
      },
    );
    await flush();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    h.clock.t += 2_000;
    h.clock.timers[0]?.callback();
    await expect(pending).rejects.toThrow("Saved-chat page read timed out");
  });

  it("never returns a positive answer that arrives after the budget", async () => {
    let release!: (value: unknown) => void;
    const h = boundedHarness(
      () => new Promise<unknown>((resolve) => (release = resolve)),
    );
    const pending = h.probes.run("script", conversationUrl, false, 2_000);
    await flush();
    h.clock.t += 2_001;
    release({ ok: true });
    await expect(pending).rejects.toThrow("Saved-chat page read timed out");
  });

  it("returns a timely answer and cancels its timer", async () => {
    const h = boundedHarness(async () => ({ ok: true }));
    expect(await h.probes.run("script", conversationUrl, false, 2_000)).toEqual(
      { ok: true },
    );
    expect(h.clock.timers.every((timer) => timer.cancelled)).toBe(true);
  });
});

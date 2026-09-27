import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));

import {
  NextSavedChatBrowser,
  type SavedChatRouteFactory,
} from "../../src/apps/desktop/saved-chat-browser";

const url = "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";

function routes(
  partition:
    | "persist:farol-next-chatgpt"
    | "persist:farol-dev-chatgpt" = "persist:farol-next-chatgpt",
  requiredAppName?: string,
) {
  const created: Array<{
    calls: string[];
    route: Record<string, unknown>;
  }> = [];
  let submit: unknown = { clicked: true };
  let observed = "authenticated";
  let readerProof: unknown = { verified: true, titleVerified: false };
  const factory: SavedChatRouteFactory = (options) => {
    expect(options.partition).toBe(partition);
    expect(options.requiredAppName).toBe(requiredAppName);
    expect(options.windowPresentation).toEqual({ mode: "hidden" });
    expect(options.initialUrl).toBe("https://chatgpt.com/");
    const calls: string[] = [];
    const index = created.length;
    const route = {
      async open() {
        calls.push("open");
        return { status: "opened" as const };
      },
      async observe() {
        calls.push("observe");
        return { state: observed };
      },
      async savedChatReady() {
        calls.push("ready");
        return { ready: true };
      },
      async savedChatInsert() {
        calls.push("insert");
        return { inserted: true };
      },
      async savedChatSubmit() {
        calls.push("submit");
        return submit;
      },
      currentSavedChatUrl() {
        calls.push("currentUrl");
        return url;
      },
      async savedChatProof(
        _url: string,
        _message: string,
        _title: string,
        requireHistory: boolean,
      ) {
        calls.push(requireHistory ? "proof:history" : "proof:initial");
        return index === 0
          ? { verified: true, titleVerified: false }
          : readerProof;
      },
      async savedChatLoad() {
        calls.push("load");
        return true;
      },
      dispose() {
        calls.push("dispose");
      },
    };
    created.push({ calls, route });
    return route as unknown as ReturnType<SavedChatRouteFactory>;
  };
  return {
    created,
    factory,
    setSubmit(value: unknown) {
      submit = value;
    },
    setObserved(value: string) {
      observed = value;
    },
    setReaderProof(value: unknown) {
      readerProof = value;
    },
  };
}

describe("hidden Next saved-chat browser adapter", () => {
  it("closes the one sending helper before a fresh read-only reopen", async () => {
    const state = routes();
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      {
        partition: "persist:farol-next-chatgpt",
      },
      Date.now,
      undefined,
      () => true,
    );
    expect(await browser.prepare()).toBe("ready");
    expect(await browser.sendOnce("One message", "0".repeat(64))).toEqual({
      status: "candidate",
      conversationUrl: url,
    });
    expect(state.created[0]?.calls).toEqual([
      "open",
      "observe",
      "ready",
      "insert",
      "submit",
      "currentUrl",
      "proof:initial",
      "dispose",
    ]);
    expect(await browser.reopen(url, "0".repeat(64), "1".repeat(64))).toEqual({
      status: "verified",
      titleVerified: false,
    });
    expect(state.created[1]?.calls).toEqual([
      "open",
      "load",
      "load",
      "observe",
      "proof:history",
      "dispose",
    ]);
  });

  it("never retries an unknown submit and disposes its own hidden route", async () => {
    const state = routes();
    state.setSubmit(null);
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      {
        partition: "persist:farol-next-chatgpt",
      },
      Date.now,
      undefined,
      () => true,
    );
    expect(await browser.prepare()).toBe("ready");
    expect(await browser.sendOnce("One message", "0".repeat(64))).toEqual({
      status: "outcome_unknown",
    });
    expect(
      state.created[0]?.calls.filter((call) => call === "submit"),
    ).toHaveLength(1);
    expect(state.created[0]?.calls.at(-1)).toBe("dispose");
  });

  it("closes signed-out surfaces and refuses unrecorded reopen URLs", async () => {
    const state = routes();
    state.setObserved("signed_out");
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      {
        partition: "persist:farol-next-chatgpt",
      },
    );
    expect(await browser.prepare()).toBe("sign_in_required");
    expect(state.created[0]?.calls).toEqual(["open", "observe", "dispose"]);
    expect(
      await browser.reopen(`${url}?share=1`, "0".repeat(64), "1".repeat(64)),
    ).toEqual({
      status: "unverified",
    });
    expect(state.created).toHaveLength(1);
  });

  it("does not click Send when account admission is revoked after insertion", async () => {
    const state = routes();
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      { partition: "persist:farol-next-chatgpt" },
      Date.now,
      undefined,
      () => false,
    );
    expect(await browser.prepare()).toBe("ready");
    expect(await browser.sendOnce("One", "0".repeat(64))).toEqual({
      status: "not_sent",
      code: "SAVED_CHAT_ADMISSION_REVOKED",
    });
    expect(state.created[0]?.calls).toEqual([
      "open",
      "observe",
      "ready",
      "insert",
      "dispose",
    ]);
  });

  it("does not click Send after the MCP caller disconnects before submission", async () => {
    const state = routes();
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      { partition: "persist:farol-next-chatgpt" },
      Date.now,
      undefined,
      () => true,
    );
    expect(await browser.prepare()).toBe("ready");
    expect(
      await browser.sendOnce("One", "0".repeat(64), () => false),
    ).toMatchObject({ status: "not_sent" });
    expect(state.created[0]?.calls).not.toContain("submit");
  });

  it("does not promote a malformed fresh helper proof", async () => {
    const state = routes();
    state.setReaderProof({ verified: true });
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      {
        partition: "persist:farol-next-chatgpt",
      },
    );
    expect(await browser.prepare()).toBe("ready");
    await browser.closePrepared();
    expect(await browser.reopen(url, "0".repeat(64), "1".repeat(64))).toEqual({
      status: "unverified",
    });
    expect(state.created[1]?.calls.at(-1)).toBe("dispose");
  });

  it("uses the selected Dev profile and app binding instead of a hardcoded preview session", async () => {
    const state = routes("persist:farol-dev-chatgpt", "Farol Dev");
    const browser = new NextSavedChatBrowser(
      "https://chatgpt.com/",
      null,
      state.factory,
      {
        partition: "persist:farol-dev-chatgpt",
        requiredAppName: "Farol Dev",
      },
    );
    expect(await browser.prepare()).toBe("ready");
    await browser.closePrepared();
  });
});

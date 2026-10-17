import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetiredReplies } from "../../src/ui/renderer/retired-replies";
import { WindowController } from "../../src/ui/renderer/controller";
import {
  storedPage,
  storedReply,
  storedSummary,
} from "../fixtures/recovery-archive";
import { bootstrap, deferred, fixture } from "./fixture";

// DOM/controller evidence only, not Electron/Go/native filesystem acceptance.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [],
  controllers: WindowController[] = [];
const context = { profileId: "profile", backendGeneration: "current" };
const page = {
  context,
  result: {
    status: "ok",
    data: { kind: "archive-list", after: "", ...storedPage() },
  },
};
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount() {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    chatHistoryContext: context,
  });
  const read = vi.fn(async (): Promise<unknown> => structuredClone(page));
  const c = new WindowController({ ...f.api, retiredReplies: read });
  controllers.push(c);
  await c.start();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return <RetiredReplies snapshot={snapshot} facade={c} />;
  }
  await act(async () => root.render(<View />));
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    if (!found) throw Error(`missing ${text}`);
    return found;
  };
  return { f, c, read, host, button };
}

describe("retired stored replies in a normal app session", () => {
  it("uses explicit clicks and literal unconfirmed content without send or ACK controls", async () => {
    const f = await mount();
    expect(f.read).not.toHaveBeenCalled();
    const waiting = deferred<unknown>();
    f.read.mockReturnValueOnce(waiting.promise);
    await act(async () => {
      f.button("Load stored replies").click();
      f.button("Load stored replies").click();
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    await act(async () => waiting.resolve(page));
    const text = "Stored copy <script>repeat()</script>";
    const summary = storedSummary(1, text);
    // A changed selection is rejected even when its digest remains the same.
    f.read.mockResolvedValueOnce({
      context,
      result: {
        status: "ok",
        data: { kind: "archive-read", ...storedReply(summary, text) },
      },
    });
    await act(async () => {
      f.host
        .querySelector<HTMLButtonElement>('[aria-label="Open stored reply 1"]')!
        .click();
    });
    expect(f.host.textContent).toContain("reader is paused");
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.f.api.configure).not.toHaveBeenCalled();
    expect(f.f.api.task).not.toHaveBeenCalled();
  });
  it("renders exact stored bytes and discards them after current authority changes", async () => {
    const f = await mount();
    await act(async () => f.button("Load stored replies").click());
    f.read.mockResolvedValueOnce({
      context,
      result: {
        status: "ok",
        data: { kind: "archive-read", ...storedReply() },
      },
    });
    await act(async () =>
      f.host
        .querySelector<HTMLButtonElement>('[aria-label="Open stored reply 1"]')!
        .click(),
    );
    expect(
      f.host.querySelector('[aria-label="Stored reply text"]')?.textContent,
    ).toBe("Synthetic stored reply");
    expect(f.host.textContent).toContain("Outcome unconfirmed");
    expect(
      [...f.host.querySelectorAll("button")].some((b) =>
        /^(Send|Resume|Acknowledge)/u.test(b.textContent ?? ""),
      ),
    ).toBe(false);
    vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      chatHistoryContext: null,
    });
    await act(async () => f.c.refresh());
    expect(f.host.querySelector('[aria-label="Stored reply text"]')).toBeNull();
    expect(f.button("Load stored replies").disabled).toBe(true);
    vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      chatHistoryContext: { ...context, backendGeneration: "successor" },
    });
    await act(async () => f.c.refresh());
    expect(f.host.querySelector('[aria-label="Stored reply text"]')).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("withholds a pending response across a runtime gap without retry", async () => {
    const f = await mount();
    const pending = deferred<unknown>();
    f.read.mockReturnValueOnce(pending.promise);
    const result = f.c.readRetiredReplies({ kind: "archive-list", after: "" });
    const check = expect(result).rejects.toThrow("RETIRED_REPLY_STALE");
    vi.mocked(f.f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      chatHistoryContext: context,
      runtimeState: "offline",
    });
    await act(async () => f.c.refresh());
    await act(async () => f.c.refresh());
    pending.resolve(page);
    await check;
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(["context", "cursor", "provenance", "effect"])(
    "refuses crossed %s before publishing data",
    async (fault) => {
      const f = await mount();
      const value = structuredClone(page);
      const raw: unknown =
        fault === "context"
          ? { ...value, context: { ...context, profileId: "other" } }
          : fault === "cursor"
            ? {
                ...value,
                result: {
                  status: "ok",
                  data: { ...value.result.data, after: "a".repeat(64) },
                },
              }
            : fault === "provenance"
              ? {
                  ...value,
                  result: {
                    status: "ok",
                    data: { ...value.result.data, observation: "confirmed" },
                  },
                }
              : { ...value, result: { ...value.result, ack: true } };
      f.read.mockResolvedValueOnce(raw);
      await expect(
        f.c.readRetiredReplies({ kind: "archive-list", after: "" }),
      ).rejects.toThrow();
      expect(f.read).toHaveBeenCalledTimes(1);
    },
  );
});

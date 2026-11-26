import { describe, expect, it } from "vitest";
import { ABORTED_MESSAGE, abortable } from "./abortable";

describe("abortable", () => {
  it("passes the result of work that settles first", async () => {
    const controller = new AbortController();
    await expect(
      abortable(Promise.resolve(7), controller.signal),
    ).resolves.toBe(7);
    await expect(
      abortable(Promise.reject(new Error("boom")), controller.signal),
    ).rejects.toThrow("boom");
  });

  it("rejects as soon as the signal aborts, while the work is still pending", async () => {
    const controller = new AbortController();
    const pending = abortable(
      new Promise<never>(() => undefined),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(ABORTED_MESSAGE);
  });

  it("rejects at once for a signal that already aborted, and handles the work's own rejection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortable(Promise.reject(new Error("late")), controller.signal),
    ).rejects.toThrow(ABORTED_MESSAGE);
  });

  it("ignores the late result of work that settles after the abort", async () => {
    const controller = new AbortController();
    let finish: (value: number) => void = () => undefined;
    const work = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const pending = abortable(work, controller.signal);
    controller.abort();
    finish(1);
    await expect(pending).rejects.toThrow(ABORTED_MESSAGE);
  });
});

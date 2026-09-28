import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  fixtureSocketFrames,
  fixtureFailureBoundary,
} from "../e2e/fixture-socket-failures.mjs";
it.each(["assertion", "invalid-json"])(
  "forwards %s callback failure into awaited finally",
  async (mode) => {
    const boundary = fixtureFailureBoundary();
    let destroyed = false;
    let cleanupFinished = false;
    const failure =
      mode === "assertion"
        ? new assert.AssertionError({
            message: "useStateDbOnly must stay true",
          })
        : undefined;
    const reader = fixtureSocketFrames(
      {
        destroy() {
          destroyed = true;
        },
      },
      () => {
        throw failure;
      },
      boundary.capture,
    );
    expect(() =>
      reader(mode === "assertion" ? '{"id":1}\n' : "bad-json\n"),
    ).not.toThrow();
    let result;
    try {
      try {
        await boundary.wait(Promise.reject(new Error("Proxy lost")));
      } finally {
        await Promise.resolve().then(() => {
          cleanupFinished = true;
        });
      }
    } catch (error) {
      result = error;
    }
    if (failure) expect(result).toBe(failure);
    else expect(result).toBeInstanceOf(SyntaxError);
    expect(destroyed).toBe(true);
    expect(cleanupFinished).toBe(true);
  },
);
it("handles split and multiple frames without inventing a failure", async () => {
  const boundary = fixtureFailureBoundary();
  const seen = [];
  const read = fixtureSocketFrames(
    {
      destroy() {
        throw new Error("Unexpected close");
      },
    },
    (value) => {
      seen.push(value.id);
    },
    boundary.capture,
  );
  read('{"id":');
  read('1}\n{"id":2}\n');
  expect(seen).toEqual([1, 2]);
  expect(await boundary.wait(Promise.resolve("known"))).toBe("known");
});

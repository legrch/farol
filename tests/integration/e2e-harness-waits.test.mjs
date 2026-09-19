import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Playwright's waitForFunction evaluates its predicate synchronously and treats
// any truthy value as success. The promise an async predicate returns is
// truthy, so such a wait ends on its first evaluation whatever the state it was
// meant to wait for. The E2E harness polls async page state with its own
// awaited poller instead; this keeps the pattern from coming back.
const e2eRoot = path.resolve(import.meta.dirname, "../e2e");

function promiseReturningWaits(source) {
  return [...source.matchAll(/\.waitForFunction\(\s*async\b/gu)].map(
    (match) => source.slice(0, match.index).split("\n").length,
  );
}

describe("E2E harness waits", () => {
  it("recognizes an async predicate however the call is wrapped", () => {
    expect(
      promiseReturningWaits(
        "await page.waitForFunction(\n  async () => ready,\n);\nawait page.waitForFunction(() => ready);\nawait page.waitForFunction(async (id) => id);",
      ),
    ).toEqual([1, 5]);
  });

  it("never passes a promise-returning predicate to waitForFunction", async () => {
    const offenders = [];
    for (const name of (await fs.readdir(e2eRoot)).sort()) {
      if (!name.endsWith(".mjs")) continue;
      const source = await fs.readFile(path.join(e2eRoot, name), "utf8");
      for (const line of promiseReturningWaits(source)) {
        offenders.push(`${name}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

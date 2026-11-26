import { describe, expect, it } from "vitest";
import { statusBody } from "./projection";

describe("statusBody", () => {
  it("ignores the revision so only a real change differs", () => {
    expect(statusBody({ state: "ok", revision: 1 })).toBe(
      statusBody({ state: "ok", revision: 9 }),
    );
    expect(statusBody({ state: "ok", revision: 1 })).not.toBe(
      statusBody({ state: "lost", revision: 1 }),
    );
  });
});

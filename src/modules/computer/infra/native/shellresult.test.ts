import { describe, expect, it } from "vitest";

import { refusal } from "./shellresult";

describe("shell refusal", () => {
  it("never allows a retry", () => {
    expect(refusal("SHELL_BUSY")).toEqual({
      ok: false,
      error: { code: "SHELL_BUSY", retry: "never" },
    });
  });
});

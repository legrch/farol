import { describe, expect, it } from "vitest";

import { failure, success } from "./outcome";

describe("authority outcomes", () => {
  it("wraps a value as an admitted result", () => {
    expect(success(7)).toEqual({ ok: true, value: 7 });
  });

  it("builds a never-retry refusal carrying code and source", () => {
    expect(failure("AUTHORITY_EXPIRED", "task-grant")).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_EXPIRED",
        source: "task-grant",
        retry: "never",
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  FAROL_MODEL_FORWARDED_HEADERS,
  flattenHeaders,
  forwardedHeaders,
} from "./headers";

describe("forwardedHeaders", () => {
  it("relays only the allowlisted non-empty headers", () => {
    expect(FAROL_MODEL_FORWARDED_HEADERS).toEqual(["x-codex-turn-metadata"]);
    expect(
      forwardedHeaders({
        authorization: "Bearer fixture-token",
        "x-codex-turn-metadata": "meta",
      }),
    ).toEqual({ "x-codex-turn-metadata": "meta" });
    expect(forwardedHeaders({ "x-codex-turn-metadata": "" })).toEqual({});
    expect(forwardedHeaders({ "x-codex-turn-metadata": undefined })).toEqual(
      {},
    );
  });
});

describe("flattenHeaders", () => {
  it("joins repeated headers with a comma and keeps undefined", () => {
    expect(flattenHeaders({ a: "1", b: ["x", "y"], c: undefined })).toEqual({
      a: "1",
      b: "x, y",
      c: undefined,
    });
  });
});

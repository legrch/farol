import { describe, expect, it } from "vitest";
import { anonymousRefusal, readableRefusal, routeRefusalCode } from "./refusal";

describe("routeRefusalCode", () => {
  it("falls back to the generic code for unparsable or code-less bodies", () => {
    expect(routeRefusalCode("not json")).toBe("FAROL_MODEL_ROUTE_REFUSED");
    expect(routeRefusalCode("{}")).toBe("FAROL_MODEL_ROUTE_REFUSED");
    expect(routeRefusalCode('{"error":{}}')).toBe("FAROL_MODEL_ROUTE_REFUSED");
  });
  it("never returns provider text that is not a recordable code", () => {
    expect(
      routeRefusalCode('{"error":{"code":"some free text, with spaces"}}'),
    ).toBe("provider_error");
  });
  it("relays a recordable code", () => {
    expect(routeRefusalCode('{"error":{"code":"ROUTE_B_THREAD_BUSY"}}')).toBe(
      "ROUTE_B_THREAD_BUSY",
    );
  });
});

describe("readableRefusal", () => {
  it("renders the code and optional detail as JSON", () => {
    expect(readableRefusal(404, "X")).toEqual({
      status: 404,
      headers: { "content-type": "application/json" },
      body: '{"error":{"code":"X"}}',
    });
    expect(readableRefusal(422, "X", { k: "v" }).body).toBe(
      '{"error":{"code":"X","k":"v"}}',
    );
  });
});

describe("anonymousRefusal", () => {
  it("names no product and challenges only 401", () => {
    expect(anonymousRefusal(401)).toEqual({
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
      body: '{"error":{"code":"unauthorized"}}',
    });
    expect(anonymousRefusal(403)).toEqual({
      status: 403,
      headers: { "content-type": "application/json" },
      body: '{"error":{"code":"forbidden"}}',
    });
  });
});

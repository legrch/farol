import { describe, expect, it } from "vitest";
import { lengthFailure, type HttpsResponse } from "./framing";

function response(headers: HttpsResponse["headers"]): HttpsResponse {
  return {
    statusCode: 200,
    headers,
    body: (async function* () {})(),
    complete: () => true,
    destroy: () => undefined,
  };
}

describe("response framing", () => {
  it("accepts absent or identity encoding and in-limit lengths", () => {
    expect(lengthFailure(response({}), 10)).toBeNull();
    expect(
      lengthFailure(
        response({ "content-encoding": "Identity", "content-length": "10" }),
        10,
      ),
    ).toBeNull();
  });

  it("refuses other encodings before looking at length", () => {
    expect(
      lengthFailure(
        response({ "content-encoding": "gzip", "content-length": "99" }),
        10,
      ),
    ).toMatchObject({ kind: "network_failure", reason: "content_encoding" });
  });

  it("refuses malformed lengths and oversize", () => {
    for (const bad of ["01", "-1", "1.0", "", ["1", "2"]])
      expect(
        lengthFailure(response({ "content-length": bad }), 10),
      ).toMatchObject({ kind: "network_failure", reason: "content_length" });
    expect(
      lengthFailure(response({ "content-length": "11" }), 10),
    ).toMatchObject({ kind: "oversize", reason: "limit" });
  });
});

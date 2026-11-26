import { describe, expect, it } from "vitest";

import {
  FAROL_MODEL_TOKEN_PLACEHOLDER,
  redactBearerTokenLiterals,
} from "./redact";

describe("redactBearerTokenLiterals", () => {
  it("replaces the literal on a token line and keeps the diff prefix", () => {
    const result = redactBearerTokenLiterals(
      '+experimental_bearer_token = "s3cret"\n-other = 1',
    );
    expect(result).toEqual({
      text: `+experimental_bearer_token = "${FAROL_MODEL_TOKEN_PLACEHOLDER}"\n-other = 1`,
      redacted: true,
    });
  });

  it("handles single-quoted literals and escaped quotes", () => {
    expect(
      redactBearerTokenLiterals("experimental_bearer_token='a'").text,
    ).toBe(
      `experimental_bearer_token = "${FAROL_MODEL_TOKEN_PLACEHOLDER}"`.replace(
        " = ",
        "=",
      ),
    );
    expect(
      redactBearerTokenLiterals('  experimental_bearer_token = "a\\"b"').text,
    ).toBe(`  experimental_bearer_token = "${FAROL_MODEL_TOKEN_PLACEHOLDER}"`);
  });

  it("scrubs a known literal wherever it appears", () => {
    const result = redactBearerTokenLiterals(
      "see tok-123 and tok-123",
      "tok-123",
    );
    expect(result).toEqual({
      text: `see ${FAROL_MODEL_TOKEN_PLACEHOLDER} and ${FAROL_MODEL_TOKEN_PLACEHOLDER}`,
      redacted: true,
    });
  });

  it("leaves text without a token alone and ignores an empty literal", () => {
    expect(redactBearerTokenLiterals("a = 1", "")).toEqual({
      text: "a = 1",
      redacted: false,
    });
    expect(redactBearerTokenLiterals("a = 1", "zzz").redacted).toBe(false);
  });
});

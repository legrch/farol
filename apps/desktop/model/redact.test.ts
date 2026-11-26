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

describe("redactBearerTokenLiterals under every key spelling", () => {
  const P = FAROL_MODEL_TOKEN_PLACEHOLDER;
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "inline table",
      'model_providers.farol = { experimental_bearer_token = "fixture-token" }',
      `model_providers.farol = { experimental_bearer_token = "${P}" }`,
    ],
    [
      "nested inline table",
      'model_providers = { farol = { experimental_bearer_token = "fixture-token" } }',
      `model_providers = { farol = { experimental_bearer_token = "${P}" } }`,
    ],
    [
      "dotted key",
      'model_providers.farol.experimental_bearer_token = "fixture-token"',
      `model_providers.farol.experimental_bearer_token = "${P}"`,
    ],
    [
      "double-quoted key",
      '"experimental_bearer_token" = "fixture-token"',
      `"experimental_bearer_token" = "${P}"`,
    ],
    [
      "single-quoted key",
      "'experimental_bearer_token' = \"fixture-token\"",
      `'experimental_bearer_token' = "${P}"`,
    ],
    [
      "quoted key inside a dotted path",
      'model_providers.farol."experimental_bearer_token" = "fixture-token"',
      `model_providers.farol."experimental_bearer_token" = "${P}"`,
    ],
    [
      "single-quoted literal value",
      "a = { experimental_bearer_token = 'fixture-token' }",
      `a = { experimental_bearer_token = "${P}" }`,
    ],
    [
      "escaped quote in a basic string",
      'a = { experimental_bearer_token = "fixture\\"-token" }',
      `a = { experimental_bearer_token = "${P}" }`,
    ],
    [
      "diff prefix",
      '+ model_providers.farol = { experimental_bearer_token = "fixture-token" }',
      `+ model_providers.farol = { experimental_bearer_token = "${P}" }`,
    ],
    [
      "escaped spelling of the key",
      'a = { "experimental\\u005fbearer_token" = "fixture-token" }',
      `a = { "experimental\\u005fbearer_token" = "${P}" }`,
    ],
    [
      "multi-line string",
      'experimental_bearer_token = """\n fixture-token\n"""',
      `experimental_bearer_token = "${P}"`,
    ],
    [
      "undelimited value",
      "experimental_bearer_token = fixture-token",
      `experimental_bearer_token = "${P}"`,
    ],
  ];

  it.each(cases)("redacts %s", (_name, input, expected) => {
    const result = redactBearerTokenLiterals(input);
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("fixture");
    expect(result.redacted).toBe(true);
  });

  it("does not touch the env-var delivery key or unrelated keys", () => {
    const text = 'env_key = "FAROL_TOKEN"\nname = "farol"';
    expect(redactBearerTokenLiterals(text)).toEqual({ text, redacted: false });
  });
});

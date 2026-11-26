import { describe, expect, it } from "vitest";

import {
  FAROL_MODEL_TOKEN_PLACEHOLDER,
  newRedactionRegistry,
  redactBearerTokenLiterals,
  redactConfigText,
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

describe("redactConfigText fails closed on values it cannot delimit", () => {
  const P = FAROL_MODEL_TOKEN_PLACEHOLDER;
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "an escaped key with an undelimited value",
      'a = { "experimental\\u005fbearer_token" = fixture-token }',
      `a = { "experimental\\u005fbearer_token" = "${P}"`,
    ],
    [
      "an escaped key with an unterminated value",
      '"experimental\\u005fbearer_token" = "fixture-token',
      `"experimental\\u005fbearer_token" = "${P}"`,
    ],
    [
      "an unterminated triple-quoted value",
      'experimental_bearer_token = """fixture-token\nmore-fixture-token\nb = 2',
      `experimental_bearer_token = "${P}"`,
    ],
    [
      "an unterminated triple-quoted literal value",
      "experimental_bearer_token = '''fixture-token\nb = 2",
      `experimental_bearer_token = "${P}"`,
    ],
    [
      "an unterminated literal value",
      "experimental_bearer_token = 'fixture-token",
      `experimental_bearer_token = "${P}"`,
    ],
  ];

  it.each(cases)("redacts %s", (_name, input, expected) => {
    const result = redactConfigText(input);
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("fixture");
    expect(result.redacted).toBe(true);
  });

  it("replaces a multi-line value as one span, whatever it holds", () => {
    const result = redactConfigText(
      'before = 1\nexperimental_bearer_token = """\nfixture-token\n"quoted" \\"""\n"""\nafter = 2\n',
    );
    expect(result.text).toBe(
      `before = 1\nexperimental_bearer_token = "${P}"\nafter = 2\n`,
    );
  });

  it("numbers distinct values consistently across texts sharing a registry", () => {
    const registry = newRedactionRegistry();
    const line = (value: string) => `experimental_bearer_token = "${value}"`;
    const old = redactConfigText(line("fixture-a"), registry);
    const same = redactConfigText(line("fixture-a"), registry);
    const other = redactConfigText(line("fixture-b"), registry);
    expect(same.text).toBe(old.text);
    expect(other.text).not.toBe(old.text);
    expect(other.text).not.toContain("fixture");
  });
});

describe("redacted text never carries any part of a token value", () => {
  const SECRET = "fixture-qz9-mark";
  const keys = [
    "experimental_bearer_token",
    '"experimental_bearer_token"',
    "'experimental_bearer_token'",
    '"experimental\\u005fbearer_token"',
    '"experimental_bearer\\U0000005ftoken"',
    "model_providers.farol.experimental_bearer_token",
    'model_providers.farol."experimental_bearer_token"',
  ];
  const values = [
    `"${SECRET}"`,
    `'${SECRET}'`,
    '"fixture-\\"qz9-mark"',
    `"""\n${SECRET}\n"""`,
    `"""${SECRET}\nsecond-${SECRET}"""`,
    `'''\n${SECRET}\n'''`,
    SECRET,
    `"${SECRET}`,
    `'${SECRET}`,
    `"""${SECRET}`,
    `'''${SECRET}`,
  ];
  const wrap = [
    (assignment: string) => assignment,
    (assignment: string) => `{ ${assignment} }`,
    (assignment: string) => `{ farol = { ${assignment}, x = 1 } }`,
    (assignment: string) => `# note\n${assignment}\nafter = 1`,
  ];
  const secretParts = new Set<string>();
  for (let from = 0; from < SECRET.length; from += 1) {
    for (let to = from + 4; to <= SECRET.length; to += 1) {
      secretParts.add(SECRET.slice(from, to));
    }
  }

  const fixtures = keys.flatMap((key) =>
    values.flatMap((value) =>
      wrap.map((around) => `${around(`${key} = ${value}`)}`),
    ),
  );

  it("redacts every key, value and wrapper combination", () => {
    for (const fixture of fixtures) {
      const result = redactConfigText(fixture);
      expect(result.redacted, fixture).toBe(true);
      for (const part of secretParts) {
        expect(result.text, fixture).not.toContain(part);
      }
    }
  });
});

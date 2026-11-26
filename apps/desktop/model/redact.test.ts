import { describe, expect, it } from "vitest";

import {
  FAROL_MODEL_TOKEN_PLACEHOLDER,
  FAROL_MODEL_UNTERMINATED_PLACEHOLDER,
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
      "a token after an unterminated basic string ending in a backslash",
      'note = "unfinished\\\nexperimental_bearer_token = "fixture-token"\n[t]',
      `note = "unfinished\\\nexperimental_bearer_token = "${P}"\n[t]`,
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

  it("withholds everything after an unterminated multi-line string", () => {
    for (const opener of ['"""', "'''"]) {
      const input = `a = 1\nnote = ${opener}unfinished\nexperimental_bearer_token = "fixture-token"\n`;
      const result = redactConfigText(input);
      expect(result.text).toBe(
        `a = 1\nnote = ${FAROL_MODEL_UNTERMINATED_PLACEHOLDER}`,
      );
      expect(result.text).not.toContain("fixture");
      expect(result.redacted).toBe(true);
    }
  });

  it("scrubs the escaped form of a known literal", () => {
    const literal = 'fixture"mark\\value';
    const escaped = JSON.stringify(literal).slice(1, -1);
    const result = redactBearerTokenLiterals(`x ${escaped} y`, literal);
    expect(result.text).toBe(`x ${FAROL_MODEL_TOKEN_PLACEHOLDER} y`);
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
  const MARK = "fixture-mark-value";
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
    `"${MARK}"`,
    `'${MARK}'`,
    '"fixture-\\"mark-value"',
    `"""\n${MARK}\n"""`,
    `"""${MARK}\nsecond-${MARK}"""`,
    `'''\n${MARK}\n'''`,
    MARK,
    `"${MARK}`,
    `'${MARK}`,
    `"""${MARK}`,
    `'''${MARK}`,
  ];
  const wrap = [
    (assignment: string) => assignment,
    (assignment: string) => `# experimental_bearer_token = """\n${assignment}`,
    (assignment: string) =>
      `{ note = "experimental_bearer_token = ", ${assignment} }`,
    (assignment: string) =>
      `note = '''\nexperimental_bearer_token = "\n'''\n${assignment}`,
    (assignment: string) => `{ ${assignment} }`,
    (assignment: string) => `{ farol = { ${assignment}, x = 1 } }`,
    (assignment: string) => `# note\n${assignment}\nafter = 1`,
  ];
  const markParts = new Set<string>();
  for (let from = 0; from < MARK.length; from += 1) {
    for (let to = from + 4; to <= MARK.length; to += 1) {
      markParts.add(MARK.slice(from, to));
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
      for (const part of markParts) {
        expect(result.text, fixture).not.toContain(part);
      }
    }
  });
});

describe("redactConfigText is not fooled by key-like text in strings or comments", () => {
  const P = FAROL_MODEL_TOKEN_PLACEHOLDER;

  it("ignores a key-like string before the real assignment", () => {
    const result = redactConfigText(
      'm.f = { note = "experimental_bearer_token = ", experimental_bearer_token = "fixture-mark-value" }',
    );
    expect(result.text).not.toContain("fixture");
    expect(result.text).toContain(`experimental_bearer_token = "${P}"`);
    expect(result.text).toContain('note = "experimental_bearer_token = "');
  });

  it("ignores a comment that looks like a multi-line opener", () => {
    const result = redactConfigText(
      '# experimental_bearer_token = """\nexperimental_bearer_token = """\nfixture-mark-value\n"""\nafter = 1\n',
    );
    expect(result.text).toBe(
      `# experimental_bearer_token = """\nexperimental_bearer_token = "${P}"\nafter = 1\n`,
    );
  });

  it("leaves a token key that only appears in a string or a comment alone", () => {
    const text =
      'a = "experimental_bearer_token = x" # experimental_bearer_token = y';
    expect(redactConfigText(text)).toEqual({ text, redacted: false });
  });
});

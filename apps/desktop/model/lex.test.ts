import { describe, expect, it } from "vitest";

import {
  hasUnterminatedMultilineString,
  keyText,
  lexToml,
  lineEndOf,
  lineStartsInsideStrings,
  type TomlToken,
} from "./lex";

function slices(text: string): string[] {
  return lexToml(text)
    .filter((token) => token.kind !== "newline")
    .map((token) => `${token.kind}:${text.slice(token.start, token.end)}`);
}

describe("lexToml", () => {
  it("tokenises keys, dots, equals, brackets and scalar values", () => {
    expect(slices('a.b."c d" = { x = [1, 2] }')).toEqual([
      "bare:a",
      "dot:.",
      "bare:b",
      "dot:.",
      'string:"c d"',
      "equals:=",
      "punct:{",
      "bare:x",
      "equals:=",
      "punct:[",
      "bare:1",
      "punct:,",
      "bare:2",
      "punct:]",
      "punct:}",
    ]);
  });

  it("never looks for keys inside strings or comments", () => {
    expect(slices('note = "k = 1" # k = "x"')).toEqual([
      "bare:note",
      "equals:=",
      'string:"k = 1"',
      'comment:# k = "x"',
    ]);
    const opener = lexToml('# k = """\nreal = "v"\n');
    expect(opener.filter((token) => token.kind === "string")).toHaveLength(1);
  });

  it("delimits basic, literal, multi-line and four-quote strings", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['"a\\"b"', '"a\\"b"'],
      ["'a\\'", "'a\\'"],
      ['"""x\n"y"\n"""', '"""x\n"y"\n"""'],
      ["'''x\n\"y\"\n'''", "'''x\n\"y\"\n'''"],
      ['"""a"""" ', '"""a""""'],
      ['"""a\\"""b"""', '"""a\\"""b"""'],
    ];
    for (const [input, expected] of cases) {
      const [token] = lexToml(input);
      expect(token?.kind).toBe("string");
      expect(token?.terminated).toBe(true);
      expect(input.slice(token?.start, token?.end)).toBe(expected);
    }
  });

  it("fails closed on an unterminated string", () => {
    const single = lexToml('a = "open\nb = 1');
    const open = single.find((token) => token.kind === "string") as TomlToken;
    expect(open.terminated).toBe(false);
    expect('a = "open\nb = 1'.slice(open.start, open.end)).toBe('"open');
    const [multi] = lexToml("'''open\nb = 1");
    expect(multi).toMatchObject({ terminated: false, end: 13 });
  });

  it("ends an unterminated basic string at its line even after a trailing backslash", () => {
    for (const eol of ["\n", "\r\n"]) {
      const text = `a = "open\\${eol}b = 1`;
      const open = lexToml(text).find(
        (token) => token.kind === "string",
      ) as TomlToken;
      expect(open.terminated).toBe(false);
      expect(text.slice(open.start, open.end)).toBe('"open\\');
      expect(slices(text)).toContain("bare:b");
    }
  });

  it("detects a multi-line string that never closes", () => {
    expect(hasUnterminatedMultilineString('a = """open\nb = 1')).toBe(true);
    expect(hasUnterminatedMultilineString("a = '''open")).toBe(true);
    expect(hasUnterminatedMultilineString('a = """x"""\nb = "open')).toBe(
      false,
    );
    expect(hasUnterminatedMultilineString('# """ in a comment\n')).toBe(false);
  });

  it("reports line starts that fall inside a multi-line string", () => {
    const text = 'a = """\nx = 1\n[t]\n"""\nb = 2\n';
    const inside = [...lineStartsInsideStrings(text)].sort((a, b) => a - b);
    expect(inside.map((at) => text.slice(at, text.indexOf("\n", at)))).toEqual([
      "x = 1",
      "[t]",
      '"""',
    ]);
  });

  it("decodes quoted keys and ends lines before a CR", () => {
    const [token] = lexToml('"a\\u005fb\\tc"');
    expect(keyText('"a\\u005fb\\tc"', token as TomlToken)).toBe("a_b\tc");
    expect(lineEndOf("ab\r\ncd", 0)).toBe(2);
  });
});

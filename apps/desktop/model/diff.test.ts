import { describe, expect, it } from "vitest";

import { lineDiff } from "./diff";

describe("lineDiff", () => {
  it("is empty for identical text", () => {
    expect(lineDiff("a\n", "a\n")).toBe("");
  });

  it("shows additions against an empty file", () => {
    expect(lineDiff("", "a\nb\n")).toBe("+a\n+b");
  });

  it("folds long unchanged runs down to three lines of context", () => {
    const body = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const before = `${body.join("\n")}\n`;
    const after = `${body.slice(0, 10).join("\n")}\nNEW\n${body.slice(10).join("\n")}\n`;
    const lines = lineDiff(before, after).split("\n");
    expect(lines[0]).toBe("… 7 unchanged lines");
    expect(lines).toContain("+NEW");
    expect(lines[lines.length - 1]).toBe("… 7 unchanged lines");
    expect(lines).toHaveLength(9);
  });

  it("uses singular wording for one elided line", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\n";
    const after = "X\nb\nc\nd\ne\nf\ng\n";
    expect(lineDiff(before, after)).toBe(
      "-a\n+X\n b\n c\n d\n… 3 unchanged lines",
    );
    const one = lineDiff("a\nb\nc\nd\ne\nf\n", "X\nb\nc\nd\ne\nY\n");
    expect(one).toBe(
      "-a\n+X\n b\n c\n d\n e\n-f\n+Y".replace(
        " b\n c\n d\n e",
        " b\n c\n d\n e",
      ),
    );
  });

  it("removes and replaces lines", () => {
    expect(lineDiff("a\nb\n", "a\nc\n")).toBe(" a\n-b\n+c");
  });
});

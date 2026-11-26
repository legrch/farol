import { describe, expect, it } from "vitest";

import {
  BLOCK_BEGIN,
  BLOCK_BEGIN_MARKER,
  BLOCK_END,
  bytesOf,
  insertAt,
  locateRegion,
  nestedInside,
  regionText,
  removeRegion,
  replaceRegion,
  SELECTION_BEGIN,
  SELECTION_END,
  textOf,
} from "./region";

const block = (body = "x = 1") => `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;

describe("region bytes", () => {
  it("round-trips non-ASCII text through latin1 bytes", () => {
    const text = "# — ключ\n";
    expect(textOf(bytesOf(text))).toBe(text);
    expect(bytesOf("—")).toHaveLength(3);
    expect(BLOCK_BEGIN).toBe(bytesOf(BLOCK_BEGIN_MARKER));
  });
});

describe("locateRegion", () => {
  it("reports an absent region as ok without a region", () => {
    expect(locateRegion("a = 1\n", BLOCK_BEGIN, BLOCK_END)).toEqual({
      ok: true,
      region: undefined,
    });
  });

  it("finds a region and its leading break at offset 0 and after text", () => {
    const first = locateRegion(`${block()}\n`, BLOCK_BEGIN, BLOCK_END);
    expect(first).toMatchObject({ ok: true, region: { start: 0, leading: 0 } });
    const later = locateRegion(`a = 1\n${block()}\n`, BLOCK_BEGIN, BLOCK_END);
    expect(later).toMatchObject({ ok: true, region: { start: 6, leading: 1 } });
    const crlf = locateRegion(
      `a = 1\r\n${block()}\r\n`,
      BLOCK_BEGIN,
      BLOCK_END,
    );
    expect(crlf).toMatchObject({ ok: true, region: { leading: 2 } });
  });

  it("treats a region ending at end of file without a break as complete", () => {
    const bytes = `a = 1\n${block()}`;
    const located = locateRegion(bytes, BLOCK_BEGIN, BLOCK_END);
    expect(located).toMatchObject({
      ok: true,
      region: { end: bytes.length },
    });
  });

  it("refuses torn, duplicated, misplaced and trailing-text markers", () => {
    const refused = { ok: false };
    expect(locateRegion(`${BLOCK_END}\n`, BLOCK_BEGIN, BLOCK_END)).toEqual(
      refused,
    );
    expect(locateRegion(`${BLOCK_BEGIN}\n`, BLOCK_BEGIN, BLOCK_END)).toEqual(
      refused,
    );
    expect(
      locateRegion(`${block()}\n${block()}\n`, BLOCK_BEGIN, BLOCK_END),
    ).toEqual(refused);
    expect(locateRegion(`x ${block()}\n`, BLOCK_BEGIN, BLOCK_END)).toEqual(
      refused,
    );
    expect(
      locateRegion(
        `${BLOCK_BEGIN} tail\n${BLOCK_END}\n`,
        BLOCK_BEGIN,
        BLOCK_END,
      ),
    ).toEqual(refused);
    expect(
      locateRegion(
        `${BLOCK_BEGIN}\n${BLOCK_END} tail\n`,
        BLOCK_BEGIN,
        BLOCK_END,
      ),
    ).toEqual(refused);
  });
});

describe("region edits", () => {
  const bytes = `a = 1\n${block()}\nb = 2\n`;
  const located = locateRegion(bytes, BLOCK_BEGIN, BLOCK_END);
  if (!located.ok || !located.region) throw new Error("fixture");
  const region = located.region;

  it("extracts the region text without its own line break", () => {
    expect(regionText(bytes, region)).toBe(block());
    expect(
      regionText(`${block()}`, { start: 0, end: block().length, leading: 0 }),
    ).toBe(block());
  });

  it("removes the region with the one break placed before it", () => {
    expect(removeRegion(bytes, region)).toBe("a = 1b = 2\n");
  });

  it("replaces a region in place and inserts with a separator", () => {
    expect(replaceRegion(bytes, region, "NEW")).toBe("a = 1\nNEW\nb = 2\n");
    expect(insertAt("", 0, "R")).toBe("R\n");
    expect(insertAt("a\n", 2, "R")).toBe("a\n\nR\n");
    expect(insertAt("a\nb\n", 2, "R")).toBe("a\n\nR\nb\n");
  });

  it("detects a region nested inside another", () => {
    const outer = { start: 0, end: 100, leading: 0 };
    expect(nestedInside({ start: 10, end: 50, leading: 1 }, outer)).toBe(true);
    expect(nestedInside({ start: 0, end: 50, leading: 0 }, outer)).toBe(false);
    expect(nestedInside({ start: 10, end: 101, leading: 1 }, outer)).toBe(
      false,
    );
  });

  it("keeps selection markers distinct from block markers", () => {
    expect(SELECTION_BEGIN).not.toBe(BLOCK_BEGIN);
    expect(SELECTION_END).not.toBe(BLOCK_END);
  });
});

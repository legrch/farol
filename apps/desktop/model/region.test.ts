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

  it("removes the region without joining the owner lines around it", () => {
    expect(removeRegion(bytes, region)).toBe("a = 1\nb = 2\n");
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

describe("insert then remove round-trips the owner's bytes", () => {
  const body = block();
  const owners = [
    "",
    "a = 1",
    "a = 1\n",
    "a = 1\nb = 2\n",
    "a = 1\nb = 2",
    "a = 1\n\nb = 2\n",
    "a = 1\r\nb = 2\r\n",
    "a = 1\r\nb = 2",
    "\n",
    "\nb = 2\n",
  ];

  function lineStarts(owner: string): number[] {
    const offsets = [0];
    for (let i = 0; i < owner.length; i += 1) {
      if (owner.charAt(i) === "\n") offsets.push(i + 1);
    }
    offsets.push(owner.length);
    return [...new Set(offsets)];
  }

  const cases = owners.flatMap((owner) =>
    lineStarts(owner).map((offset) => ({ owner, offset })),
  );

  it.each(cases)("restores $owner at offset $offset", ({ owner, offset }) => {
    const inserted = insertAt(owner, offset, body);
    const located = locateRegion(inserted, BLOCK_BEGIN, BLOCK_END);
    if (!located.ok || !located.region) throw new Error("not located");
    expect(removeRegion(inserted, located.region)).toBe(owner);
  });

  it("restores an owner file when the offset is the end of an unterminated line", () => {
    for (const owner of ["a = 1\nb = 2\n", "a = 1\n\nb = 2\n"]) {
      const offset = owner.indexOf("\n");
      const inserted = insertAt(owner, offset, body);
      const located = locateRegion(inserted, BLOCK_BEGIN, BLOCK_END);
      if (!located.ok || !located.region) throw new Error("not located");
      expect(removeRegion(inserted, located.region)).toBe(owner);
    }
  });

  it("never joins two owner lines, with or without a blank separator", () => {
    const layouts = [
      "a = 1\n#REGION#\nb = 2\n",
      "a = 1\n\n#REGION#\nb = 2\n",
      "a = 1\n#REGION#\n\nb = 2\n",
      "a = 1\r\n#REGION#\r\nb = 2\r\n",
      "a = 1\r\n\r\n#REGION#\r\nb = 2\r\n",
    ];
    for (const layout of layouts) {
      const bytes = layout.replace("#REGION#", body);
      const located = locateRegion(bytes, BLOCK_BEGIN, BLOCK_END);
      if (!located.ok || !located.region) throw new Error("not located");
      const removed = removeRegion(bytes, located.region);
      expect(removed).toMatch(/^a = 1\r?\n(?:\r?\n)?b = 2\r?\n$/);
      expect(removed).not.toContain("a = 1b");
    }
  });

  it("removes a region with an editor-rewritten CRLF break after text", () => {
    const bytes = `a = 1\r\n${BLOCK_BEGIN}\r\nx = 1\r\n${BLOCK_END}\r\nb = 2\r\n`;
    const located = locateRegion(bytes, BLOCK_BEGIN, BLOCK_END);
    if (!located.ok || !located.region) throw new Error("not located");
    expect(removeRegion(bytes, located.region)).toBe("a = 1\r\nb = 2\r\n");
  });
});

import { describe, expect, it } from "vitest";
import { segmentBytes, split, type Segment } from "./segment.ts";

const run = (id: string, text: string): Segment[] => {
  const out: Segment[] = [];
  split(id, text, (s) => out.push(s));
  return out;
};

describe("browser segment", () => {
  it("emits nothing for empty text", () => {
    expect(run("m1", "")).toEqual([]);
  });

  it("keeps a message within the limit as one segment under its own id", () => {
    expect(run("m1", "hello")).toEqual([{ text: "hello", segmentId: "m1" }]);
    const exact = "a".repeat(segmentBytes);
    expect(run("m1", exact)).toEqual([{ text: exact, segmentId: "m1" }]);
  });

  it("splits an oversized message into numbered parts without losing text", () => {
    const text = "a".repeat(segmentBytes + 5);
    const parts = run("m1", text);
    expect(parts.map((p) => p.segmentId)).toEqual(["m1/part/0", "m1/part/1"]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(Buffer.byteLength(parts[0]!.text)).toBe(segmentBytes);
  });

  it("never cuts a multi-byte character across parts", () => {
    const text = "€".repeat(segmentBytes / 3 + 2);
    const parts = run("m1", text);
    expect(parts).toHaveLength(2);
    for (const p of parts)
      expect(Buffer.byteLength(p.text)).toBeLessThanOrEqual(segmentBytes);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });

  it("refuses an unknown outcome when the part key outgrows the id limit", () => {
    const id = "m".repeat(125);
    const seen: Segment[] = [];
    let error: unknown;
    try {
      split(id, "a".repeat(segmentBytes + 1), (s) => seen.push(s));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      state: "unknown",
      code: "chat_browser_segment_id_limit",
    });
    expect(seen).toEqual([]);
  });
});

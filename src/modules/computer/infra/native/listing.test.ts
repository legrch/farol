import { describe, expect, it } from "vitest";
import { parseTrackedListing } from "./listing";

const OID = "a".repeat(40);
const record = (mode: string, file: string, stage = 0): string =>
  `${mode} ${OID} ${stage}\t${file}\0`;

describe("parseTrackedListing", () => {
  it("treats empty output as no tracked paths", () => {
    expect(parseTrackedListing(Buffer.alloc(0))).toEqual({
      kind: "ok",
      paths: [],
    });
  });

  it("collects paths, keeps an unmerged path once and drops gitlinks", () => {
    const stdout = Buffer.from(
      record("100644", "a.txt") +
        record("100644", "u.txt", 1) +
        record("100644", "u.txt", 2) +
        record("160000", "sub") +
        record("100755", "dir/b sh"),
    );
    expect(parseTrackedListing(stdout)).toEqual({
      kind: "ok",
      paths: ["a.txt", "u.txt", "dir/b sh"],
    });
  });

  it("accepts sha256 object names", () => {
    const stdout = Buffer.from(`100644 ${"b".repeat(64)} 0\tx\0`);
    expect(parseTrackedListing(stdout)).toEqual({ kind: "ok", paths: ["x"] });
  });

  it("flags malformed output", () => {
    for (const text of [
      "100644",
      `100644 ${OID} 0\ta.txt`,
      `bogus\0`,
      `10064 ${OID} 0\ta\0`,
      `100644 ${OID} 4\ta\0`,
    ]) {
      expect(parseTrackedListing(Buffer.from(text)), text).toEqual({
        kind: "malformed",
      });
    }
    expect(parseTrackedListing(Buffer.from([0xff, 0x00]))).toEqual({
      kind: "malformed",
    });
  });

  it("flags a path the route will not carry", () => {
    expect(parseTrackedListing(Buffer.from(record("100644", "a\\b")))).toEqual({
      kind: "unsupported-path",
    });
    expect(parseTrackedListing(Buffer.from(record("100644", "../x")))).toEqual({
      kind: "unsupported-path",
    });
  });
});

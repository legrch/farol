import { describe, expect, it } from "vitest";
import { bindingDigest, sameEntry } from "./slot";

const entry = { dev: 1, ino: 2, uid: 3, mode: 4 };

describe("slot entry", () => {
  it("accepts only the identical entry", () => {
    expect(sameEntry(entry, { ...entry })).toBe(true);
    for (const key of ["dev", "ino", "uid", "mode"] as const)
      expect(sameEntry(entry, { ...entry, [key]: 9 })).toBe(false);
  });

  it("does not equate a number with a bigint", () => {
    expect(sameEntry(entry, { ...entry, dev: 1n })).toBe(false);
  });
});

describe("binding digest", () => {
  it("is the hex sha256 of the bytes", () => {
    expect(bindingDigest(Buffer.from("a"))).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});

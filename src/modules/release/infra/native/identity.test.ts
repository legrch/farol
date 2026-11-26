import type { BigIntStats } from "node:fs";
import { describe, expect, it } from "vitest";
import { retainedHandle, sameOwnedFile, stagedName } from "./identity";

function stats(over: Partial<Record<string, unknown>> = {}): BigIntStats {
  return {
    isFile: () => true,
    nlink: 1n,
    uid: BigInt(process.getuid!()),
    mode: 0o100600n,
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
    ...over,
  } as unknown as BigIntStats;
}

describe("staged file identity", () => {
  it("accepts an unchanged owned private file", () => {
    expect(sameOwnedFile(stats(), stats())).toBe(true);
  });

  it("refuses links, foreign owners, group access and any drift", () => {
    expect(sameOwnedFile(stats({ nlink: 2n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ uid: 99999n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ mode: 0o100640n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ ino: 9n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ size: 9n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ ctimeNs: 9n }), stats())).toBe(false);
    expect(sameOwnedFile(stats({ isFile: () => false }), stats())).toBe(false);
  });

  it("skips the privacy mode check only when asked", () => {
    const open = stats({ mode: 0o100644n });
    expect(sameOwnedFile(open, open)).toBe(false);
    expect(sameOwnedFile(open, open, false)).toBe(true);
  });

  it("checks staged and retained handle names", () => {
    expect(stagedName("/d/" + "a".repeat(36) + ".zip")).toBe(true);
    expect(stagedName("/d/short.zip")).toBe(false);
    const name = "12345678-1234-4234-8234-123456789abc.zip";
    expect(retainedHandle(`/d/${name}`, "/d")).toBe(true);
    expect(retainedHandle(`/e/${name}`, "/d")).toBe(false);
    expect(retainedHandle(`d/${name}`, "d")).toBe(false);
    expect(retainedHandle(`/d/../d/${name}`, "/d")).toBe(false);
    expect(
      retainedHandle("/d/12345678-1234-1234-8234-123456789abc.zip", "/d"),
    ).toBe(false);
  });
});

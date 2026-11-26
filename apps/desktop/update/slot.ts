import { createHash } from "node:crypto";

// Pure comparisons for the slot-binding read: whether a directory entry is the
// one observed before, and whether the bound bytes are the expected ones.

type Entry = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  uid: number | bigint;
  mode: number | bigint;
}>;

export function sameEntry(before: Entry, after: Entry): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.mode === before.mode &&
    after.uid === before.uid
  );
}

export function bindingDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

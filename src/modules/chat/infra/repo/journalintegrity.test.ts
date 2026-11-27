import { describe, expect, it } from "vitest";
import type { HandoffRecord } from "../../app/service/persistent-codex-handoff";
import {
  continuationBindingMatches,
  continuationBroken,
  continuationUnresolved,
  directoryUnsafe,
  dispatchOpen,
  fileChanged,
  fileUnsafe,
  hasDispatchProgress,
  identityChanged,
  inodeChanged,
  intentOrderBroken,
  selectionInventoryInvalid,
  titleReceiptMismatch,
} from "./journalintegrity";

const file = (over: Record<string, unknown> = {}) => ({
  isFile: () => true,
  nlink: 1,
  mode: 0o100600,
  uid: 7,
  size: 10,
  mtimeMs: 1,
  ctimeMs: 2,
  ...over,
});
const dir = (over: Record<string, unknown> = {}) => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  mode: 0o40700,
  uid: 7,
  ...over,
});
const record = (over: Record<string, unknown> = {}) =>
  ({ threadIntent: false, turnIntent: false, ...over }) as HandoffRecord;

describe("journal integrity", () => {
  it("refuses unsafe record files", () => {
    expect(fileUnsafe(file() as never, false, 7)).toBe(false);
    expect(fileUnsafe(file({ isFile: () => false }) as never, false, 7)).toBe(
      true,
    );
    expect(fileUnsafe(file({ nlink: 2 }) as never, false, 7)).toBe(true);
    expect(fileUnsafe(file({ nlink: 2 }) as never, true, 7)).toBe(false);
    expect(fileUnsafe(file({ mode: 0o100644 }) as never, false, 7)).toBe(true);
    expect(fileUnsafe(file() as never, false, 8)).toBe(true);
    expect(fileUnsafe(file({ size: 4097 }) as never, false, 7)).toBe(true);
  });

  it("detects a record that changed while read", () => {
    const base = file() as never;
    expect(fileChanged(base, file() as never, 10)).toBe(false);
    expect(fileChanged(base, file() as never, 9)).toBe(true);
    expect(fileChanged(base, file({ mtimeMs: 3 }) as never, 10)).toBe(true);
    expect(fileChanged(base, file({ ctimeMs: 3 }) as never, 10)).toBe(true);
    expect(fileChanged(base, file({ size: 11 }) as never, 10)).toBe(true);
  });

  it("refuses unsafe directories, skipping the owner test without euid", () => {
    expect(directoryUnsafe(dir() as never, 7)).toBe(false);
    expect(directoryUnsafe(dir({ uid: 1 }) as never, undefined)).toBe(false);
    expect(directoryUnsafe(dir({ uid: 1 }) as never, 7)).toBe(true);
    expect(
      directoryUnsafe(dir({ isSymbolicLink: () => true }) as never, 7),
    ).toBe(true);
    expect(directoryUnsafe(dir({ mode: 0o40755 }) as never, 7)).toBe(true);
  });

  it("compares identities", () => {
    const a = { dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 };
    expect(identityChanged(a, { ...a })).toBe(false);
    expect(identityChanged(a, { ...a, ctimeMs: 5 })).toBe(true);
    expect(inodeChanged(a, { dev: 1, ino: 2 })).toBe(false);
    expect(inodeChanged(a, { dev: 1, ino: 9 })).toBe(true);
  });

  it("gates attempts on an open dispatch only", () => {
    expect(dispatchOpen(null)).toBe(false);
    expect(dispatchOpen(record({ threadIntent: true }))).toBe(false);
    expect(
      dispatchOpen(record({ dispatchProtocol: 1, threadIntent: true })),
    ).toBe(true);
    expect(
      dispatchOpen(
        record({ dispatchProtocol: 1, threadIntent: true, turnIntent: true }),
      ),
    ).toBe(false);
  });

  it("requires intents before the records they cover", () => {
    expect(intentOrderBroken(null, null, null, null)).toBe(false);
    expect(intentOrderBroken("t", {}, null, null)).toBe(false);
    expect(intentOrderBroken(null, {}, null, {})).toBe(true);
    expect(intentOrderBroken("t", null, null, null)).toBe(true);
    expect(intentOrderBroken("t", {}, "u", null)).toBe(true);
  });

  it("binds a verified continuation to the continued turn", () => {
    expect(continuationBroken(null, undefined, null)).toBe(false);
    expect(continuationBroken("u", undefined, "u")).toBe(true);
    expect(continuationBroken("u", "k", null)).toBe(true);
    expect(continuationBroken("u", "k", "v")).toBe(true);
    expect(continuationBroken("u", "k", "u")).toBe(false);
    expect(
      continuationBindingMatches(
        { key: "k", turnId: "t" },
        { key: "k", turnId: "t" },
      ),
    ).toBe(true);
    expect(continuationBindingMatches(null, { key: "k", turnId: "t" })).toBe(
      false,
    );
    expect(continuationBindingMatches([], { key: "k", turnId: "t" })).toBe(
      false,
    );
  });

  it("lists only dispatches with progress and unresolved continuations", () => {
    expect(hasDispatchProgress(1, record())).toBe(false);
    expect(hasDispatchProgress(2, record())).toBe(true);
    expect(hasDispatchProgress(1, record({ turnId: "t" }))).toBe(true);
    const parent = record({ turnId: "t", threadId: "th" });
    const child = record({
      continuationVerified: true,
      continuedFrom: "k",
      threadId: "th",
    });
    expect(continuationUnresolved({ turnId: "t" }, parent, child, "k")).toBe(
      false,
    );
    expect(continuationUnresolved({ turnId: "x" }, parent, child, "k")).toBe(
      true,
    );
    expect(continuationUnresolved({ turnId: "t" }, parent, null, "k")).toBe(
      true,
    );
    expect(continuationUnresolved({ turnId: "t" }, parent, child, "z")).toBe(
      true,
    );
  });

  it("bounds a selection inventory", () => {
    const slots = ["000001.json"];
    expect(selectionInventoryInvalid(slots, ["w"], 2, false)).toBe(false);
    expect(selectionInventoryInvalid(slots, [], 2, false)).toBe(true);
    expect(selectionInventoryInvalid(slots, ["w"], 1025, false)).toBe(true);
    expect(selectionInventoryInvalid(slots, ["w"], 2, true)).toBe(true);
    expect(
      selectionInventoryInvalid(
        new Array(257).fill("s"),
        new Array(257).fill("w"),
        2,
        false,
      ),
    ).toBe(true);
  });

  it("requires a title receipt of exactly three matching fields", () => {
    const intent = { key: "k", digest: "d" };
    expect(
      titleReceiptMismatch({ key: "k", digest: "d", threadId: "t" }, intent),
    ).toBe(false);
    expect(titleReceiptMismatch({ key: "k", digest: "d" }, intent)).toBe(true);
    expect(
      titleReceiptMismatch({ key: "k", digest: "e", threadId: "t" }, intent),
    ).toBe(true);
    expect(
      titleReceiptMismatch(
        { key: "k", digest: "d", threadId: "t", extra: 1 },
        intent,
      ),
    ).toBe(true);
  });
});

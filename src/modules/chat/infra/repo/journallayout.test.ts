import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dispatchDirectory,
  isDispatchRecordFile,
  isPreferenceRootEntry,
  isTemporaryAlias,
  preferenceFile,
  preferenceSelectionDirectory,
  selectionEntryUnexpected,
  selectionPublished,
  selectionSlotName,
  selectionSlots,
  selectionWitnessName,
  selectionWitnesses,
  validKey,
} from "./journallayout";

const REQUEST_ID = "0a1b2c3d-0000-4000-8000-000000000001";

describe("journal layout", () => {
  it("accepts only versioned uuid keys, case-insensitively", () => {
    expect(validKey(REQUEST_ID)).toBe(true);
    expect(validKey(REQUEST_ID.toUpperCase())).toBe(true);
    expect(validKey("0a1b2c3d-0000-9000-8000-000000000001")).toBe(false);
    expect(validKey("../x")).toBe(false);
  });

  it("lowercases directory and preference names", () => {
    expect(dispatchDirectory("/r", REQUEST_ID.toUpperCase())).toBe(
      path.join("/r", REQUEST_ID),
    );
    expect(preferenceFile("/r", REQUEST_ID.toUpperCase())).toBe(
      path.join("/r", `project-preference-${REQUEST_ID}.json`),
    );
  });

  it("derives a stable selection directory from the project digest", () => {
    const first = preferenceSelectionDirectory("/r", { a: 1 });
    expect(first).toMatch(/^\/r\/project-preference-selections-[a-f0-9]{64}$/u);
    expect(preferenceSelectionDirectory("/r", { a: 1 })).toBe(first);
    expect(preferenceSelectionDirectory("/r", { a: 2 })).not.toBe(first);
    expect(isPreferenceRootEntry(path.basename(first))).toBe(true);
  });

  it("recognises the closed dispatch record set", () => {
    for (const name of [
      "reservation.json",
      "title-intent.json",
      "dispatch-attempt-0.json",
      "pre-effect-proof-31.json",
    ])
      expect(isDispatchRecordFile(name)).toBe(true);
    for (const name of [
      "dispatch-attempt-32.json",
      "reservation.json.tmp",
      "other.json",
    ])
      expect(isDispatchRecordFile(name)).toBe(false);
    expect(isPreferenceRootEntry(`project-preference-${REQUEST_ID}.json`)).toBe(
      true,
    );
    expect(isPreferenceRootEntry(REQUEST_ID)).toBe(false);
  });

  it("names and filters selection slots", () => {
    expect(selectionSlotName(7)).toBe("000007.json");
    expect(selectionWitnessName(7)).toBe("witness-000007.json");
    const entries = [
      "witness-000001.json",
      "000002.json",
      "000001.json",
      `000003.json.${REQUEST_ID}.tmp`,
    ];
    expect(selectionSlots(entries)).toEqual(["000001.json", "000002.json"]);
    expect(selectionWitnesses(entries)).toEqual(["witness-000001.json"]);
    expect(selectionPublished(entries)).toEqual([
      "000001.json",
      "000002.json",
      "witness-000001.json",
    ]);
    expect(selectionEntryUnexpected(entries[3]!)).toBe(false);
    expect(selectionEntryUnexpected("junk")).toBe(true);
  });

  it("matches only well-formed temporary aliases of a basename", () => {
    expect(isTemporaryAlias("a.json", `a.json.${REQUEST_ID}.tmp`)).toBe(true);
    expect(isTemporaryAlias("a.json", `b.json.${REQUEST_ID}.tmp`)).toBe(false);
    expect(isTemporaryAlias("a.json", "a.json.nope.tmp")).toBe(false);
  });
});

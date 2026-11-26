import { describe, expect, it } from "vitest";
import {
  isCompletionRecord,
  isKeyedRecord,
  isOperationRecord,
  isPublicationRecord,
  isTaskKey,
} from "./listing";

const key = "a".repeat(64);

describe("directory listing filters", () => {
  it("recognises a task directory by its key alone", () => {
    expect(isTaskKey(key)).toBe(true);
    expect(isTaskKey(`${key}.json`)).toBe(false);
    expect(isTaskKey("a".repeat(63))).toBe(false);
    expect(isTaskKey("A".repeat(64))).toBe(false);
  });

  it("recognises keyed records", () => {
    expect(isKeyedRecord(`${key}.json`)).toBe(true);
    expect(isKeyedRecord(`${key}.json.tmp`)).toBe(false);
    expect(isKeyedRecord(`publication-${key}.json`)).toBe(false);
    expect(isKeyedRecord(`.${key}.json`)).toBe(false);
  });

  it("recognises publication and completion records by prefix", () => {
    expect(isPublicationRecord(`publication-${key}.json`)).toBe(true);
    expect(isPublicationRecord(`completion-${key}.json`)).toBe(false);
    expect(isCompletionRecord(`completion-${key}.json`)).toBe(true);
    expect(isCompletionRecord(`${key}.json`)).toBe(false);
  });

  it("accepts epoch numbers beside keys for operation records", () => {
    expect(isOperationRecord(`${key}.json`)).toBe(true);
    expect(isOperationRecord("12.json")).toBe(true);
    expect(isOperationRecord("x.json")).toBe(false);
    expect(isOperationRecord("12")).toBe(false);
  });
});

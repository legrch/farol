import { describe, expect, it } from "vitest";
import {
  installedEmptyQuitScope,
  installedPreservedQuitScope,
  unacknowledgedDevQuitScope,
} from "./quit";

const run = {
  schema: 1,
  pid: 44374,
  startedAt: "2026-10-08T14:41:58.367Z",
  bootTime: 1790674646000,
  processStart: "Thu Oct  8 15:41:57 2026",
};
const failed = {
  schema: 1,
  at: "2026-10-08T14:42:05.070Z",
  drained: false,
  unconfirmed: ["go-core", "connector"],
};

describe("installed empty Quit scope", () => {
  it("accepts both component orders of a later failed Quit", () => {
    installedEmptyQuitScope(run, failed);
    installedEmptyQuitScope(run, {
      ...failed,
      unconfirmed: ["connector", "go-core"],
    });
  });
  it.each([
    { ...failed, drained: true },
    { ...failed, at: run.startedAt },
    { ...failed, unconfirmed: ["go-core"] },
    { ...failed, unconfirmed: ["go-core", "go-core"] },
    { ...failed, unconfirmed: ["go-core", "chat"] },
    { ...failed, extra: 1 },
    null,
  ])("refuses %j", (quit) => {
    expect(() => installedEmptyQuitScope(run, quit)).toThrow(
      "INSTALLED_EMPTY_RECOVERY_QUIT_CHANGED",
    );
  });
  it("refuses an unreadable run marker", () => {
    expect(() => installedEmptyQuitScope({ ...run, pid: 0 }, failed)).toThrow(
      "INSTALLED_EMPTY_RECOVERY_QUIT_CHANGED",
    );
  });
});

describe("installed preserved Quit scope", () => {
  it.each([
    { unconfirmed: ["go-core"] },
    { unconfirmed: ["go-core", "connector"] },
    { unconfirmed: ["connector", "go-core"] },
  ])("accepts %j", ({ unconfirmed }) => {
    installedPreservedQuitScope(run, { ...failed, unconfirmed });
  });
  it.each([
    { ...failed, drained: true },
    { ...failed, at: "2026-10-08T14:41:00.000Z" },
    { ...failed, unconfirmed: ["connector"] },
    { ...failed, unconfirmed: [] },
    { ...failed, unconfirmed: ["go-core", "go-core"] },
    { ...failed, unconfirmed: ["go-core", "chat"] },
    null,
  ])("refuses %j", (quit) => {
    expect(() => installedPreservedQuitScope(run, quit)).toThrow(
      "INSTALLED_PRESERVED_RECOVERY_QUIT_CHANGED",
    );
  });
});

describe("unacknowledged Dev Quit scope", () => {
  const clean = {
    schema: 1,
    at: "2026-10-08T14:39:05.070Z",
    drained: true,
    unconfirmed: [],
  };
  it("classifies the current failed and the previous clean Quit", () => {
    expect(unacknowledgedDevQuitScope(run, failed)).toBe("current-unconfirmed");
    expect(unacknowledgedDevQuitScope(run, clean)).toBe("previous-confirmed");
  });
  it.each([
    { ...clean, at: run.startedAt },
    { ...clean, unconfirmed: ["connector"] },
    { ...failed, unconfirmed: ["connector", "go-core"] },
    { ...failed, unconfirmed: [] },
    null,
  ])("refuses %j", (quit) => {
    expect(() => unacknowledgedDevQuitScope(run, quit)).toThrow(
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    );
  });
});

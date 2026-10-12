import { describe, expect, it } from "vitest";
import { installedPreservedQuitScope } from "../../src/apps/desktop/closed-empty-chat-recovery";
const run = {
  schema: 1,
  pid: 7,
  startedAt: "2026-10-12T10:00:00.000Z",
  bootTime: null,
  processStart: null,
};
const quit = {
  schema: 1,
  at: "2026-10-12T11:00:00.000Z",
  drained: false,
  unconfirmed: ["go-core"],
};
describe("installed preserved maintenance failed Quit scope", () => {
  it.each([["go-core"], ["go-core", "connector"], ["connector", "go-core"]])(
    "accepts only selected backend failure %j",
    (...unconfirmed) => {
      expect(() =>
        installedPreservedQuitScope(run, { ...quit, unconfirmed }),
      ).not.toThrow();
    },
  );
  it.each([
    [],
    ["connector"],
    ["go-core", "go-core"],
    ["go-core", "unknown"],
    ["go-core", "update"],
  ])("refuses other scopes %j", (...unconfirmed) => {
    expect(() =>
      installedPreservedQuitScope(run, { ...quit, unconfirmed }),
    ).toThrow();
  });
  it("preserves failed history rather than accepting a clean or earlier Quit", () => {
    expect(() =>
      installedPreservedQuitScope(run, { ...quit, drained: true }),
    ).toThrow();
    expect(() =>
      installedPreservedQuitScope(run, { ...quit, at: run.startedAt }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { InstalledUpdateView } from "../../../src/modules/release/contract/installed-update";
import {
  newFailureNotice,
  noticeDecision,
  noticeSeenRecord,
  noticeUnresolved,
} from "./notice";

const schema = "farol.installed-update-notices/1" as const;
const failure = (code: string) =>
  ({ phase: "failed", code, recoveryRequired: false }) as InstalledUpdateView;
const available = (version: string) =>
  ({ phase: "available", version }) as InstalledUpdateView;
const key = `failure:${"a".repeat(24)}`;

describe("noticeUnresolved", () => {
  it("blocks only a failure whose outcome is unknown", () => {
    expect(noticeUnresolved(failure("UPDATE_STAGING_OUTCOME_UNKNOWN"))).toEqual(
      {
        key: "unconfirmed",
        seen: false,
        blockedBy: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      },
    );
    expect(noticeUnresolved(failure("UPDATE_CHECK_FAILED"))).toBeNull();
    expect(noticeUnresolved(available("1.0.0"))).toBeNull();
  });
});

describe("noticeDecision", () => {
  const decide = (
    view: InstalledUpdateView,
    preferences: Parameters<typeof noticeDecision>[0]["preferences"],
    version: string | null = null,
    reusePreviousFailure = false,
  ) => noticeDecision({ view, version, reusePreviousFailure, preferences });

  it("keys an available version and marks it seen when recorded", () => {
    expect(decide(available("1.0.0"), { schema })).toEqual({
      kind: "known",
      outcome: { key: "version:1.0.0", seen: false, blockedBy: null },
    });
    expect(
      decide(available("1.0.0"), { schema, seenVersion: "1.0.0" }),
    ).toEqual({
      kind: "known",
      outcome: { key: "version:1.0.0", seen: true, blockedBy: null },
    });
  });
  it("carries no notice for a view that is neither available nor failed", () => {
    expect(
      decide({ phase: "applying", version: "1" } as never, { schema }),
    ).toEqual({ kind: "not-available" });
  });
  it("reuses a failure only inside one streak on the same code and version", () => {
    const previous = {
      version: "1.0.0",
      code: "UPDATE_CHECK_FAILED",
      key,
      seen: true,
    };
    const preferences = { schema, failureNotice: previous };
    const view = failure("UPDATE_CHECK_FAILED");
    expect(decide(view, preferences, "1.0.0", true)).toEqual({
      kind: "known",
      outcome: { key, seen: true, blockedBy: null },
    });
    expect(decide(view, preferences, null, true).kind).toBe("known");
    expect(decide(view, preferences, "1.0.0", false)).toEqual({
      kind: "failure-new",
    });
    expect(decide(view, preferences, "2.0.0", true)).toEqual({
      kind: "failure-new",
    });
    expect(decide(failure("UPDATE_OTHER"), preferences, "1.0.0", true)).toEqual(
      { kind: "failure-new" },
    );
  });
});

describe("newFailureNotice", () => {
  it("starts unseen", () => {
    expect(newFailureNotice("1.0.0", "UPDATE_CHECK_FAILED", key)).toEqual({
      version: "1.0.0",
      code: "UPDATE_CHECK_FAILED",
      key,
      seen: false,
    });
  });
});

describe("noticeSeenRecord", () => {
  it("records a seen version within the length bound", () => {
    expect(noticeSeenRecord({ schema }, "version:1.0.0")).toEqual({
      schema,
      seenVersion: "1.0.0",
    });
    expect(noticeSeenRecord({ schema }, "version:")).toBeNull();
    expect(
      noticeSeenRecord({ schema }, `version:${"9".repeat(129)}`),
    ).toBeNull();
    expect(
      noticeSeenRecord({ schema }, `version:${"9".repeat(128)}`)?.seenVersion,
    ).toHaveLength(128);
  });
  it("marks only the current failure notice and refuses any other key", () => {
    const failureNotice = {
      version: null,
      code: "UPDATE_CHECK_FAILED",
      key,
      seen: false,
    };
    expect(noticeSeenRecord({ schema, failureNotice }, key)).toEqual({
      schema,
      failureNotice: { ...failureNotice, seen: true },
    });
    expect(
      noticeSeenRecord({ schema, failureNotice }, `failure:${"b".repeat(24)}`),
    ).toBeNull();
    expect(noticeSeenRecord({ schema }, key)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  deferredPreferences,
  discoveryView,
  preferencesUnreadable,
  releaseChannel,
  skippedPreferences,
  stagingUnknown,
  transportUnknown,
} from "./outcome";
import { UpdatePreferences } from "./record";

const schema = "farol.installed-update-preferences/1" as const;
const buildId = "b".repeat(64);
const candidate = { manifest: { version: "1.2.4", buildId } };

describe("closed outcomes", () => {
  it("fences an unknown staging outcome and an unreadable choice", () => {
    expect(stagingUnknown()).toEqual({
      ok: false,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    expect(preferencesUnreadable()).toEqual({
      ok: false,
      code: "UPDATE_PREFERENCES_UNREADABLE",
      recoveryRequired: true,
    });
    expect(stagingUnknown()).not.toBe(stagingUnknown());
  });
  it("maps the stable update channel to stable and the rest to owner-beta", () => {
    expect(releaseChannel("github-stable")).toBe("stable");
    expect(releaseChannel("github-owner-beta")).toBe("owner-beta");
    expect(releaseChannel("local-preview-only")).toBe("owner-beta");
  });
});

describe("transportUnknown", () => {
  it("is true only for a failure that says it is unknown", () => {
    expect(transportUnknown({ ok: false, certainty: "unknown" })).toBe(true);
    expect(transportUnknown({ ok: false, certainty: "known" })).toBe(false);
    expect(transportUnknown({ ok: false })).toBe(false);
    expect(transportUnknown({ ok: true, certainty: "unknown" })).toBe(false);
  });
});

describe("discoveryView", () => {
  it("reports no update for no candidate", () => {
    expect(discoveryView(null, null, { schema, skipped: null })).toEqual({
      ok: true,
      available: false,
    });
  });
  it("reports a candidate with its notes only when it has some", () => {
    const prefs = { schema, skipped: null };
    expect(discoveryView(candidate, null, prefs)).toEqual({
      ok: true,
      available: true,
      version: "1.2.4",
      buildId,
      deferred: false,
    });
    expect(
      discoveryView({ ...candidate, notes: "Fixes" }, null, prefs),
    ).toMatchObject({ notes: "Fixes" });
  });
  it("defers a declined build and a deferred version", () => {
    const prefs = { schema, skipped: null };
    expect(discoveryView(candidate, buildId, prefs)).toMatchObject({
      deferred: true,
    });
    expect(
      discoveryView(candidate, null, { ...prefs, deferredVersion: "1.2.4" }),
    ).toMatchObject({ deferred: true });
  });
});

describe("Skip and Later records", () => {
  it("builds a skip that clears the deferral and parses under the schema", () => {
    const record = skippedPreferences("1.2.4", buildId);
    expect(record).toEqual({
      schema,
      skipped: { version: "1.2.4", buildId },
      deferredVersion: null,
    });
    expect(UpdatePreferences.safeParse(record).success).toBe(true);
  });
  it("builds a deferral that keeps the skip", () => {
    const prefs = {
      schema,
      skipped: { version: "1.2.3", buildId },
      deferredVersion: null,
    };
    expect(deferredPreferences(prefs, "1.2.4")).toEqual({
      ...prefs,
      deferredVersion: "1.2.4",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  automaticChoiceCandidate,
  automaticChoiceView,
  automaticConfirmation,
  automaticScopeRequired,
  automaticUnconfirmedRecord,
  quitChoiceCandidate,
  quitConfirmation,
  quitUnconfirmedRecord,
} from "./choice";
import { AutomaticUpdatePreferences, InstallOnQuitPreferences } from "./record";

const v1 = {
  schema: "farol.installed-automatic-update-preference/1" as const,
  enabled: true,
};
const v2 = {
  schema: "farol.installed-automatic-update-preference/2" as const,
  scope: "download-and-install" as const,
  enabled: true,
};

describe("automaticChoiceView", () => {
  it("forces a legacy record OFF on the stable channel", () => {
    expect(automaticChoiceView(v1, "github-stable")).toEqual({
      status: "confirmed",
      enabled: false,
      scope: "download-and-install",
    });
  });
  it("reports a legacy record as it is on the beta channel", () => {
    expect(automaticChoiceView(v1, "github-owner-beta")).toEqual({
      status: "confirmed",
      enabled: true,
    });
  });
  it("reports the scope of a scoped record on any channel", () => {
    for (const channel of ["github-stable", "github-owner-beta"])
      expect(automaticChoiceView(v2, channel)).toEqual({
        status: "confirmed",
        enabled: true,
        scope: "download-and-install",
      });
  });
});

describe("automaticChoiceCandidate", () => {
  it("picks the schema from the scope and parses under the record schema", () => {
    expect(automaticChoiceCandidate(true, undefined)).toEqual({
      schema: v1.schema,
      enabled: true,
    });
    expect(automaticChoiceCandidate(false, "download-and-install")).toEqual({
      schema: v2.schema,
      enabled: false,
      scope: "download-and-install",
    });
    expect(
      AutomaticUpdatePreferences.safeParse(
        automaticChoiceCandidate(true, "download-and-install"),
      ).success,
    ).toBe(true);
    expect(
      AutomaticUpdatePreferences.safeParse(
        automaticChoiceCandidate(true, undefined),
      ).success,
    ).toBe(true);
  });
});

describe("automaticScopeRequired", () => {
  it("requires a scope on the stable channel or after a scoped record", () => {
    expect(automaticScopeRequired("github-stable", v1, undefined)).toBe(true);
    expect(automaticScopeRequired("github-owner-beta", v2, undefined)).toBe(
      true,
    );
    expect(automaticScopeRequired("github-owner-beta", v1, undefined)).toBe(
      false,
    );
    expect(
      automaticScopeRequired("github-stable", v2, "download-and-install"),
    ).toBe(false);
  });
});

describe("fences and acknowledgements", () => {
  it("builds the automatic fence and acknowledgement with the scope when given", () => {
    expect(automaticUnconfirmedRecord(true, "download-and-install")).toEqual({
      schema: "farol.installed-automatic-update-unconfirmed/1",
      enabled: true,
      scope: "download-and-install",
    });
    expect(automaticUnconfirmedRecord(false, undefined)).toEqual({
      schema: "farol.installed-automatic-update-unconfirmed/1",
      enabled: false,
    });
    expect(automaticConfirmation(true, undefined)).toEqual({
      status: "confirmed",
      enabled: true,
    });
    expect(automaticConfirmation(true, "download-and-install")).toEqual({
      status: "confirmed",
      enabled: true,
      scope: "download-and-install",
    });
  });
  it("builds the install-on-Quit record, fence and acknowledgement", () => {
    expect(
      InstallOnQuitPreferences.safeParse(quitChoiceCandidate(true)).success,
    ).toBe(true);
    expect(quitUnconfirmedRecord(false)).toEqual({
      schema: "farol.installed-install-on-quit-unconfirmed/1",
      enabled: false,
    });
    expect(quitConfirmation(true)).toEqual({
      status: "confirmed",
      scope: "install-on-normal-quit",
      enabled: true,
    });
  });
});

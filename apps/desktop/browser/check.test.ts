import { describe, expect, it } from "vitest";
import type { PhysicalBinding } from "../chatgpt-physical-api.ts";
import {
  fail,
  fixtureOrigin,
  sameOwnedView,
  sameView,
  validBinding,
  validCode,
  validControlLiteral,
  validId,
  validView,
} from "./check.ts";

const partition = "persist:farol-dev-chatgpt" as const;
const view = {
  viewId: "view-1",
  viewGeneration: 1,
  documentGeneration: 2,
  partition,
};
const home = (url = "https://chatgpt.com/"): PhysicalBinding =>
  ({
    ...view,
    url,
    phase: "home",
    conversationId: null,
  }) as PhysicalBinding;
const saved = (url: string, conversationId = "abc"): PhysicalBinding =>
  ({
    ...view,
    url,
    phase: "conversation",
    conversationId,
  }) as PhysicalBinding;

describe("browser check", () => {
  it("refuses with a classified bridge error", () => {
    expect(() => fail("x_code")).toThrow();
    try {
      fail("x_code", "unknown");
    } catch (error) {
      expect(error).toMatchObject({ state: "unknown", code: "x_code" });
    }
  });

  it("accepts only bounded identifiers and codes", () => {
    expect(validId("abc-1:2/3")).toBe(true);
    expect(validId("-abc")).toBe(false);
    expect(validId("a".repeat(129))).toBe(false);
    expect(validId(7)).toBe(false);
    expect(validCode("PHYSICAL_OK")).toBe(true);
    expect(validCode("a/b")).toBe(false);
    expect(validCode("a".repeat(121))).toBe(false);
  });

  it("matches the Go control literal rules without normalizing", () => {
    expect(validControlLiteral("GPT 5")).toBe(true);
    expect(validControlLiteral("")).toBe(false);
    expect(validControlLiteral(" \u0085")).toBe(false);
    expect(validControlLiteral("\ufeff")).toBe(true);
    expect(validControlLiteral("a\u0000")).toBe(false);
    expect(validControlLiteral("\ud800")).toBe(false);
    expect(validControlLiteral("\u00e9".repeat(129))).toBe(false);
    expect(validControlLiteral(3)).toBe(false);
  });

  it("validates views against their partition and positive generations", () => {
    expect(validView(view, partition)).toBe(true);
    expect(validView(view, "persist:farol-app-chatgpt")).toBe(false);
    expect(validView({ ...view, viewGeneration: 0 }, partition)).toBe(false);
    expect(validView({ ...view, documentGeneration: 1.5 }, partition)).toBe(
      false,
    );
    expect(validView({ ...view, viewId: "" }, partition)).toBe(false);
  });

  it("pins the fixture origin to a loopback port", () => {
    expect(fixtureOrigin(undefined)).toBeNull();
    expect(fixtureOrigin(null)).toBeNull();
    expect(fixtureOrigin("http://127.0.0.1:4000")).toBe(
      "http://127.0.0.1:4000",
    );
    for (const bad of [
      "http://127.0.0.1",
      "https://127.0.0.1:4000",
      "http://localhost:4000",
      "http://127.0.0.1:4000/",
      "nonsense",
    ])
      expect(() => fixtureOrigin(bad)).toThrow();
  });

  it("validates production home and conversation bindings", () => {
    expect(validBinding(home(), partition, null)).toBe(true);
    expect(validBinding(home("https://chatgpt.com/x"), partition, null)).toBe(
      false,
    );
    expect(
      validBinding(saved("https://chatgpt.com/c/abc"), partition, null),
    ).toBe(true);
    expect(
      validBinding(saved("https://chatgpt.com/c/other"), partition, null),
    ).toBe(false);
    expect(
      validBinding(saved("https://chatgpt.com/c/abc#x"), partition, null),
    ).toBe(false);
    expect(
      validBinding(saved("https://u:p@chatgpt.com/c/abc"), partition, null),
    ).toBe(false);
    expect(validBinding(home("not a url"), partition, null)).toBe(false);
  });

  it("validates fixture bindings only on the pinned origin", () => {
    const origin = "http://127.0.0.1:4000";
    expect(validBinding(home(`${origin}/chatgpt`), partition, origin)).toBe(
      true,
    );
    expect(validBinding(home("https://chatgpt.com/"), partition, origin)).toBe(
      false,
    );
    expect(
      validBinding(saved(`${origin}/chatgpt/c/abc`), partition, origin),
    ).toBe(true);
    expect(validBinding(saved(`${origin}/c/abc`), partition, origin)).toBe(
      false,
    );
  });

  it("compares views with and without the document generation", () => {
    const next = { ...view, documentGeneration: 9 };
    expect(sameView(view, { ...view })).toBe(true);
    expect(sameView(view, next)).toBe(false);
    expect(sameOwnedView(view, next)).toBe(true);
    expect(sameOwnedView(view, { ...view, viewGeneration: 2 })).toBe(false);
  });
});

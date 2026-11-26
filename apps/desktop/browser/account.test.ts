import { describe, expect, it } from "vitest";
import { account } from "./account.ts";

const url = "https://chatgpt.com/";
const fact = (patch: Record<string, unknown> = {}) => ({
  state: "observed",
  source: "provider-session-v1",
  accountKey: "b".repeat(64),
  observedAtMillis: 1000,
  expiresAtMillis: 9000,
  documentUrl: url,
  ...patch,
});
const refused = (raw: unknown, now = 2000, startedAt = 900) =>
  expect(() => account(raw, url, startedAt, () => now)).toThrow(
    expect.objectContaining({ code: "chat_browser_account_unavailable" }),
  );

describe("browser account", () => {
  it("maps a fresh observed fact to its wire form", () => {
    expect(account(fact(), url, 900, () => 2000)).toEqual({
      state: "observed",
      source: "provider-session-v1",
      principalKey: "b".repeat(64),
      observedAtMillis: "1000",
      expiresAtMillis: "9000",
    });
  });

  it("refuses unobserved, malformed and foreign-document facts", () => {
    refused({ state: "unavailable", code: "timeout" });
    refused(fact({ accountKey: "short" }));
    refused(fact({ extra: 1 }));
    refused(fact({ documentUrl: "https://chatgpt.com/c/other" }));
    refused(null);
  });

  it("refuses a fact older than this verification, from the future, stale or expired", () => {
    refused(fact(), 2000, 1001);
    refused(fact({ observedAtMillis: 3000 }), 2000);
    refused(fact(), 6000);
    refused(fact({ expiresAtMillis: 2000 }), 2000);
  });

  it("reads the clock only after the fact parses", () => {
    let reads = 0;
    expect(() =>
      account({ state: "observed" }, url, 0, () => ++reads),
    ).toThrow();
    expect(reads).toBe(0);
  });
});

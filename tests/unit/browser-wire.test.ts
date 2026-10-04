import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validate,
  requiresOperationID,
} from "../../apps/desktop/bridge/wire.ts";

const source = JSON.parse(
  fs.readFileSync("api/desktop/v1/fixtures/browser-observation.json", "utf8"),
);
// Shared Go/TypeScript boundary fixture; no browser/provider or admission proof.
describe("canonical browser wire", () => {
  it("preserves logical identity and counters beyond JavaScript precision", () => {
    expect(validate("BrowserObserved", source)).toBe(true);
    expect(source.events[0].sequence).toBe("9007199254740993");
    expect(source.events[0].binding.lease.identity.turnGeneration).toBe(
      "18446744073709551615",
    );
    expect(requiresOperationID("chat.browser.reply")).toBe(true);
    expect(requiresOperationID("chat.browser.next")).toBe(false);
  });
  it.each([
    "string-flag",
    "unknown-field",
    "lossy-counter",
    "wrong-kind",
    "wrong-slot",
    "too-many",
    "text-bound",
  ])("refuses %s", (kind) => {
    const value = structuredClone(source);
    if (kind === "string-flag") value.gap = "false";
    if (kind === "unknown-field") value.events[0].binding.authority = true;
    if (kind === "lossy-counter") value.events[0].sequence = 9007199254740993;
    if (kind === "wrong-kind") value.events[0].kind = "eval";
    if (kind === "wrong-slot") value.events[0].binding.lease.slotOrdinal = 0;
    if (kind === "too-many")
      value.events = Array.from({ length: 129 }, () => source.events[0]);
    if (kind === "text-bound") value.events[0].text = "🪔".repeat(16385);
    expect(validate("BrowserObserved", value)).toBe(false);
  });
  it.each([1, 2, 3, 4, 5])("preserves Chat's one-based slot %i", (slot) => {
    const value = structuredClone(source);
    value.events[0].binding.lease.slotOrdinal = slot;
    expect(validate("BrowserObserved", value)).toBe(true);
  });
  it("bounds typed arrays without weakening the old text-array limit", () => {
    expect(
      validate(
        "BrowserObservation[]",
        Array.from({ length: 128 }, () => source.events[0]),
      ),
    ).toBe(true);
    expect(validate("text[]", Array(65).fill("capability"))).toBe(false);
    expect(validate("boolean", 0)).toBe(false);
    expect(validate("boolean", null)).toBe(false);
  });
});

// Same fixture is decoded by Go. A valid wire snapshot is not an approval.
describe("canonical account snapshot wire", () => {
  const account = JSON.parse(
    fs.readFileSync(
      "api/desktop/v1/fixtures/browser-account-observation.json",
      "utf8",
    ),
  );
  it("retains the hashed principal and lossless timestamp strings", () => {
    expect(validate("BrowserAccountObservation", account)).toBe(true);
    expect(account.principalKey).toBe("c".repeat(64));
    expect(account.observedAtMillis).toBe("1000");
  });
  it.each([
    { ...account, accountId: "configured-is-not-observed" },
    { ...account, principalKey: "user@example.invalid" },
    { ...account, source: "configured" },
    { ...account, state: "unknown" },
    { ...account, accessToken: "private-boundary-canary" },
    { ...account, observedAtMillis: 1000 },
    { ...account, expiresAtMillis: "01" },
  ])("refuses unqualified or private fields", (value) => {
    expect(validate("BrowserAccountObservation", value)).toBe(false);
  });
});

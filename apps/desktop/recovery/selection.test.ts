import { describe, expect, it } from "vitest";
import type { EmptyRecoverySelectionInput } from "../bridge/empty-recovery-child";
import {
  assertClosedSelection,
  assertInstalledEmptySelection,
  assertInstalledPreservedSelection,
  assertInterruptedSelection,
  assertUnacknowledgedDevSelection,
  isOperationId,
  isSha256,
} from "./selection";

const quit = "a".repeat(64);
const sel = (extra: object = {}) =>
  ({ Mutations: [], ...extra }) as unknown as EmptyRecoverySelectionInput;

describe("recovery selection admission", () => {
  it("classifies hashes and operation ids", () => {
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
    expect(isOperationId("835a913b-bc20-42c6-bf56-9b83852cde3c")).toBe(true);
    expect(isOperationId("835a913b-bc20-42c6-bf56")).toBe(false);
  });

  it("admits only a plain closed selection", () => {
    assertClosedSelection(sel());
    for (const key of [
      "Interrupted",
      "UnacknowledgedDev",
      "InstalledEmpty",
      "InstalledPreserved",
      "Preserved",
    ])
      expect(() => assertClosedSelection(sel({ [key]: true }))).toThrow(
        "EMPTY_CHAT_RECOVERY_SELECTION_INVALID",
      );
  });

  it("admits interrupted recovery only for a Dev profile and exact quit hash", () => {
    const interrupted = sel({ Interrupted: { OriginalHandoffID: "o" } });
    assertInterruptedSelection(interrupted, quit, "/x/Farol Dev");
    assertInterruptedSelection(interrupted, quit, "/x/Farol DEV");
    for (const [s, q, u] of [
      [sel(), quit, "/x/Farol Dev"],
      [interrupted, "bad", "/x/Farol Dev"],
      [interrupted, quit, "/x/Farol"],
      [{ ...interrupted, Preserved: [] }, quit, "/x/Farol Dev"],
    ] as const)
      expect(() => assertInterruptedSelection(s, q, u)).toThrow(
        "INTERRUPTED_CHAT_RECOVERY_SELECTION_INVALID",
      );
  });

  it("admits unacknowledged Dev only with the explicit flag", () => {
    const s = sel({ UnacknowledgedDev: true });
    assertUnacknowledgedDevSelection(s, quit, "/x/Farol Dev");
    for (const [v, q, u] of [
      [sel(), quit, "/x/Farol Dev"],
      [s, "bad", "/x/Farol Dev"],
      [s, quit, "/x/Farol Dev Review"],
      [sel({ UnacknowledgedDev: true, Interrupted: {} }), quit, "/x/Farol Dev"],
    ] as const)
      expect(() => assertUnacknowledgedDevSelection(v, q, u)).toThrow(
        "UNACKNOWLEDGED_DEV_RECOVERY_SELECTION_INVALID",
      );
  });

  it("admits installed empty only for the installed profile with no mutations", () => {
    const s = sel({ InstalledEmpty: true });
    const id = "/x/io.github.legrch.farol";
    assertInstalledEmptySelection(s, quit, id);
    for (const [v, q, u] of [
      [sel(), quit, id],
      [{ ...s, Mutations: [1] }, quit, id],
      [s, "bad", id],
      [s, quit, "/x/Farol Dev"],
    ] as const)
      expect(() => assertInstalledEmptySelection(v, q, u)).toThrow(
        "INSTALLED_EMPTY_RECOVERY_SELECTION_INVALID",
      );
  });

  it("bounds installed preserved selections to 1..128 entries", () => {
    const id = "/x/io.github.legrch.farol";
    const s = (n: number) =>
      sel({ InstalledPreserved: true, Preserved: Array(n).fill({}) });
    assertInstalledPreservedSelection(s(1), quit, id);
    assertInstalledPreservedSelection(s(128), quit, id);
    for (const [v, q, u] of [
      [s(0), quit, id],
      [s(129), quit, id],
      [sel({ InstalledPreserved: true }), quit, id],
      [s(1), "bad", id],
      [s(1), quit, "/x/Farol Dev"],
      [{ ...s(1), InstalledEmpty: true }, quit, id],
    ] as const)
      expect(() => assertInstalledPreservedSelection(v, q, u)).toThrow(
        "INSTALLED_PRESERVED_RECOVERY_SELECTION_INVALID",
      );
  });
});

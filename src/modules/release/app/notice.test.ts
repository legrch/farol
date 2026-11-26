import { describe, expect, it } from "vitest";
import type { InstalledUpdateView } from "../domain/installed-update";
import {
  noticeAcknowledgeable,
  noticeBearing,
  resolvesFailureNotice,
} from "./notice";

const fresh = { key: "k", seen: false, blockedBy: null };
const available: InstalledUpdateView = {
  phase: "available",
  version: "1.0.0",
  deferred: false,
  notice: fresh,
};

describe("notice predicates", () => {
  it("bears notices on available, ready and failed only", () => {
    expect(noticeBearing(available)).toBe(true);
    expect(noticeBearing({ phase: "checking" })).toBe(false);
  });

  it("resolves a failure only from a settled phase", () => {
    expect(resolvesFailureNotice({ phase: "idle", checkedAt: 1 })).toBe(true);
    expect(resolvesFailureNotice({ phase: "idle", checkedAt: null })).toBe(
      false,
    );
    expect(resolvesFailureNotice({ phase: "checking" })).toBe(false);
  });

  it("acknowledges only a fresh, matching, resolved notice", () => {
    expect(noticeAcknowledgeable(available, "k")).toBe(true);
    expect(noticeAcknowledgeable(available, "other")).toBe(false);
    expect(
      noticeAcknowledgeable(
        { ...available, notice: { ...fresh, seen: true } },
        "k",
      ),
    ).toBe(false);
    expect(
      noticeAcknowledgeable(
        { ...available, notice: { ...fresh, blockedBy: "X" } },
        "k",
      ),
    ).toBe(false);
    expect(
      noticeAcknowledgeable(
        {
          phase: "failed",
          code: "UPDATE_HANDOFF_UNKNOWN",
          recoveryRequired: true,
          notice: fresh,
        },
        "k",
      ),
    ).toBe(false);
    expect(
      noticeAcknowledgeable(
        {
          phase: "failed",
          code: "UPDATE_X",
          recoveryRequired: false,
          notice: fresh,
        },
        "k",
      ),
    ).toBe(true);
  });
});

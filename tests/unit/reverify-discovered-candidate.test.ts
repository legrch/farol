import { describe, expect, it, vi } from "vitest";

import {
  UNTRUSTED_CANDIDATE_DIALOG,
  reverifyDiscoveredCandidate,
  untrustedCandidateDialogDecision,
  type ReverifyDiscoveredCandidateDependencies,
} from "../../src/apps/desktop/reverify-discovered-candidate";
import type { DiscoveryCandidate } from "../../src/apps/desktop/executable-discovery";

const OFFER_CANDIDATE: DiscoveryCandidate = {
  requestedPath: "/opt/homebrew/bin/codex",
  path: "/opt/homebrew/bin/codex",
  source: "homebrew",
  bytes: 42,
  sha256: "a".repeat(64),
  origin: "signed-by-openai",
  verdict: "offer",
};

const NEEDS_CHOICE_CANDIDATE: DiscoveryCandidate = {
  requestedPath: "/opt/homebrew/bin/codex",
  path: "/opt/homebrew/bin/codex",
  source: "homebrew",
  bytes: 42,
  sha256: "b".repeat(64),
  origin: "unknown",
  verdict: "needs-owner-choice",
};

const REFUSED_CANDIDATE: DiscoveryCandidate = {
  requestedPath: "/opt/homebrew/bin/codex",
  path: "/opt/homebrew/bin/codex",
  source: "homebrew",
  origin: "unknown",
  verdict: "refused",
  refusalReason: "world-or-group-writable",
};

function dependencies(
  overrides: Partial<ReverifyDiscoveredCandidateDependencies> = {},
): ReverifyDiscoveredCandidateDependencies {
  return {
    discover: vi.fn(async () => ({ candidates: [], searched: [] })),
    confirm: null,
    ...overrides,
  };
}

describe("reverifyDiscoveredCandidate", () => {
  it("reports stale when the requested path is no longer a live, non-refused candidate", async () => {
    const discover = vi.fn(async () => ({
      candidates: [REFUSED_CANDIDATE],
      searched: [],
    }));
    const confirm = vi.fn();

    await expect(
      reverifyDiscoveredCandidate(
        "codex",
        REFUSED_CANDIDATE.path,
        dependencies({ discover, confirm }),
      ),
    ).resolves.toBe("stale");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns an auto-trusted candidate directly, without ever asking for confirmation", async () => {
    const discover = vi.fn(async () => ({
      candidates: [OFFER_CANDIDATE],
      searched: [],
    }));
    const confirm = vi.fn();

    await expect(
      reverifyDiscoveredCandidate(
        "codex",
        OFFER_CANDIDATE.path,
        dependencies({ discover, confirm }),
      ),
    ).resolves.toEqual(OFFER_CANDIDATE);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("declines an untrusted candidate without prompting when there is no owner-facing window", async () => {
    const discover = vi.fn(async () => ({
      candidates: [NEEDS_CHOICE_CANDIDATE],
      searched: [],
    }));

    await expect(
      reverifyDiscoveredCandidate(
        "codex",
        NEEDS_CHOICE_CANDIDATE.path,
        dependencies({ discover, confirm: null }),
      ),
    ).resolves.toBe("declined");
  });

  it("accepting an untrusted candidate returns the same candidate the existing probe runs against", async () => {
    const discover = vi.fn(async () => ({
      candidates: [NEEDS_CHOICE_CANDIDATE],
      searched: [],
    }));
    const confirm = vi.fn(async () => "confirmed" as const);

    await expect(
      reverifyDiscoveredCandidate(
        "tunnel-client",
        NEEDS_CHOICE_CANDIDATE.path,
        dependencies({ discover, confirm }),
      ),
    ).resolves.toEqual(NEEDS_CHOICE_CANDIDATE);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      kind: "tunnel-client",
      path: NEEDS_CHOICE_CANDIDATE.path,
    });
  });

  it("declines an untrusted candidate when the owner-facing window went away while discovery ran, without ever asking", async () => {
    // The main process resolves `confirm` lazily over its live window. The
    // window exists when re-verification starts and is gone by the time
    // discovery has finished: the confirmation must be read after
    // discovery, and must then find nothing to ask.
    let windowAlive = true;
    const confirm = vi.fn(async () => "confirmed" as const);
    const discover = vi.fn(async () => {
      windowAlive = false;
      return { candidates: [NEEDS_CHOICE_CANDIDATE], searched: [] };
    });
    const lazy: ReverifyDiscoveredCandidateDependencies = {
      discover,
      get confirm() {
        return windowAlive ? confirm : null;
      },
    };

    await expect(
      reverifyDiscoveredCandidate("codex", NEEDS_CHOICE_CANDIDATE.path, lazy),
    ).resolves.toBe("declined");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("declines an untrusted candidate when the confirmation dialog itself cannot be shown", async () => {
    const discover = vi.fn(async () => ({
      candidates: [NEEDS_CHOICE_CANDIDATE],
      searched: [],
    }));
    const confirm = vi.fn(async () => {
      throw new TypeError("Object has been destroyed");
    });

    await expect(
      reverifyDiscoveredCandidate(
        "codex",
        NEEDS_CHOICE_CANDIDATE.path,
        dependencies({ discover, confirm }),
      ),
    ).resolves.toBe("declined");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("declining an untrusted candidate returns the picker's cancellation and leaves the candidate unused", async () => {
    const discover = vi.fn(async () => ({
      candidates: [NEEDS_CHOICE_CANDIDATE],
      searched: [],
    }));
    const confirm = vi.fn(async () => "cancelled" as const);

    await expect(
      reverifyDiscoveredCandidate(
        "codex",
        NEEDS_CHOICE_CANDIDATE.path,
        dependencies({ discover, confirm }),
      ),
    ).resolves.toBe("declined");
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      kind: "codex",
      path: NEEDS_CHOICE_CANDIDATE.path,
    });
  });
});

describe("untrustedCandidateDialogDecision", () => {
  it("confirms only an explicit press of the confirm button", () => {
    expect(
      untrustedCandidateDialogDecision(UNTRUSTED_CANDIDATE_DIALOG.confirmId),
    ).toBe("confirmed");
    expect(untrustedCandidateDialogDecision(1)).toBe("confirmed");
  });

  it.each([
    ["the cancel button", UNTRUSTED_CANDIDATE_DIALOG.cancelId],
    ["the default button", UNTRUSTED_CANDIDATE_DIALOG.defaultId],
    ["an index below the buttons", -1],
    ["an index past the buttons", 2],
    ["a non-integer response", 1.5],
    ["a non-numeric response", Number.NaN],
  ])("cancels on %s", (_label, response) => {
    expect(untrustedCandidateDialogDecision(response)).toBe("cancelled");
  });

  it("keeps Cancel as both the default and the cancel button, so a dismissed dialog never confirms", () => {
    const { buttons, defaultId, cancelId, confirmId } =
      UNTRUSTED_CANDIDATE_DIALOG;
    expect(buttons[cancelId]).toBe("Cancel");
    expect(buttons[confirmId]).toBe("Use this file");
    expect(defaultId).toBe(cancelId);
    expect(confirmId).not.toBe(cancelId);
    expect(buttons).toHaveLength(2);
  });
});

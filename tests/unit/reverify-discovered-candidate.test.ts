import { describe, expect, it, vi } from "vitest";

import {
  reverifyDiscoveredCandidate,
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

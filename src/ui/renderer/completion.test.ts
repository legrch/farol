import { describe, expect, it } from "vitest";
import { initial } from "../../../apps/desktop/renderer/snapshot";
import type { WindowSnapshot } from "./contract";
import { setupCompletionKey, setupCompletionProof } from "./completion";

describe("setupCompletionKey", () => {
  it("never completes without ready settings or after disposal", () => {
    expect(setupCompletionKey({ ...initial }, false)).toBeNull();
    const notReady = {
      ...initial,
      configuration: { status: "stale" },
    } as unknown as WindowSnapshot;
    expect(setupCompletionKey(notReady, false)).toBeNull();
    expect(setupCompletionKey(notReady, true)).toBeNull();
  });
});

describe("setupCompletionProof", () => {
  it("names the observed document and sequence, or nothing", () => {
    expect(setupCompletionProof({ ...initial })).toBeNull();
    const observed = {
      ...initial,
      signInObservation: { binding: { documentGeneration: 4, sequence: 9 } },
    } as unknown as WindowSnapshot;
    expect(setupCompletionProof(observed)).toBe("4:9");
  });
});

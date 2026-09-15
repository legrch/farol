import { describe, expect, it } from "vitest";
import {
  admitWork,
  createReleaseState,
  prepareUpdate,
  releaseWork,
  switchGeneration,
  verifyGeneration,
} from "../../src/modules/release/domain/generation";

describe("release generation policy", () => {
  it("does not apply an update while accepted work remains", () => {
    const admitted = admitWork(createReleaseState("generation-a"), "work-a");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const prepared = prepareUpdate(admitted.value, "generation-b");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(switchGeneration(prepared.value)).toMatchObject({
      ok: false,
      error: { code: "RELEASE_DRAIN_REQUIRED" },
    });
  });

  it("switches only after exact work release and rolls back failed verification", () => {
    const admitted = admitWork(createReleaseState("generation-a"), "work-a");
    if (!admitted.ok) throw new Error("admission failed");
    const prepared = prepareUpdate(admitted.value, "generation-b");
    if (!prepared.ok) throw new Error("prepare failed");
    const drained = releaseWork(prepared.value, "work-a");
    if (!drained.ok) throw new Error("release failed");
    const switched = switchGeneration(drained.value);
    expect(switched).toMatchObject({ ok: true, value: { phase: "verifying" } });
    if (!switched.ok) return;
    expect(verifyGeneration(switched.value, false)).toMatchObject({
      ok: true,
      value: {
        phase: "open",
        activeGeneration: "generation-a",
        lastOutcome: "rolled_back",
      },
    });
  });

  it("refuses a foreign or duplicate work release", () => {
    const admitted = admitWork(createReleaseState("generation-a"), "work-a");
    if (!admitted.ok) throw new Error("admission failed");
    expect(releaseWork(admitted.value, "work-b")).toMatchObject({
      ok: false,
      error: { code: "RELEASE_UNKNOWN_WORK" },
    });
    const released = releaseWork(admitted.value, "work-a");
    if (!released.ok) throw new Error("release failed");
    expect(releaseWork(released.value, "work-a")).toMatchObject({
      ok: false,
      error: { code: "RELEASE_UNKNOWN_WORK" },
    });
  });
});

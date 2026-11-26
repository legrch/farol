import { describe, expect, it } from "vitest";
import { candidateChanged, localCandidateRepeats } from "./candidate";

const base = {
  handle: "h1",
  manifest: {
    version: "1.0.0",
    buildId: "b1",
    archiveSha256: "a1",
    artifactSha256: "t1",
  },
};

describe("candidate identity", () => {
  it("detects a staged archive that is not the discovered candidate", () => {
    expect(candidateChanged(base, { version: "1.0.0", buildId: "b1" })).toBe(
      false,
    );
    expect(candidateChanged(base, { version: "1.0.1", buildId: "b1" })).toBe(
      true,
    );
    expect(candidateChanged(base, { version: "1.0.0", buildId: "b2" })).toBe(
      true,
    );
  });

  it("treats any shared identity as a repeated local import", () => {
    const other = {
      handle: "h2",
      manifest: {
        version: "1.0.1",
        buildId: "b2",
        archiveSha256: "a2",
        artifactSha256: "t2",
      },
    };
    expect(localCandidateRepeats(other, base)).toBe(false);
    expect(localCandidateRepeats({ ...other, handle: "h1" }, base)).toBe(true);
    expect(
      localCandidateRepeats(
        { ...other, manifest: { ...other.manifest, buildId: "b1" } },
        base,
      ),
    ).toBe(true);
    expect(
      localCandidateRepeats(
        { ...other, manifest: { ...other.manifest, archiveSha256: "a1" } },
        base,
      ),
    ).toBe(true);
    expect(
      localCandidateRepeats(
        { ...other, manifest: { ...other.manifest, artifactSha256: "t1" } },
        base,
      ),
    ).toBe(true);
  });
});

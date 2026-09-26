import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { runPromotionApply } from "../../tooling/promotion-apply.mjs";
import { assertPromotionDestination } from "../../tooling/promotion-destination.mjs";
import { latestPredecessorDirectory } from "../e2e/predecessor-package-path.mjs";

// Q-07/Q-08 with two really identified local builds: the sealed predecessor
// kept under _output/evidence/predecessors (or the historical
// artifacts/predecessors) and the current sealed package. Both are
// hundreds of megabytes and git-ignored, so this runs only when asked for
// and both exist; it is then recorded as its own attempt.
//
// This is placement-level evidence: it drives `runPromotionApply` directly
// and proves copy, no-overwrite and receipt behaviour between two identified
// generations. It does not run the ordinary verifier or the launch and
// promotion admission gates, and the current verifier qualifies only the
// runtime pinned in `tooling/runtime-contract.mjs`, so a preserved older
// generation is restored as bytes, not re-qualified by the newer tooling.
const nextRoot = path.resolve(import.meta.dirname, "../..");
const enabled = process.env.FAROL_NEXT_TWO_GENERATION === "1";
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function generation(directory) {
  const artifact = JSON.parse(
    await fs.readFile(path.join(directory, "artifact.json"), "utf8"),
  );
  return {
    app: path.join(directory, "Farol Next Preview.app"),
    artifactSha256: artifact.artifactSha256,
    buildId: artifact.buildId,
    sourceCommit: artifact.sourceCommit,
  };
}

describe("Q-07/Q-08 two identified generations", () => {
  it.skipIf(!enabled)(
    "promotes A, refuses B over A leaving A intact, promotes B after the owner removes A, and restores A again from the untouched predecessor",
    async () => {
      const predecessor = await latestPredecessorDirectory(nextRoot);
      expect(
        predecessor,
        "a sealed predecessor under _output/evidence/predecessors or historical artifacts/predecessors",
      ).not.toBeNull();
      const current = path.join(nextRoot, "_output", "package");
      const a = await generation(predecessor);
      const b = await generation(current);
      expect(a.artifactSha256).not.toBe(b.artifactSha256);
      expect(a.buildId).not.toBe(b.buildId);
      const predecessorDigestBefore = await treeDigest(a.app);
      expect(predecessorDigestBefore).toBe(a.artifactSha256);

      const temporary = await fs.realpath(os.tmpdir());
      const root = await fs.mkdtemp(
        path.join(temporary, "farol-two-generation-"),
      );
      roots.push(root);
      const home = path.join(root, "home");
      await fs.mkdir(path.join(home, "Applications"), {
        recursive: true,
        mode: 0o755,
      });
      await fs.chmod(home, 0o700);
      const { destination, receipt } = assertPromotionDestination({
        home,
        source: a.app,
        destination: path.join(home, "Applications/Farol Next Preview.app"),
      });
      const promote = (generation_) =>
        runPromotionApply({
          home,
          source: generation_.app,
          artifactSha256: generation_.artifactSha256,
          receiptText: `${JSON.stringify({
            operation: "applied",
            buildId: generation_.buildId,
            artifactSha256: generation_.artifactSha256,
          })}\n`,
        });

      // A is placed and verified as itself.
      await promote(a);
      expect(await treeDigest(destination)).toBe(a.artifactSha256);
      expect(JSON.parse(await fs.readFile(receipt, "utf8")).buildId).toBe(
        a.buildId,
      );

      // B cannot replace a placed generation: the update is refused and A's
      // bytes and receipt are untouched.
      await expect(promote(b)).rejects.toThrow(/^PROMOTION_APPLY_REFUSED/u);
      expect(await treeDigest(destination)).toBe(a.artifactSha256);
      expect(JSON.parse(await fs.readFile(receipt, "utf8")).buildId).toBe(
        a.buildId,
      );

      // The owner removes A; B is placed and verified as itself.
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rm(receipt, { force: true });
      await promote(b);
      expect(await treeDigest(destination)).toBe(b.artifactSha256);
      expect(JSON.parse(await fs.readFile(receipt, "utf8")).buildId).toBe(
        b.buildId,
      );

      // Rollback: B is removed and A is placed again from the predecessor,
      // whose bytes the whole sequence left exactly as they were.
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rm(receipt, { force: true });
      await promote(a);
      expect(await treeDigest(destination)).toBe(a.artifactSha256);
      expect(await treeDigest(a.app)).toBe(predecessorDigestBefore);
      expect(await treeDigest(b.app)).toBe(b.artifactSha256);
    },
    600_000,
  );

  it.skipIf(enabled)(
    "is recorded as not run unless FAROL_NEXT_TWO_GENERATION=1 selects it",
    () => {
      expect(enabled).toBe(false);
    },
  );
});

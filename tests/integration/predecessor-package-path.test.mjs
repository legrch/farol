import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestPredecessorDirectory,
  predecessorPackagePaths,
} from "../e2e/predecessor-package-path.mjs";

const root = "/tmp/farol-predecessor";
const created = [];

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

describe("predecessor package path", () => {
  it.each(["dist/package", "_output/package"])(
    "accepts the %s layout only for a predecessor's own pinned verifier",
    (layout) => {
      const packageRoot = path.join(root, layout);
      expect(
        predecessorPackagePaths(
          path.join(packageRoot, "artifact.json"),
          path.join(packageRoot, "Farol Next Preview.app"),
        ),
      ).toEqual({ checkoutRoot: root, packageRoot });
    },
  );

  it("refuses a foreign layout or manifest", () => {
    const packageRoot = path.join(root, "dist/package");
    expect(() =>
      predecessorPackagePaths(
        path.join(packageRoot, "artifact.json"),
        path.join(root, "elsewhere/Farol Next Preview.app"),
      ),
    ).toThrow("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
    expect(() =>
      predecessorPackagePaths(
        path.join(root, "elsewhere/artifact.json"),
        path.join(packageRoot, "Farol Next Preview.app"),
      ),
    ).toThrow("E2E_PREDECESSOR_MANIFEST_NOT_CANONICAL");
  });

  it("keeps an older predecessor discoverable after new evidence moves to _output", async () => {
    const checkout = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-predecessor-"),
    );
    created.push(checkout);
    const older = path.join(checkout, "artifacts/predecessors/older");
    const newer = path.join(checkout, "_output/evidence/predecessors/newer");
    await Promise.all([
      fs.mkdir(older, { recursive: true }),
      fs.mkdir(newer, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(older, "artifact.json"),
        JSON.stringify({ schema: 5, builtAt: "2026-09-20T00:00:00Z" }),
      ),
      fs.writeFile(
        path.join(newer, "artifact.json"),
        JSON.stringify({ schema: 5, builtAt: "2026-09-19T00:00:00Z" }),
      ),
    ]);
    expect(await latestPredecessorDirectory(checkout)).toBe(older);
  });
});

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vnextRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("promotion while review findings are open", () => {
  it("refuses to place anything and names the open findings", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(vnextRoot, "tooling/promote-preview.mjs"), "--apply"],
      { cwd: vnextRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:F3-3,F3-4",
    );
  });
});

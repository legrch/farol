import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("quit drain process lifetime", () => {
  it("keeps the process alive through its deadline and reaches the real quit", async () => {
    const fixture = path.resolve(
      "tests/integration/fixtures/quit-drain-exit-child.mjs",
    );
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-quit-drain-exit-"),
    );
    const bundled = path.join(temporary, "fixture.mjs");
    try {
      await build({
        entryPoints: [fixture],
        outfile: bundled,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
      });
      const { stdout } = await run(process.execPath, [bundled]);

      expect(stdout).toContain(
        'RECEIPT {"drained":false,"unconfirmed":["stalled-child"]}',
      );
      expect(stdout).toContain("QUIT\n");
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});

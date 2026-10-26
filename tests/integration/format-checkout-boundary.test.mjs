import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");

it("prunes independent worktrees before formatting traverses their directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-format-scope-"));
  const foreign = path.join(root, ".claude/worktrees");
  try {
    await fs.mkdir(foreign, { recursive: true });
    await fs.copyFile(
      path.join(repo, ".prettierignore"),
      path.join(root, ".prettierignore"),
    );
    await fs.writeFile(path.join(root, "owned.json"), '{ "owned": true }\n');
    // This entire tree is disposable and belongs to the test. Its inaccessible
    // directory distinguishes traversal pruning from ignoring matched files.
    await fs.chmod(foreign, 0o000);
    const manifest = JSON.parse(
      await fs.readFile(path.join(repo, "package.json"), "utf8"),
    );
    for (const key of ["format", "format:check"]) {
      const args = manifest.scripts[key].split(" ");
      expect(args.shift()).toBe("prettier");
      const result = await run(
        process.execPath,
        [path.join(repo, "node_modules/prettier/bin/prettier.cjs"), ...args],
        { cwd: root, timeout: 10000, maxBuffer: 16384 },
      );
      expect(result.stderr).not.toContain("EACCES");
    }
    // Control: .prettierignore alone must not satisfy traversal isolation.
    // The exact CLI without its negative glob reaches our unreadable directory.
    await expect(
      run(
        process.execPath,
        [
          path.join(repo, "node_modules/prettier/bin/prettier.cjs"),
          "--check",
          ".",
        ],
        { cwd: root, timeout: 10000, maxBuffer: 16384 },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("EACCES"),
    });
  } finally {
    await fs.chmod(foreign, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});

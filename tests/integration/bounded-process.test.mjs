import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedProcess } from "../e2e/bounded-process.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("bounded E2E child process", () => {
  it("bounds inherited pipes and terminates its isolated process group", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-bounded-child-"),
    );
    roots.push(root);
    const pidFile = path.join(root, "descendant.pid");
    const startedAt = Date.now();
    await expect(
      runBoundedProcess(
        process.execPath,
        [
          path.join(import.meta.dirname, "../e2e/inherited-pipe.fixture.cjs"),
          pidFile,
        ],
        {
          cwd: root,
          env: process.env,
          timeoutMs: 1_000,
          terminationGraceMs: 250,
        },
      ),
    ).rejects.toThrow("E2E_CHILD_TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const descendant = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(descendant, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(alive).toBe(false);
  });
});

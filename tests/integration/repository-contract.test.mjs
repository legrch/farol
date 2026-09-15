import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const vnextRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = path.resolve(vnextRoot, "..");

function git(...arguments_) {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
  }).trim();
}

describe("portable Farol Next repository contract", () => {
  it("tracks the nested instructions instead of relying on writer-local bytes", async () => {
    expect(git("ls-files", "--error-unmatch", "vnext/AGENTS.md")).toBe(
      "vnext/AGENTS.md",
    );
    const ignored = spawnSync(
      "git",
      ["-C", repositoryRoot, "check-ignore", "-q", "vnext/AGENTS.md"],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    expect(ignored.status).toBe(1);

    const nested = await fs.readFile(path.join(vnextRoot, "AGENTS.md"), "utf8");
    const root = await fs.readFile(
      path.join(repositoryRoot, "AGENTS.md"),
      "utf8",
    );
    expect(nested).toContain("These rules apply only under `vnext/`");
    expect(root).toContain("`vnext/**`");
    expect(root).toContain("Legacy product payload");
  });

  it("offers one verified packaged launch without hiding the development lane", async () => {
    const taskfile = await fs.readFile(
      path.join(repositoryRoot, "Taskfile.yml"),
      "utf8",
    );
    const readme = await fs.readFile(path.join(vnextRoot, "README.md"), "utf8");
    expect(taskfile).toMatch(/^  next:run:$/mu);
    expect(taskfile).toMatch(/^  next:preview:$/mu);
    expect(readme).toContain("task next:run");
    expect(readme).toContain("verified packaged candidate");
  });
});

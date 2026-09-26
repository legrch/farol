import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const vnextRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = vnextRoot;

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
  it("tracks self-contained instructions instead of relying on sibling repositories", async () => {
    expect(git("ls-files", "--error-unmatch", "AGENTS.md")).toBe("AGENTS.md");
    const ignored = spawnSync(
      "git",
      ["-C", repositoryRoot, "check-ignore", "-q", "AGENTS.md"],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
        },
      },
    );
    expect(ignored.status).toBe(1);

    const nested = await fs.readFile(path.join(vnextRoot, "AGENTS.md"), "utf8");
    const root = await fs.readFile(
      path.join(repositoryRoot, "AGENTS.md"),
      "utf8",
    );
    expect(nested).toContain("standalone Farol repository");
    expect(root).toContain("provider = farol");
    expect(root).toContain("model = chatgpt");
  });

  it("offers one verified packaged launch without hiding the development lane", async () => {
    const taskfile = await fs.readFile(
      path.join(repositoryRoot, "Taskfile.yml"),
      "utf8",
    );
    const readme = await fs.readFile(path.join(vnextRoot, "README.md"), "utf8");
    const packageDocument = JSON.parse(
      await fs.readFile(path.join(vnextRoot, "package.json"), "utf8"),
    );
    expect(taskfile).toMatch(/^  run:$/mu);
    expect(taskfile).toMatch(/^  preview:$/mu);
    expect(taskfile).not.toContain("launch an already verified .app directly");
    expect(taskfile).toContain("/usr/bin/env -i");
    expect(taskfile).toContain("FAROL_NEXT_OWNER_LAUNCH=1");
    expect(taskfile).toContain('PATH="$clean_path"');
    expect(packageDocument.scripts.run).toBeUndefined();
    expect(readme).toContain("task run");
    expect(readme).toContain("verified packaged candidate");
    expect(readme).toContain("isolated launch snapshot");
    expect(readme).not.toContain(
      "./dist/package/Farol\\ Next\\ Preview.app/Contents/MacOS/Farol\\ Next\\ Preview",
    );
  });

  it("pins the reviewed supported Electron runtime", async () => {
    const packageDocument = JSON.parse(
      await fs.readFile(path.join(vnextRoot, "package.json"), "utf8"),
    );
    const dependencyDocument = await fs.readFile(
      path.join(vnextRoot, "docs/dependencies.md"),
      "utf8",
    );

    expect(packageDocument.dependencies.electron).toBe("44.4.2");
    expect(dependencyDocument).toMatch(
      /\| Electron\s+\| runtime closure \|\s+44\.4\.2\s+\|/u,
    );
  });
});

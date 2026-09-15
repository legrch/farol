import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceIdentity } from "../../tooling/source-identity.mjs";

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

describe("source identity", () => {
  it("binds the committed tree and ignores task-local filesystem noise", async () => {
    const repository = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-source-identity-"),
    );
    try {
      await fs.mkdir(path.join(repository, "vnext"));
      await fs.writeFile(
        path.join(repository, "vnext/.gitignore"),
        ".DS_Store\nAGENTS.md\n",
      );
      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export {};\n",
      );
      git(repository, "init", "-q");
      git(repository, "add", "vnext");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "initial",
      );

      const initial = sourceIdentity(repository, "vnext");
      await fs.writeFile(path.join(repository, "vnext/.DS_Store"), "host-a");
      await fs.writeFile(
        path.join(repository, "vnext/AGENTS.md"),
        "task-local",
      );
      const withIgnoredNoise = sourceIdentity(repository, "vnext");

      expect(withIgnoredNoise).toEqual(initial);
      expect(initial.dirty).toBe(false);

      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export const changed = true;\n",
      );
      expect(sourceIdentity(repository, "vnext")).toMatchObject({
        commit: initial.commit,
        treeDigest: initial.treeDigest,
        dirty: true,
      });

      git(repository, "add", "vnext/main.ts");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "change",
      );
      const changed = sourceIdentity(repository, "vnext");
      expect(changed.dirty).toBe(false);
      expect(changed.commit).not.toBe(initial.commit);
      expect(changed.treeDigest).not.toBe(initial.treeDigest);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });
});

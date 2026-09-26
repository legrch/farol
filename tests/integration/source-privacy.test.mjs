import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("standalone source privacy gate", () => {
  let repository;
  let environment;

  beforeAll(async () => {
    repository = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-source-privacy-"),
    );
    await fs.mkdir(path.join(repository, "scripts"));
    await fs.mkdir(path.join(repository, "bin"));
    await fs.copyFile(
      new URL("../../scripts/scan-working-tree.py", import.meta.url),
      path.join(repository, "scripts/scan-working-tree.py"),
    );
    // The fixture exercises path admission before content scanning. No real
    // secrets or installed scanner are needed for these boundary assertions.
    await fs.writeFile(
      path.join(repository, "bin/gitleaks"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    environment = { ...process.env, PATH: `${repository}/bin:/usr/bin:/bin` };
    expect(
      spawnSync("git", ["init", "-q", repository], { env: environment }).status,
    ).toBe(0);
  });

  afterAll(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  async function scan(relative) {
    const file = path.join(repository, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "Synthetic fixture with no secret content.\n");
    try {
      return spawnSync(
        "/usr/bin/python3",
        ["-I", path.join(repository, "scripts/scan-working-tree.py")],
        {
          encoding: "utf8",
          env: environment,
        },
      );
    } finally {
      await fs.rm(file);
    }
  }

  it.each([
    "transcript.txt",
    "transcript.md",
    "transcripts.jsonl",
    "transcripts/private.txt",
    "cookies",
    "cookies.txt",
    "cookie.json",
    "cookies/state.bin",
    ".credentials.json",
    "credentials",
    "credential.txt",
    "nested/.credentials.json",
    "auth-state.json",
    ".auth-state",
    "session-token.txt",
    "browser-profile/state.txt",
    ".env",
    ".env.local",
    "nested/id_ed25519",
    "nested/key.pem",
    "transcript.txt.bak",
    "cookies.json.backup",
    "credentials.yaml",
    "transcripts.csv",
  ])(
    "rejects private export path %s before content scanning",
    async (relative) => {
      const result = await scan(relative);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Private source path refused: ${relative}`,
      );
    },
  );

  it.each([
    "credential-policy.ts",
    "transcript.test.ts",
    "cookie-policy.ts",
    "auth-state.test.ts",
    "session-token.ts",
    "browser-profile.ts",
    "docs/credential-policy.md",
    "README.md",
  ])("admits ordinary source path %s", async (relative) => {
    expect((await scan(relative)).status).toBe(0);
  });
});

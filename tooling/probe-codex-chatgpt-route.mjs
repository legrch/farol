import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-route-b-probe-"),
);
const output = path.join(scratch, "probe.mjs");

try {
  await build({
    entryPoints: [
      path.join(root, "tooling/probe-codex-chatgpt-route-entry.ts"),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "warning",
  });
  const result = spawnSync(
    process.execPath,
    [output, ...process.argv.slice(2)],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? os.homedir(),
        TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: "inherit",
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

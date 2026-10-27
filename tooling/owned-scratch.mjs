// Owner record for scratch under _output. output-retention.mjs removes a
// directory carrying it only once this process, its process group and every
// reference to the path are gone, so a killed producer is still cleaned up.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const OWNER_FILE = ".owner";

// One fixed environment for every `ps lstart` read, writer and observer
// alike: the start time is compared as text, so locale and zone must match.
export const PS_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
});

export async function writeOwner(directory) {
  const ps = spawnSync(
    "/bin/ps",
    ["-o", "pgid=,lstart=", "-p", String(process.pid)],
    { encoding: "utf8", timeout: 5_000, env: PS_ENVIRONMENT },
  );
  const match = /^\s*(\d+)\s+(.{24})/u.exec(ps.stdout ?? "");
  // Without a verifiable owner the directory stays "unknown": kept, reported.
  if (!match) return;
  await fs.writeFile(
    path.join(directory, OWNER_FILE),
    JSON.stringify({
      schema: 1,
      pid: process.pid,
      pgid: Number(match[1]),
      start: match[2].trim(),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

// Bootstrap only the VM tasks under an already installed declared Node runtime.
// Keep this file free of TypeScript imports so an older shell Node can enter it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function chooseRuntime(
  currentVersion,
  currentExecutable,
  versions,
  home,
  probe,
) {
  if (versions.includes(currentVersion)) return currentExecutable;
  const candidates = versions.flatMap((version) => [
    path.join(home, ".nvm/versions/node/v" + version, "bin/node"),
    "/opt/homebrew/Cellar/node/" + version + "/bin/node",
  ]);
  for (const candidate of candidates) {
    if (versions.includes(probe(candidate))) return candidate;
  }
  throw Error(
    "DECLARED_NODE_RUNTIME_MISSING: install a Node version from package.json engines; no toolchain is installed automatically",
  );
}

// Guard the CLI entry so importing this module (for example to reuse
// chooseRuntime) works in host contexts without argv[1].
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref !== null && import.meta.url === entryHref) {
  const mode = process.argv[2];
  if (!["smoke", "machine", "dev"].includes(mode))
    throw Error("VM_ENTRY_MODE_INVALID");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const versions = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
    .engines.node.split("||")
    .map((x) => x.trim());
  if (!versions.every((x) => /^\d+\.\d+\.\d+$/.test(x)))
    throw Error("DECLARED_NODE_VERSIONS_INVALID");
  const env = Object.fromEntries(
    ["HOME", "USER", "TMPDIR", "PATH", "FAROL_VM_CONFIG"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const executable = chooseRuntime(
    process.versions.node,
    process.execPath,
    versions,
    os.homedir(),
    (binary) => {
      const result = spawnSync(binary, ["--version"], {
        encoding: "utf8",
        env,
        timeout: 3000,
      });
      return result.status === 0
        ? result.stdout.trim().replace(/^v/, "")
        : null;
    },
  );
  const result = spawnSync(
    executable,
    [
      path.join(
        root,
        "tooling/vm-" + mode + ".mjs",
      ),
      ...process.argv.slice(3),
    ],
    { env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

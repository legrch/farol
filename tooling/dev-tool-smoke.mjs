// Headless exact-Dev witness. Owns disposable test state, never a saved profile,
// authentication, live tunnel or provider. Existing Dev output guards apply.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readPreparedDevCore } from "./dev-core-resources.mjs";
import {
  candidateToolchainDirectories,
  currentNpmVersion,
  probeToolchainAt,
  resolveToolchain,
} from "./dev.mjs";

export function devToolSmokePlan(root, image) {
  const pins = [
    "--candidate-root",
    path.join(root, "_output/dev-core/Contents/Resources/app"),
    "--source-sha",
    image.sourceCommit,
    "--build-id",
    image.buildId,
  ];
  return [
    ["tests/e2e/go-computer-mcp.e2e.mjs", "--check", "--dev-shell", ...pins],
    [
      "tests/e2e/go-computer-mcp.e2e.mjs",
      "--run-native",
      "--dev-shell",
      ...pins,
    ],
  ];
}
async function main() {
  if (process.argv.length !== 2)
    throw Error("DEV_TOOL_SMOKE_ARGUMENTS_INVALID");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const toolchain = resolveToolchain({
    currentNode: process.versions.node,
    currentNpm: currentNpmVersion(),
    candidates: candidateToolchainDirectories(process.env.HOME),
    probe: probeToolchainAt,
  });
  if (toolchain.status !== "current" && toolchain.status !== "found")
    throw Error("DEV_TOOL_SMOKE_TOOLCHAIN_REQUIRED");
  const node =
    toolchain.status === "found"
      ? path.join(toolchain.directory, "node")
      : process.execPath;
  const run = (args) => {
    const child = spawnSync(node, args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      process.exitCode = child.status ?? 1;
      return false;
    }
    return true;
  };
  if (!run(["tooling/dev.mjs", "--check", "--acceptance-profile"])) return;
  const image = await readPreparedDevCore(root);
  for (const args of devToolSmokePlan(root, image)) if (!run(args)) return;
  process.stdout.write(
    "Headless Dev File/Shell/MCP fixture passed. Saved profiles, live tunnel and ChatGPT were not used.\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });

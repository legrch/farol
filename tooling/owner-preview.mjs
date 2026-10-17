import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownerPreviewArguments,
  ownerPreviewPlan,
  requireOwnerPreviewRuntimeIntegration,
} from "./owner-preview-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function mainRef(ref) {
  return execFileSync("/usr/bin/git", ["rev-parse", "--verify", ref], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/var/empty",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
  }).trim();
}

try {
  const { action, expectedMain } = ownerPreviewArguments(process.argv.slice(2));
  // Block before package/profile access or any subprocess capable of launch.
  if (action !== "plan") requireOwnerPreviewRuntimeIntegration();
  const plan = ownerPreviewPlan(root, {
    expectedMain,
    localMain: mainRef("refs/heads/main"),
    trackedMain: mainRef("refs/remotes/origin/main"),
    source: sourceIdentity(root),
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "OWNER_PREVIEW_FAILED"}\n`,
  );
  process.exitCode = 1;
}

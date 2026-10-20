import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { coreTestSteps, coreProtocolFiles } from "./core-test-plan.mjs";

const nested = fs.existsSync("resources/native/go/go.mod");
const steps = coreTestSteps({ nested, node: process.execPath, go: "go" });
for (const step of steps) {
  if (step.message) process.stdout.write(step.message + "\n");
  else
    execFileSync(step.executable, step.args, {
      cwd: step.cwd ?? process.cwd(),
      stdio: "inherit",
    });
}
// This is completion of the unchanged required command chain, not invented
// Go case counts or proof of general descendant/process-tree containment.
process.stdout.write(
  JSON.stringify({
    schema: "farol-core-test-completion/1",
    completedSteps: steps.map((step) => step.id),
    nested,
    protocolFiles: coreProtocolFiles,
  }) + "\n",
);

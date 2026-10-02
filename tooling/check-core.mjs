import { execFileSync } from "node:child_process";
import fs from "node:fs";

const run = (command, args, cwd = process.cwd()) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
run(process.execPath, ["tooling/generate-desktop-wire.mjs", "--check"]);
run(process.execPath, ["tooling/check-go-architecture.mjs"]);
run("go", ["test", "-race", "./..."]);
run("go", ["vet", "./..."]);
if (fs.existsSync("resources/native/go/go.mod")) {
  run("go", ["test", "-race", "./..."], "resources/native/go");
  run("go", ["vet", "./..."], "resources/native/go");
} else
  process.stdout.write(
    "Nested release Go module absent from this accepted base.\n",
  );
run(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "tests/contract/desktop-wire.test.ts",
  "tests/architecture/go-architecture.test.ts",
]);
run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "--noEmit",
  "--project",
  "tooling/tsconfig.desktop-core.json",
]);
run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);

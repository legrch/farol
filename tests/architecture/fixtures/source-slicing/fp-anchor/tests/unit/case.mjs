import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const a = fs.readFileSync("tests/fixtures/app/src/main.ts", "utf8");
const b = fs.readFileSync(
  path.join(process.cwd(), "node_modules", "pkg", "src", "x.js"),
  "utf8",
);
vm.runInNewContext(a + b, {});

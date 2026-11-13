import fs from "node:fs";
import vm from "node:vm";
const root = process.cwd();
const source = fs.readFileSync(
  [root, "src", "apps/desktop/main.ts"].join("/"),
  "utf8",
);
vm.runInNewContext(source, {});

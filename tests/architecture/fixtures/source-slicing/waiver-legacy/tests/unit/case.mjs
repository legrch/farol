// source-slicing: allowed — reviewed: trying to trade the allowlist entry
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext(source, {});

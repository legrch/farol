import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext("1 + 1", { length: source.length });

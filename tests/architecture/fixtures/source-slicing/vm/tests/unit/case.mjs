import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext(source.slice(0, 10), {});

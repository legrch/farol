import fs from "node:fs";
import vm from "node:vm";
let source;
source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
var code;
code = source.slice(0, 10);
vm.runInNewContext(code, {});

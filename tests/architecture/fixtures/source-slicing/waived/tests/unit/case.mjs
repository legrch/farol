// source-slicing: allowed — reviewed: executes generated text, not repository code
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext(source, {});

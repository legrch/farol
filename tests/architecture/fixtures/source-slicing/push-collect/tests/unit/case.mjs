import fs from "node:fs";
import vm from "node:vm";
const pieces = [];
pieces.push(fs.readFileSync("src/apps/desktop/main.ts", "utf8"));
vm.runInNewContext(pieces.join("\n"), {});

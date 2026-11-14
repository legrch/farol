import fs from "node:fs";
import vm from "node:vm";
const holder = { nested: {} };
holder.nested.code = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext(holder.nested.code, {});

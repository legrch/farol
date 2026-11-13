import * as fs from "node:fs";
import * as vm from "node:vm";
vm.runInNewContext(fs.readFileSync("src/apps/desktop/main.ts", "utf8"), {});

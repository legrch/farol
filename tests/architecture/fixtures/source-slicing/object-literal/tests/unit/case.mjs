import fs from "node:fs";
import vm from "node:vm";
const files = { main: "src/apps/desktop/main.ts" };
vm.runInNewContext(fs.readFileSync(files.main, "utf8"), {});

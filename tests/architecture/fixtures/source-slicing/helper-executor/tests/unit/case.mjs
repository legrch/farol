import fs from "node:fs";
import vm from "node:vm";
function execute(code) {
  return vm.runInNewContext(code, {});
}
execute(fs.readFileSync("src/apps/desktop/main.ts", "utf8"));

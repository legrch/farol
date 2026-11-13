import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
function read(relative) {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}
vm.runInNewContext(read("src/apps/desktop/main.ts"), {});

import fs from "node:fs";
import vm from "node:vm";
for (const file of ["src/apps/desktop/main.ts"]) {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {});
}

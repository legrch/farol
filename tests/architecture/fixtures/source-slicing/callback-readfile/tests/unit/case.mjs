import fs from "node:fs";
import vm from "node:vm";
fs.readFile("src/apps/desktop/main.ts", "utf8", (error, text) => {
  vm.runInNewContext(text.slice(0, 10), {});
});

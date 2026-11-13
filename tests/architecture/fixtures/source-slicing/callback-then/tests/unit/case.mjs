import { readFile } from "node:fs/promises";
import vm from "node:vm";
readFile("src/apps/desktop/main.ts", "utf8").then((text) =>
  vm.runInNewContext(text, {}),
);

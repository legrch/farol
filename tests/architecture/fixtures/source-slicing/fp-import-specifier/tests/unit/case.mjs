import fs from "node:fs";
import vm from "node:vm";
import "../../src/apps/desktop/main.ts";
const text = fs.readFileSync("tests/fixtures/data.txt", "utf8");
vm.runInNewContext(text, {});

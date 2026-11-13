import fs from "node:fs";
import vm from "node:vm";
const data = fs.readFileSync("tests/fixtures/data.json", "utf8");
vm.runInNewContext("1 + 1", { data });

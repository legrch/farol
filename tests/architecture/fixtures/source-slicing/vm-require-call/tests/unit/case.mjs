import fs from "node:fs";
fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
require("node:vm").runInNewContext(source, {});

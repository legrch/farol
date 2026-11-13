import fs from "node:fs";
import Module from "node:module";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
new Module("fixture")._compile(source, "fixture.js");

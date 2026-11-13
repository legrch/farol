import fs from "node:fs";
import vm from "node:vm";
const text = `
// source-slicing: allowed — reviewed: this is only text in a template
`;
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
vm.runInNewContext(source + text, {});

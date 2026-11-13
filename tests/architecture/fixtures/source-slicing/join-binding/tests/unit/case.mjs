import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const root = process.cwd();
const dir = path.join(root, "src", "apps");
const source = fs.readFileSync(path.join(dir, "desktop", "main.ts"), "utf8");
vm.runInNewContext(source, {});

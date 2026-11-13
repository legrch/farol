import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const root = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(root, "src", relative), "utf8");
vm.runInNewContext(read("chat/session.ts"), {});

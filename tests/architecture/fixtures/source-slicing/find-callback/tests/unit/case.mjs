import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
const LIST = [{ path: "README.md" }, { path: "src/apps/desktop/main.ts" }];
const entry = LIST.find((e) => e.path === "src/apps/desktop/main.ts");
vm.runInNewContext(
  fs.readFileSync(path.join(process.cwd(), entry.path), "utf8"),
  {},
);

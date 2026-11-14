import fs from "node:fs";
import path from "node:path";
const source = fs.readFileSync(
  path.join("src", "apps", "desktop", "main.ts"),
  "utf8",
);
new Function(source.slice(0, 10))();

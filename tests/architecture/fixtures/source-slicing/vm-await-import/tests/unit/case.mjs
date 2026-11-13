import fs from "node:fs";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
(await import("node:vm")).runInNewContext(source, {});

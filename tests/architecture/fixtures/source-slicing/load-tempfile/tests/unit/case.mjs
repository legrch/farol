import fs from "node:fs";
import path from "node:path";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const entry = path.join(process.cwd(), "entry.mjs");
fs.writeFileSync(entry, source.slice(0, 10));
await import(entry);

import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const code = stripTypeScriptTypes(source);
await import(`data:text/javascript,${encodeURIComponent(code)}`);

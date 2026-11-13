import fs from "node:fs";
import { transformSync } from "esbuild";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const out = transformSync(source, { loader: "ts" });
await import(`data:text/javascript,${encodeURIComponent(out.code)}`);

import fs from "node:fs";
import * as esbuild from "esbuild";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const out = await esbuild.transform(source, { loader: "ts" });
await import(`data:text/javascript,${encodeURIComponent(out.code)}`);

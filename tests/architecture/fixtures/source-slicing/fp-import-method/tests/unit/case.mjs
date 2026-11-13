import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const tool = await import("../../tooling/bundle-renderer.mjs");
const out = await tool.build({ entry: "fixture" });
vm.runInNewContext(fs.readFileSync(path.join(out.dir, "bundle.js"), "utf8"));

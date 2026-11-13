const { readFileSync } = require("node:fs");
const vm = require("node:vm");
vm.runInNewContext(readFileSync("src/apps/desktop/main.ts", "utf8"), {});

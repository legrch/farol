import vm from "node:vm";
import source from "../../src/apps/desktop/main.ts?raw";
vm.runInNewContext(source, {});

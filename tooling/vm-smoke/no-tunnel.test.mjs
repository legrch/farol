import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./no-tunnel.js", import.meta.url),
  "utf8",
);
test("scalar Connect uncertainty refuses both empty and approved Dev admission", () => {
  for (const approved of [false, true]) {
    const config = {
      setup: { connect: { outcomeUnknown: true } },
      connectors: {
        secureMcp: {
          tunnelId: approved ? "dev-only" : null,
          credential: approved ? "stored" : "missing",
          runtime: null,
        },
      },
    };
    const marker = { schema: 1, source: "dev-only", tunnelId: "dev-only" };
    const context = {
      ObjC: { import() {} },
      $: {
        NSHomeDirectory: () => ({ js: "/guest" }),
        NSFileManager: { defaultManager: { fileExistsAtPath: () => approved } },
        NSString: {
          stringWithContentsOfFileEncodingError: (path) => ({
            js: JSON.stringify(path === "config" ? config : marker),
          }),
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    assert.throws(() => context.run(["config"]), /GUEST_EFFECT_UNKNOWN/);
  }
});

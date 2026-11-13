// No publication is admissible until guest persistence is qualified. Repeated
// entry must never reach an effect, including when old uncertainty is retained.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
test("unqualified import cannot publish or clear an uncertainty fence on reentry", () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(
    fs.readFileSync(new URL("./import-dev.js", import.meta.url), "utf8"),
    context,
  );
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => context.run([]),
      /GUEST_IMPORT_PERSISTENCE_UNQUALIFIED/,
    );
});

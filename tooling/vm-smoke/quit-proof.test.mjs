import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./quit-proof.js", import.meta.url),
  "utf8",
);
function proof(receipt, running = false) {
  const context = {
    ObjC: { import() {} },
    $: {
      NSHomeDirectory: () => ({ js: "/guest" }),
      NSFileManager: {
        defaultManager: {
          fileExistsAtPath: (path) =>
            path.endsWith("running.json") ? running : receipt !== null,
        },
      },
      NSString: {
        stringWithContentsOfFileEncodingError: (path) => ({
          js:
            path === "identity"
              ? JSON.stringify({ dataLeaf: "test.product" })
              : receipt,
        }),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(context.run(["identity"]));
}
test("quit proof recognizes only canonical confirmed drain and retains marker evidence", () => {
  const receipt = {
    schema: 1,
    at: "2026-11-07T12:00:00.000Z",
    drained: true,
    unconfirmed: [],
  };
  assert.equal(proof(JSON.stringify(receipt)).drained, true);
  assert.equal(proof(JSON.stringify(receipt), true).running, true);
  for (const change of [
    { drained: false },
    { unconfirmed: ["core"] },
    { schema: 2 },
    { at: "yesterday" },
    { extra: true },
  ]) {
    assert.equal(
      proof(JSON.stringify({ ...receipt, ...change })).drained,
      false,
    );
  }
  for (const raw of [null, "bad JSON", "null"])
    assert.equal(proof(raw).drained, false);
});

// Regression for the final-publication fence: a reported failure of the commit
// receipt write (publication 5) must leave the guest uncertainty guard up, so a
// rerun refuses instead of silently admitting another import. Originally RED
// against the boolean uncertainty contract; green against the ordered receipt
// publication. Synthetic Foundation bridge: proves JS ordering, NOT native
// persistence.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./import-dev.js", import.meta.url),
  "utf8",
);

function fixture(failure) {
  let config = {
    revision: 1,
    setup: { connect: {} },
    connectors: {
      secureMcp: {
        generation: 1,
        tunnelId: null,
        credential: "missing",
        runtime: null,
      },
    },
  };
  let receipt = null;
  let publications = 0;
  let secretWrites = 0;
  const put = (path, value) => {
    publications++;
    if (path.endsWith("/farol-state/config.json"))
      config = structuredClone(value);
    if (path.endsWith("secure-mcp-import-receipt.json"))
      receipt = structuredClone(value);
    return !(failure === "publish" && publications === 5);
  };
  const $ = (value) => ({
    writeToFileAtomicallyEncodingError(path) {
      return put(path, JSON.parse(value));
    },
  });
  Object.assign($, {
    NSHomeDirectory: () => ({ js: "/Users/synthetic" }),
    NSString: {
      stringWithContentsOfFileEncodingError(path) {
        // The receipt read is mocked explicitly: the fixed source reads the
        // receipt for admission, so the former catch-all config response would
        // misclassify every run as an unclassifiable receipt state.
        const text =
          path === "identity"
            ? JSON.stringify({ dataLeaf: "test.synthetic" })
            : path.endsWith("dev-connection.json")
              ? JSON.stringify({ schema: 1, tunnelId: "synthetic" })
              : path.endsWith("secure-mcp-import-receipt.json")
                ? receipt === null
                  ? null
                  : JSON.stringify(receipt)
                : JSON.stringify(config);
        return text === null ? null : { js: text };
      },
    },
    NSFileManager: {
      defaultManager: {
        createDirectoryAtPathWithIntermediateDirectoriesAttributesError: () =>
          true,
        setAttributesOfItemAtPathError: () =>
          !(failure === "chmod" && publications === 5),
      },
    },
    NSData: {
      dataWithContentsOfFile: () => ({
        length: 32,
        writeToFileAtomically(path) {
          secretWrites++;
          return put(path, undefined);
        },
      }),
    },
  });
  const context = vm.createContext({ $, ObjC: { import() {} } });
  vm.runInContext(source, context);
  return {
    run: () => context.run(["identity", "/synthetic/stage"]),
    state: () => ({
      config: structuredClone(config),
      publications,
      secretWrites,
    }),
  };
}

for (const failure of ["publish", "chmod"]) {
  test(`final fifth ${failure} failure must not silently admit another import`, () => {
    const f = fixture(failure);
    assert.throws(f.run, /GUEST_CONFIG_WRITE_FAILED/);
    assert.equal(
      f.state().publications,
      5,
      "exercise the omitted final publication, not writes 1–4",
    );
    assert.equal(
      f.state().config.setup.connect.outcomeUnknown,
      true,
      "final publication cleared the only guest uncertainty guard before returning failure",
    );
    const before = f.state().secretWrites;
    assert.throws(f.run, /GUEST_EFFECT_UNKNOWN/);
    assert.equal(f.state().secretWrites, before);
  });
}

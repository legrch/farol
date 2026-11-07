import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./import-dev.js", import.meta.url),
  "utf8",
);
function fixture(change = {}) {
  const config = {
    revision: 1,
    computer: { workspaces: ["guest-only"] },
    setup: { connect: {} },
    connectors: {
      secureMcp: {
        generation: 1,
        tunnelId: null,
        credential: "missing",
        runtime: null,
        ...change,
      },
    },
  };
  const writes = [];
  const $ = (value) => ({
    writeToFileAtomicallyEncodingError(path) {
      writes.push({ path, value: JSON.parse(value) });
      return true;
    },
  });
  Object.assign($, {
    NSHomeDirectory: () => ({ js: "/Users/guest" }),
    NSString: {
      stringWithContentsOfFileEncodingError(path) {
        return {
          js: JSON.stringify(
            path === "identity"
              ? { dataLeaf: "test.product" }
              : path.endsWith("dev-connection.json")
                ? { schema: 1, tunnelId: "dev-only" }
                : config,
          ),
        };
      },
    },
    NSFileManager: {
      defaultManager: {
        createDirectoryAtPathWithIntermediateDirectoriesAttributesError: () =>
          true,
        setAttributesOfItemAtPathError(attributes, path) {
          writes.push({ path, attributes });
          return true;
        },
      },
    },
    NSData: {
      dataWithContentsOfFile: () => ({
        length: 32,
        writeToFileAtomically(path) {
          writes.push({ path, key: true });
          return true;
        },
      }),
    },
  });
  const context = { $, ObjC: { import() {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { run: () => context.run(["identity", "/shared/test-run"]), writes };
}

test("offline import preserves guest workspaces and clears foreign runtime receipts", () => {
  const f = fixture();
  assert.equal(f.run(), "IMPORTED_DEV_CONNECTION");
  const settings = f.writes.find((x) => x.value && x.value.connectors).value;
  assert.deepEqual(settings.computer.workspaces, ["guest-only"]);
  assert.equal(settings.connectors.secureMcp.generation, 2);
  assert.equal(settings.connectors.secureMcp.tunnelId, "dev-only");
  assert.equal(settings.connectors.secureMcp.chatgptApp, null);
  assert.equal(settings.connectors.secureMcp.attachment, null);
  assert.ok(f.writes.every((x) => x.path.startsWith("/Users/guest/")));
  assert.ok(
    f.writes.some(
      (x) => x.attributes && x.attributes.NSFilePosixPermissions === 384,
    ),
  );
});
for (const [label, change] of [
  ["foreign tunnel", { tunnelId: "different" }],
  ["unknown runtime", { runtime: { state: "outcome_unknown" } }],
  ["pending verification", { appVerificationPending: true }],
]) {
  test(`refuses ${label} before any credential write`, () => {
    const f = fixture(change);
    assert.throws(f.run);
    assert.deepEqual(f.writes, []);
  });
}

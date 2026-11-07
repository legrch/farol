import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./import-dev.js", import.meta.url),
  "utf8",
);
function fixture(change = {}, failAt = 0) {
  let config = {
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
  let attempts = 0;
  const persist = (entry) => {
    attempts++;
    writes.push(entry);
    if (entry.value && entry.value.connectors) config = entry.value;
    // Simulate the dangerous post-publication failure, not merely no write.
    return attempts !== failAt;
  };
  const $ = (value) => ({
    writeToFileAtomicallyEncodingError(path) {
      return persist({ path, value: JSON.parse(value) });
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
          return persist({ path, key: true });
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
  const settings = f.writes
    .filter((x) => x.value && x.value.connectors)
    .at(-1).value;
  assert.deepEqual(settings.computer.workspaces, ["guest-only"]);
  assert.equal(settings.connectors.secureMcp.generation, 2);
  assert.equal(settings.connectors.secureMcp.tunnelId, "dev-only");
  assert.equal(settings.connectors.secureMcp.chatgptApp, null);
  assert.equal(settings.connectors.secureMcp.attachment, null);
  assert.equal(settings.setup.connect.outcomeUnknown, false);
  const fence = f.writes.findIndex((x) => x.value && x.value.connectors);
  const key = f.writes.findIndex((x) => x.key);
  assert.ok(fence < key);
  assert.equal(f.writes[fence].value.setup.connect.outcomeUnknown, true);
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

for (const failure of [1, 2, 3, 4]) {
  test(`post-publication failure ${failure} retains uncertainty and fences re-import`, () => {
    const f = fixture({}, failure);
    assert.throws(f.run);
    const stored = f.writes
      .filter((x) => x.value && x.value.connectors)
      .at(-1).value;
    assert.equal(stored.setup.connect.outcomeUnknown, true);
    const count = f.writes.length;
    assert.throws(f.run, /GUEST_EFFECT_UNKNOWN/);
    assert.equal(f.writes.length, count);
  });
}

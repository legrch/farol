import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./import-dev.js", import.meta.url),
  "utf8",
);
// Synthetic key material: printable ASCII bytes 33-126 only, never a real
// credential. Its bytes must never appear in any config/marker/receipt payload.
const SYNTHETIC_KEY = "synthetic-dev-key-0123456789abcdefghijklmn";
function fixture(change = {}, failAt = 0, extra = {}) {
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
  let receipt = extra.receipt === undefined ? null : extra.receipt;
  if (extra.unresolved) config.setup.connect.outcomeUnknown = true;
  const writes = [];
  const payloads = [];
  let attempts = 0;
  const persist = (entry) => {
    attempts++;
    // A crash aborts the run before the attempted publication lands.
    if (attempts === extra.crashAt) throw Error("GUEST_SESSION_CRASH");
    writes.push(entry);
    if (entry.value && entry.value.connectors) config = entry.value;
    if (entry.path.endsWith("secure-mcp-import-receipt.json"))
      receipt = entry.value;
    // Simulate the dangerous post-publication failure, not merely no write.
    return attempts !== failAt;
  };
  const $ = (value) => ({
    writeToFileAtomicallyEncodingError(path) {
      payloads.push(value);
      return persist({ path, value: JSON.parse(value) });
    },
  });
  Object.assign($, {
    NSHomeDirectory: () => ({ js: "/Users/guest" }),
    NSString: {
      stringWithContentsOfFileEncodingError(path) {
        const text =
          path === "identity"
            ? JSON.stringify({ dataLeaf: "test.product" })
            : path.endsWith("dev-connection.json")
              ? JSON.stringify({
                  schema: 1,
                  tunnelId:
                    extra.tunnelId === undefined ? "dev-only" : extra.tunnelId,
                })
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
        setAttributesOfItemAtPathError(attributes, path) {
          writes.push({ path, attributes });
          return true;
        },
      },
    },
    NSData: {
      dataWithContentsOfFile: () => ({
        length: SYNTHETIC_KEY.length,
        js: SYNTHETIC_KEY,
        writeToFileAtomically(path) {
          return persist({ path, key: true });
        },
      }),
    },
  });
  const context = { $, ObjC: { import() {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    run: () => context.run(["identity", "/shared/test-run"]),
    writes,
    payloads,
    state: () => ({ config, receipt }),
  };
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
  const receipt = f.writes.findIndex(
    (x) => x.value && x.path.endsWith("secure-mcp-import-receipt.json"),
  );
  assert.ok(key < receipt);
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
    assert.deepEqual(f.payloads, []);
  });
}

test("commit receipt and marker carry no credential material", () => {
  const f = fixture();
  assert.equal(f.run(), "IMPORTED_DEV_CONNECTION");
  const receipt = f.writes.find(
    (x) => x.value && x.path.endsWith("secure-mcp-import-receipt.json"),
  ).value;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "generation",
    "schema",
    "tunnelId",
  ]);
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.generation, 2);
  assert.equal(receipt.tunnelId, "dev-only");
  const marker = f.writes.find(
    (x) => x.value && x.path.endsWith(".farol-vm-dev-connection.json"),
  ).value;
  assert.deepEqual(Object.keys(marker).sort(), [
    "schema",
    "source",
    "tunnelId",
  ]);
  for (const payload of f.payloads)
    assert.ok(
      !payload.includes(SYNTHETIC_KEY),
      "a published payload must not carry key material",
    );
});

test("successful import re-admits idempotently with zero additional writes", () => {
  const f = fixture();
  assert.equal(f.run(), "IMPORTED_DEV_CONNECTION");
  const after = {
    writes: f.writes.length,
    payloads: f.payloads.length,
    secrets: f.writes.filter((x) => x.key).length,
  };
  assert.equal(f.run(), "IMPORTED_DEV_CONNECTION");
  assert.equal(f.writes.length, after.writes);
  assert.equal(f.payloads.length, after.payloads);
  assert.equal(f.writes.filter((x) => x.key).length, after.secrets);
  assert.equal(f.state().config.connectors.secureMcp.generation, 2);
  assert.equal(f.state().config.setup.connect.outcomeUnknown, false);
});

test("lost acknowledgement of only the final publication reruns idempotently", () => {
  const f = fixture({}, 6);
  assert.throws(f.run, /GUEST_CONFIG_WRITE_FAILED/);
  const after = {
    writes: f.writes.length,
    secrets: f.writes.filter((x) => x.key).length,
  };
  assert.equal(f.run(), "IMPORTED_DEV_CONNECTION");
  assert.equal(f.writes.length, after.writes);
  assert.equal(f.writes.filter((x) => x.key).length, after.secrets);
  assert.equal(f.state().config.connectors.secureMcp.generation, 2);
});

test("crash between the receipt and the final clear stays fenced", () => {
  const f = fixture({}, 0, { crashAt: 6 });
  assert.throws(f.run, /GUEST_SESSION_CRASH/);
  assert.equal(f.state().receipt.generation, 2);
  assert.equal(f.state().config.setup.connect.outcomeUnknown, true);
  const after = {
    writes: f.writes.length,
    secrets: f.writes.filter((x) => x.key).length,
  };
  assert.throws(f.run, /GUEST_EFFECT_UNKNOWN/);
  assert.equal(f.writes.length, after.writes);
  assert.equal(f.writes.filter((x) => x.key).length, after.secrets);
});

test("unclassifiable commit receipt refuses the import", () => {
  const f = fixture({}, 0, {
    receipt: { schema: 1, generation: 5, tunnelId: "dev-only" },
  });
  assert.throws(f.run, /GUEST_EFFECT_UNKNOWN/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.payloads, []);
});

test("refuses a different tunnel while the guest is unresolved", () => {
  const f = fixture({ tunnelId: "stored-tunnel" }, 0, {
    unresolved: true,
    tunnelId: "other-tunnel",
  });
  assert.throws(f.run, /GUEST_EFFECT_UNKNOWN/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.payloads, []);
});

for (const failure of [1, 2, 3, 4, 5]) {
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

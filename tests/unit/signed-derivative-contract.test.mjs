import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  SIGNED_DERIVATIVE_SCHEMA,
  assertSignedDerivativeBinding,
  parseSignedDerivativeProvenance,
} from "../../tooling/signed-derivative-contract.mjs";

// Symbolic values only: no Apple signing, native observation or authenticated inputs.
const hash = (character) => character.repeat(64);
const tree = (character) => ({
  kind: "tree",
  version: "farol.next.tree-digest/v2",
  sha256: hash(character),
});
const file = (character) => ({
  kind: "file",
  size: 12,
  sha256: hash(character),
});
const inventory = [
  ["Contents/Frameworks/Electron Runtime.app", "electron-code", true],
  [
    "Contents/Frameworks/Electron Runtime.app/Contents/Frameworks/Electron Helper (Renderer).app",
    "electron-code",
    true,
  ],
  ["Contents/MacOS/Farol Next Preview", "bootstrap", false],
  ["Contents/Resources/app/farol-core", "backend", false],
  ["Contents/Resources/app/update-archive.py", "archive-helper", false],
];
function identity(overrides = {}) {
  return createBuildIdentity({
    version: "0.2.7",
    buildVersion: "36",
    updateChannel: "github-stable",
    builtAt: "2026-10-14T12:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: hash("b"),
    sourceDirty: false,
    ...overrides,
  });
}
function raw() {
  return {
    buildIdentity: identity(),
    buildManifestSha256: hash("c"),
    inputLedgerSha256: hash("d"),
    runtime: {
      version: "44.4.2",
      platform: "darwin",
      arch: "arm64",
      distributionAsset: "electron-v44.4.2-darwin-arm64.zip",
      distributionSha256: hash("e"),
      extractedTree: tree("f"),
    },
    components: inventory.map(([path, role, isTree]) => ({
      path,
      role,
      raw: isTree ? tree("1") : file("2"),
    })),
  };
}
function expected(role = "outer") {
  return {
    teamId: "TEST000001",
    identifier: `synthetic.${role}`,
    designatedRequirement: `identifier "synthetic.${role}" and anchor apple generic`,
    hardenedRuntime: true,
    entitlements: role === "electron-code" ? { "synthetic.boolean": true } : {},
  };
}
function facts(role = "outer") {
  // Construct separately from policy; plist hash is an observation, not policy.
  return {
    teamId: "TEST000001",
    identifier: `synthetic.${role}`,
    designatedRequirement: `identifier "synthetic.${role}" and anchor apple generic`,
    hardenedRuntime: true,
    entitlements: {
      plistSha256: hash("3"),
      values: role === "electron-code" ? { "synthetic.boolean": true } : {},
    },
  };
}
function declaration() {
  return {
    schema: SIGNED_DERIVATIVE_SCHEMA,
    stage: "signed-pre-notarization",
    raw: raw(),
    signed: {
      appTree: tree("4"),
      components: inventory.map(([path, role, isTree]) => ({
        path,
        signed: isTree ? tree("5") : file("6"),
        signature: facts(role),
      })),
      outerSignature: facts(),
    },
  };
}
function context() {
  return {
    trustedRaw: raw(),
    signaturePolicy: {
      outer: expected(),
      components: inventory.map(([path, role]) => ({
        path,
        signature: expected(role),
      })),
    },
    observedSigned: {
      appTree: tree("4"),
      components: inventory.map(([path, role, isTree]) => ({
        path,
        signed: isTree ? tree("5") : file("6"),
        signature: facts(role),
        strictVerification: "valid",
      })),
      outerSignature: facts(),
      outerStrictVerification: "valid",
    },
  };
}
function refuses(action, code = "SHAPE_INVALID") {
  expect(action).toThrow(
    expect.objectContaining({ code: `SIGNED_DERIVATIVE_${code}` }),
  );
}
function frozen(value) {
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value))
    if (child && typeof child === "object") frozen(child);
}

describe("detached declaration and supplied independent binding", () => {
  it("preserves distinct raw/signed byte identities and returns a fresh deeply frozen DTO", () => {
    const input = declaration();
    const inputs = context();
    const result = assertSignedDerivativeBinding(input, inputs);
    expect(result).toEqual(input);
    expect(result.raw).toEqual(inputs.trustedRaw);
    expect(result.raw.components[2].raw.sha256).not.toBe(
      result.signed.components[2].signed.sha256,
    );
    expect(result).not.toBe(input);
    frozen(result);
    input.raw.components[2].raw.sha256 = hash("0");
    inputs.trustedRaw.buildManifestSha256 = hash("0");
    inputs.signaturePolicy.outer.teamId = "TEST000002";
    inputs.observedSigned.appTree.sha256 = hash("0");
    expect(result.raw.buildManifestSha256).toBe(hash("c"));
    expect(result.raw.components[2].raw.sha256).toBe(hash("2"));
    const parseInput = declaration();
    const parsed = parseSignedDerivativeProvenance(parseInput);
    parseInput.signed.appTree.sha256 = hash("0");
    expect(parsed.signed.appTree.sha256).toBe(hash("4"));
    frozen(parsed);
    expect(parsed).not.toHaveProperty("verified");
  });
  it("compares entitlement maps without depending on insertion order", () => {
    const input = declaration();
    const inputs = context();
    input.signed.outerSignature.entitlements.values = { b: false, a: true };
    inputs.signaturePolicy.outer.entitlements = { a: true, b: false };
    inputs.observedSigned.outerSignature.entitlements.values = {
      a: true,
      b: false,
    };
    expect(
      assertSignedDerivativeBinding(input, inputs).signed.outerSignature
        .entitlements.values,
    ).toEqual({ a: true, b: false });
  });
  it("copies special entitlement keys as ordinary own boolean data", () => {
    const input = declaration();
    const inputs = context();
    const values = () =>
      Object.fromEntries([
        ["__proto__", false],
        ["constructor", true],
        ["toJSON", false],
      ]);
    input.signed.outerSignature.entitlements.values = values();
    inputs.signaturePolicy.outer.entitlements = values();
    inputs.observedSigned.outerSignature.entitlements.values = values();
    const result = assertSignedDerivativeBinding(input, inputs);
    expect(
      Object.getPrototypeOf(result.signed.outerSignature.entitlements.values),
    ).toBe(Object.prototype);
    expect(
      Object.hasOwn(
        result.signed.outerSignature.entitlements.values,
        "__proto__",
      ),
    ).toBe(true);
    frozen(result);
  });
  it.each([
    [
      "build ID",
      (r) => {
        r.buildIdentity.buildId = hash("0");
      },
      "SHAPE_INVALID",
    ],
    [
      "source commit",
      (r) => {
        r.buildIdentity = identity({ sourceCommit: "b".repeat(40) });
      },
    ],
    [
      "source tree",
      (r) => {
        r.buildIdentity = identity({ sourceTreeDigest: hash("0") });
      },
    ],
    [
      "dirty state",
      (r) => {
        r.buildIdentity = identity({ sourceDirty: true });
      },
      "SHAPE_INVALID",
    ],
    [
      "manifest",
      (r) => {
        r.buildManifestSha256 = hash("0");
      },
    ],
    [
      "compiler/input ledger",
      (r) => {
        r.inputLedgerSha256 = hash("0");
      },
    ],
    [
      "vendor archive",
      (r) => {
        r.runtime.distributionSha256 = hash("0");
      },
    ],
    [
      "vendor tree",
      (r) => {
        r.runtime.extractedTree.sha256 = hash("0");
      },
    ],
    [
      "runtime version",
      (r) => {
        r.runtime.version = "44.4.3";
      },
    ],
    [
      "vendor asset",
      (r) => {
        r.runtime.distributionAsset = "other.zip";
      },
    ],
    [
      "raw component hash",
      (r) => {
        r.components[2].raw.sha256 = hash("0");
      },
    ],
    [
      "raw component size",
      (r) => {
        r.components[2].raw.size++;
      },
    ],
    [
      "raw component kind",
      (r) => {
        r.components[2].raw = tree("2");
      },
    ],
    [
      "role swap",
      (r) => {
        [r.components[3].role, r.components[4].role] = [
          r.components[4].role,
          r.components[3].role,
        ];
      },
    ],
  ])(
    "refuses changed independent raw %s",
    (_name, mutate, code = "RAW_MISMATCH") => {
      const inputs = context();
      mutate(inputs.trustedRaw);
      refuses(() => assertSignedDerivativeBinding(declaration(), inputs), code);
    },
  );
  it("refuses a self-consistent changed inventory including an arbitrary executable extension", () => {
    const input = declaration();
    const inputs = context();
    for (const entries of [
      input.raw.components,
      input.signed.components,
      inputs.observedSigned.components,
    ])
      entries[4].path += ".arbitrary-executable";
    refuses(() => assertSignedDerivativeBinding(input, inputs), "RAW_MISMATCH");
  });
  it.each([
    "teamId",
    "identifier",
    "designatedRequirement",
    "hardenedRuntime",
    "entitlements",
  ])("compares complete independent %s policy", (field) => {
    const input = declaration();
    const inputs = context();
    const changes = {
      teamId: "TEST000002",
      identifier: "synthetic.other",
      designatedRequirement: "anchor apple",
      hardenedRuntime: false,
      entitlements: { extra: true },
    };
    inputs.signaturePolicy.outer[field] = changes[field];
    refuses(
      () => assertSignedDerivativeBinding(input, inputs),
      "POLICY_MISMATCH",
    );
    inputs.signaturePolicy = context().signaturePolicy;
    inputs.signaturePolicy.components[3].signature[field] = changes[field];
    refuses(
      () => assertSignedDerivativeBinding(input, inputs),
      "POLICY_MISMATCH",
    );
  });
  it("keeps backend and Electron policies separate", () => {
    const inputs = context();
    inputs.signaturePolicy.components[3].signature = expected("electron-code");
    refuses(
      () => assertSignedDerivativeBinding(declaration(), inputs),
      "POLICY_MISMATCH",
    );
  });
  it.each([
    [
      "app tree",
      (o) => {
        o.appTree.sha256 = hash("0");
      },
    ],
    [
      "signed file hash",
      (o) => {
        o.components[3].signed.sha256 = hash("0");
      },
    ],
    [
      "signed file size",
      (o) => {
        o.components[3].signed.size++;
      },
    ],
    [
      "signed kind",
      (o) => {
        o.components[3].signed = tree("6");
      },
    ],
    [
      "signed tree",
      (o) => {
        o.components[0].signed.sha256 = hash("0");
      },
    ],
    [
      "plist hash",
      (o) => {
        o.outerSignature.entitlements.plistSha256 = hash("0");
      },
    ],
    [
      "component plist hash",
      (o) => {
        o.components[3].signature.entitlements.plistSha256 = hash("0");
      },
    ],
    [
      "extra entitlement",
      (o) => {
        o.components[3].signature.entitlements.values.extra = false;
      },
    ],
    [
      "outer signature",
      (o) => {
        o.outerSignature.identifier = "synthetic.other";
      },
    ],
    [
      "component signature",
      (o) => {
        o.components[3].signature.designatedRequirement = "anchor apple";
      },
    ],
  ])("compares complete supplied signed observation: %s", (_name, mutate) => {
    const inputs = context();
    mutate(inputs.observedSigned);
    refuses(
      () => assertSignedDerivativeBinding(declaration(), inputs),
      "OBSERVATION_MISMATCH",
    );
  });
  it.each(["invalid", "unknown", undefined])(
    "refuses %s strict status for outer and component signatures",
    (status) => {
      for (const outer of [true, false]) {
        const inputs = context();
        if (outer) {
          if (status === undefined)
            delete inputs.observedSigned.outerStrictVerification;
          else inputs.observedSigned.outerStrictVerification = status;
        } else {
          if (status === undefined)
            delete inputs.observedSigned.components[1].strictVerification;
          else inputs.observedSigned.components[1].strictVerification = status;
        }
        refuses(
          () => assertSignedDerivativeBinding(declaration(), inputs),
          status === undefined ? "SHAPE_INVALID" : "OBSERVATION_MISMATCH",
        );
      }
    },
  );
  it("does not authenticate caller-supplied valid observations or prove a permitted transformation", () => {
    const input = declaration();
    const inputs = context();
    // A malicious rehash cannot override independent raw or policy expectations.
    input.signed.components[3].signed.sha256 = hash("0");
    inputs.observedSigned.components[3].signed.sha256 = hash("0");
    inputs.trustedRaw.inputLedgerSha256 = hash("0");
    refuses(() => assertSignedDerivativeBinding(input, inputs), "RAW_MISMATCH");
    inputs.trustedRaw = raw();
    inputs.signaturePolicy.components[3].signature.identifier =
      "synthetic.required";
    refuses(
      () => assertSignedDerivativeBinding(input, inputs),
      "POLICY_MISMATCH",
    );
    // With all supplied expectations agreeing, this pure API has no native authenticity evidence.
    inputs.signaturePolicy = context().signaturePolicy;
    expect(
      assertSignedDerivativeBinding(input, inputs).signed.components[3].signed
        .sha256,
    ).toBe(hash("0"));
  });
  it("detects a changed synthetic raw or signed Buffer when only one side changes", () => {
    const digest = (buffer) =>
      createHash("sha256").update(buffer).digest("hex");
    const before = Buffer.from("synthetic bytes");
    const after = Buffer.from(before);
    after[0] ^= 1;
    expect(digest(before)).not.toBe(digest(after));
    for (const side of ["raw", "signed"]) {
      const input = declaration();
      const inputs = context();
      if (side === "raw") {
        input.raw.components[3].raw.sha256 = digest(before);
        inputs.trustedRaw.components[3].raw.sha256 = digest(after);
      } else {
        input.signed.components[3].signed.sha256 = digest(before);
        inputs.observedSigned.components[3].signed.sha256 = digest(after);
      }
      refuses(
        () => assertSignedDerivativeBinding(input, inputs),
        side === "raw" ? "RAW_MISMATCH" : "OBSERVATION_MISMATCH",
      );
    }
  });
});

const badPaths = [
  "/Contents/a",
  "Contents/",
  "Contents//a",
  "Contents/./a",
  "Contents/../a",
  "Contents/a/..",
  "https://host/a",
  "C:/Contents/a",
  "Contents/C:a",
  "Contents/a\\b",
  "Contents/a\0b",
  "Contents/a\nb",
  "Contents/a\tb",
  "Contents/%2e%2e/a",
  "Contents/é",
  "Contents/ｅ",
  "Contents/a.",
  "Contents/a ",
  "Contents/ a",
  "Contents/.hidden",
  `Contents/${"a".repeat(1024)}`,
];
describe("closed bounded data schema", () => {
  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "refuses terminal controls %j in hashes, Team IDs, ASCII fields and paths",
    (control) => {
      for (const mutate of [
        (d) => {
          d.raw.inputLedgerSha256 += control;
        },
        (d) => {
          d.signed.outerSignature.teamId += control;
        },
        (d) => {
          d.signed.outerSignature.identifier += control;
        },
        (d) => {
          d.signed.outerSignature.designatedRequirement += control;
        },
        (d) => {
          d.signed.outerSignature.entitlements.values[`key${control}`] = true;
        },
        (d) => {
          d.raw.components[0].path += control;
        },
      ]) {
        const input = declaration();
        mutate(input);
        refuses(() => parseSignedDerivativeProvenance(input));
      }
    },
  );
  it.each(badPaths)("refuses path alias or unsupported name %j", (path) => {
    const input = declaration();
    input.raw.components[0].path = path;
    refuses(() => parseSignedDerivativeProvenance(input));
  });
  it.each([
    undefined,
    "farol.signed-derivative/0",
    7,
    "farol.github-release/1",
  ])("classifies wrong schema %s", (schema) => {
    const input = declaration();
    input.schema = schema;
    refuses(() => parseSignedDerivativeProvenance(input), "SCHEMA_INVALID");
  });
  it.each([
    [
      "top extension",
      (d) => {
        d.notarized = true;
      },
    ],
    [
      "stage",
      (d) => {
        d.stage = "notarized";
      },
    ],
    [
      "ticket",
      (d) => {
        d.signed.ticket = "ticket";
      },
    ],
    [
      "credential",
      (d) => {
        d.raw.credential = "secret";
      },
    ],
    [
      "local path",
      (d) => {
        d.raw.runtime.localPath = "/tmp/runtime";
      },
    ],
    [
      "nested extension",
      (d) => {
        d.signed.components[0].signature.extra = false;
      },
    ],
    [
      "digest extension",
      (d) => {
        d.signed.appTree.extra = false;
      },
    ],
    [
      "tree version",
      (d) => {
        d.signed.appTree.version = "farol.next.tree-digest/v1";
      },
    ],
    [
      "unsafe size",
      (d) => {
        d.raw.components[3].raw.size = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "infinite size",
      (d) => {
        d.raw.components[3].raw.size = Infinity;
      },
    ],
    [
      "NaN size",
      (d) => {
        d.raw.components[3].raw.size = NaN;
      },
    ],
    [
      "zero size",
      (d) => {
        d.raw.components[3].raw.size = 0;
      },
    ],
    [
      "oversize file",
      (d) => {
        d.raw.components[3].raw.size = 2 ** 31;
      },
    ],
    [
      "fractional size",
      (d) => {
        d.raw.components[3].raw.size = 1.5;
      },
    ],
    [
      "uppercase hash",
      (d) => {
        d.raw.inputLedgerSha256 = "A".repeat(64);
      },
    ],
    [
      "missing empty entitlements",
      (d) => {
        delete d.signed.components[3].signature.entitlements.values;
      },
    ],
    [
      "missing plist hash",
      (d) => {
        delete d.signed.outerSignature.entitlements.plistSha256;
      },
    ],
    [
      "invalid role",
      (d) => {
        d.raw.components[0].role = "executable";
      },
    ],
    [
      "invalid team",
      (d) => {
        d.signed.outerSignature.teamId = "test000001";
      },
    ],
    [
      "empty identifier",
      (d) => {
        d.signed.outerSignature.identifier = "";
      },
    ],
    [
      "long identifier",
      (d) => {
        d.signed.outerSignature.identifier = "a".repeat(256);
      },
    ],
    [
      "long requirement",
      (d) => {
        d.signed.outerSignature.designatedRequirement = "a".repeat(8193);
      },
    ],
    [
      "requirement control",
      (d) => {
        d.signed.outerSignature.designatedRequirement += "\n";
      },
    ],
    [
      "runtime string bound",
      (d) => {
        d.raw.runtime.version = "a".repeat(256);
      },
    ],
    [
      "build string bound",
      (d) => {
        d.raw.buildIdentity.version = "1".repeat(256);
      },
    ],
    [
      "empty entitlement key",
      (d) => {
        d.signed.outerSignature.entitlements.values[""] = true;
      },
    ],
    [
      "long entitlement key",
      (d) => {
        d.signed.outerSignature.entitlements.values["a".repeat(256)] = true;
      },
    ],
    [
      "entitlement count",
      (d) => {
        d.signed.outerSignature.entitlements.values = Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`key${i}`, true]),
        );
      },
    ],
    [
      "empty inventory",
      (d) => {
        d.raw.components = [];
      },
    ],
    [
      "oversize inventory",
      (d) => {
        d.raw.components = Array(129).fill(d.raw.components[0]);
      },
    ],
    [
      "sparse inventory",
      (d) => {
        delete d.raw.components[1];
      },
    ],
    [
      "array extension",
      (d) => {
        d.raw.components.extra = true;
      },
    ],
    [
      "array symbol",
      (d) => {
        d.raw.components[Symbol("extra")] = true;
      },
    ],
    [
      "duplicate component",
      (d) => {
        d.raw.components[1] = d.raw.components[0];
      },
    ],
    [
      "reordered component",
      (d) => {
        d.raw.components.reverse();
      },
    ],
    [
      "missing Electron helper",
      (d) => {
        d.signed.components.splice(1, 1);
      },
    ],
    [
      "extra component",
      (d) => {
        d.signed.components.push({
          ...d.signed.components.at(-1),
          path: "Contents/Resources/z",
        });
      },
    ],
    [
      "null prototype",
      (d) => {
        d.raw.runtime = Object.assign(Object.create(null), d.raw.runtime);
      },
    ],
    [
      "inherited property",
      (d) => {
        d.raw.runtime = Object.assign(
          Object.create({ extra: true }),
          d.raw.runtime,
        );
      },
    ],
    [
      "symbol property",
      (d) => {
        d.signed[Symbol("extra")] = false;
      },
    ],
    [
      "hidden property",
      (d) => {
        Object.defineProperty(d.signed, "extra", { value: false });
      },
    ],
    [
      "identity extension",
      (d) => {
        d.raw.buildIdentity.extra = false;
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const input = declaration();
    mutate(input);
    refuses(() => parseSignedDerivativeProvenance(input));
  });
  it.each([1, "true", null, [], {}])(
    "refuses unsupported entitlement type %j",
    (value) => {
      const input = declaration();
      input.signed.outerSignature.entitlements.values.extra = value;
      refuses(() => parseSignedDerivativeProvenance(input));
    },
  );
  it("never invokes accessor fields, including arrays and independent inputs", () => {
    let calls = 0;
    const getter = {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter executed");
      },
    };
    for (const select of [
      (d) => [d, "schema"],
      (d) => [d.raw.buildIdentity, "buildId"],
      (d) => [d.raw.components, "0"],
      (d) => [d.signed.outerSignature.entitlements.values, "extra"],
    ]) {
      const input = declaration();
      const [object, key] = select(input);
      Object.defineProperty(object, key, getter);
      refuses(() => parseSignedDerivativeProvenance(input));
    }
    for (const name of ["trustedRaw", "signaturePolicy", "observedSigned"]) {
      const inputs = context();
      Object.defineProperty(inputs, name, getter);
      refuses(() => assertSignedDerivativeBinding(declaration(), inputs));
    }
    expect(calls).toBe(0);
  });
  it("requires each independent context and inventory, without deriving defaults", () => {
    for (const name of ["trustedRaw", "signaturePolicy", "observedSigned"]) {
      const inputs = context();
      delete inputs[name];
      refuses(() => assertSignedDerivativeBinding(declaration(), inputs));
    }
    for (const name of ["signaturePolicy", "observedSigned"]) {
      const inputs = context();
      inputs[name].components.splice(1, 1);
      refuses(
        () => assertSignedDerivativeBinding(declaration(), inputs),
        name === "signaturePolicy" ? "POLICY_MISMATCH" : "OBSERVATION_MISMATCH",
      );
    }
    const inputs = context();
    inputs.signaturePolicy.components[0].signature.entitlements = {
      extra: "unsupported",
    };
    refuses(() => assertSignedDerivativeBinding(declaration(), inputs));
    // A raw disagreement cannot hide an independently malformed observation.
    inputs.trustedRaw.buildManifestSha256 = hash("0");
    inputs.signaturePolicy = context().signaturePolicy;
    delete inputs.observedSigned.outerStrictVerification;
    refuses(() => assertSignedDerivativeBinding(declaration(), inputs));
  });
});

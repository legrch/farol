import { assertBuildIdentity } from "./build-identity-contract.mjs";

export const SIGNED_DERIVATIVE_SCHEMA = "farol.signed-derivative/1";
const prefix = "SIGNED_DERIVATIVE_";
const treeVersion = "farol.tree-digest/v2";
const roles = ["bootstrap", "backend", "archive-helper", "electron-code"];
const failures = new WeakSet();

function requireValue(condition, code = "SHAPE_INVALID") {
  if (!condition) {
    const error = Object.freeze(
      Object.assign(new Error(prefix + code), {
        code: prefix + code,
      }),
    );
    failures.add(error);
    throw error;
  }
}
function boundary(operation) {
  try {
    return operation();
  } catch (error) {
    // Identity membership preserves our failures without inspecting untrusted throws.
    if (failures.has(error)) throw error;
    requireValue(false);
  }
}

// Read descriptors before values: getters, symbols and custom prototypes are refused.
function data(value) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    Reflect.ownKeys(descriptors).every(
      (key) =>
        typeof key === "string" &&
        Object.hasOwn(descriptors[key], "value") &&
        descriptors[key].enumerable,
    ),
  );
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}
function object(value, keys) {
  const result = data(value);
  const actual = Object.keys(result);
  requireValue(
    actual.length === keys.length &&
      keys.every((key) => Object.hasOwn(result, key)),
  );
  return result;
}
function ascii(value, max) {
  requireValue(
    typeof value === "string" &&
      value.length >= 1 &&
      value.length <= max &&
      /^[\x20-\x7e]+$/u.test(value),
  );
  return value;
}
function hash(value) {
  requireValue(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  return value;
}
function boolean(value) {
  requireValue(typeof value === "boolean");
  return value;
}
function literal(value, expected) {
  requireValue(value === expected);
  return value;
}
function componentPath(value) {
  ascii(value, 1024);
  requireValue(
    value.startsWith("Contents/") &&
      value
        .split("/")
        .every(
          (segment) =>
            /^[A-Za-z0-9 _().-]+$/u.test(segment) &&
            segment !== "." &&
            segment !== ".." &&
            !/^[ .]|[ .]$/u.test(segment),
        ),
  );
  return value;
}
function components(value, parse) {
  requireValue(
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
  );
  const length = Object.getOwnPropertyDescriptor(value, "length").value;
  requireValue(Number.isSafeInteger(length) && length >= 1 && length <= 128);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(descriptors).length === length + 1);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    requireValue(
      Object.hasOwn(descriptors, index) &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable,
    );
    result.push(parse(descriptor.value));
    requireValue(index === 0 || result[index - 1].path < result[index].path);
  }
  return result;
}
function digest(value, treeOnly = false) {
  const fields = data(value);
  if (fields.kind === "tree") {
    const item = object(fields, ["kind", "version", "sha256"]);
    return {
      kind: "tree",
      version: literal(item.version, treeVersion),
      sha256: hash(item.sha256),
    };
  }
  const item = object(fields, ["kind", "size", "sha256"]);
  requireValue(
    !treeOnly &&
      item.kind === "file" &&
      Number.isSafeInteger(item.size) &&
      item.size >= 1 &&
      item.size <= 2 ** 31 - 1,
  );
  return { kind: "file", size: item.size, sha256: hash(item.sha256) };
}
function buildIdentity(value) {
  const fields = data(value);
  const keys = [
    "schema",
    "product",
    "version",
    "bundleId",
    "updateChannel",
    "builtAt",
    "sourceCommit",
    "sourceTreeDigest",
    "sourceDirty",
    "buildId",
  ];
  if (Object.hasOwn(fields, "buildVersion")) keys.push("buildVersion");
  const item = object(fields, keys);
  const result = Object.fromEntries(keys.map((key) => [key, item[key]]));
  for (const key of keys.filter(
    (key) => key !== "schema" && key !== "sourceDirty",
  ))
    ascii(result[key], 255);
  requireValue(result.sourceDirty === false);
  try {
    assertBuildIdentity(result);
  } catch {
    requireValue(false);
  }
  return result;
}
function raw(value) {
  const item = object(value, [
    "buildIdentity",
    "buildManifestSha256",
    "inputLedgerSha256",
    "runtime",
    "components",
  ]);
  const runtime = object(item.runtime, [
    "version",
    "platform",
    "arch",
    "distributionAsset",
    "distributionSha256",
    "extractedTree",
  ]);
  return {
    buildIdentity: buildIdentity(item.buildIdentity),
    buildManifestSha256: hash(item.buildManifestSha256),
    inputLedgerSha256: hash(item.inputLedgerSha256),
    runtime: {
      version: ascii(runtime.version, 255),
      platform: literal(runtime.platform, "darwin"),
      arch: literal(runtime.arch, "arm64"),
      distributionAsset: ascii(runtime.distributionAsset, 255),
      distributionSha256: hash(runtime.distributionSha256),
      extractedTree: digest(runtime.extractedTree, true),
    },
    components: components(item.components, (value) => {
      const entry = object(value, ["path", "role", "raw"]);
      requireValue(roles.includes(entry.role));
      return {
        path: componentPath(entry.path),
        role: entry.role,
        raw: digest(entry.raw),
      };
    }),
  };
}
function entitlements(value) {
  const fields = data(value);
  const keys = Object.keys(fields).sort();
  requireValue(keys.length <= 64);
  return Object.fromEntries(
    keys.map((key) => [ascii(key, 255), boolean(fields[key])]),
  );
}
function signature(value, facts = true) {
  const item = object(value, [
    "teamId",
    "identifier",
    "designatedRequirement",
    "hardenedRuntime",
    "entitlements",
  ]);
  requireValue(
    typeof item.teamId === "string" && /^[A-Z0-9]{10}$/u.test(item.teamId),
  );
  const observed = facts
    ? object(item.entitlements, ["plistSha256", "values"])
    : undefined;
  return {
    teamId: item.teamId,
    identifier: ascii(item.identifier, 255),
    designatedRequirement: ascii(item.designatedRequirement, 8192),
    hardenedRuntime: boolean(item.hardenedRuntime),
    entitlements: facts
      ? {
          plistSha256: hash(observed.plistSha256),
          values: entitlements(observed.values),
        }
      : entitlements(item.entitlements),
  };
}
function signed(value, observation = false) {
  const item = object(value, [
    "appTree",
    "components",
    "outerSignature",
    ...(observation ? ["outerStrictVerification"] : []),
  ]);
  const result = {
    appTree: digest(item.appTree, true),
    components: components(item.components, (value) => {
      const entry = object(value, [
        "path",
        "signed",
        "signature",
        ...(observation ? ["strictVerification"] : []),
      ]);
      return {
        path: componentPath(entry.path),
        signed: digest(entry.signed),
        signature: signature(entry.signature),
        ...(observation
          ? { strictVerification: status(entry.strictVerification) }
          : {}),
      };
    }),
    outerSignature: signature(item.outerSignature),
  };
  if (observation)
    result.outerStrictVerification = status(item.outerStrictVerification);
  return result;
}
function status(value) {
  requireValue(["valid", "invalid", "unknown"].includes(value));
  return value;
}
function policy(value) {
  const item = object(value, ["outer", "components"]);
  return {
    outer: signature(item.outer, false),
    components: components(item.components, (value) => {
      const entry = object(value, ["path", "signature"]);
      return {
        path: componentPath(entry.path),
        signature: signature(entry.signature, false),
      };
    }),
  };
}
function equal(left, right, code) {
  requireValue(JSON.stringify(left) === JSON.stringify(right), code);
}
function paths(entries) {
  return entries.map((entry) => entry.path);
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseDeclaration(value) {
  const fields = data(value);
  requireValue(fields.schema === SIGNED_DERIVATIVE_SCHEMA, "SCHEMA_INVALID");
  const item = object(fields, ["schema", "stage", "raw", "signed"]);
  const result = {
    schema: SIGNED_DERIVATIVE_SCHEMA,
    stage: literal(item.stage, "signed-pre-notarization"),
    raw: raw(item.raw),
    signed: signed(item.signed),
  };
  equal(
    paths(result.raw.components),
    paths(result.signed.components),
    "SHAPE_INVALID",
  );
  return freeze(result);
}

function bindDeclaration(declaration, context) {
  const result = parseDeclaration(declaration);
  const inputs = object(context, [
    "trustedRaw",
    "signaturePolicy",
    "observedSigned",
  ]);
  // Each independent input is parsed in full before any comparisons.
  const trusted = raw(inputs.trustedRaw);
  const expected = policy(inputs.signaturePolicy);
  const observed = signed(inputs.observedSigned, true);
  equal(result.raw, trusted, "RAW_MISMATCH");
  equal(
    paths(trusted.components),
    paths(expected.components),
    "POLICY_MISMATCH",
  );
  equal(
    paths(trusted.components),
    paths(observed.components),
    "OBSERVATION_MISMATCH",
  );
  const compareSignature = (facts, expected, actual) => {
    const { entitlements: values, ...identity } = facts;
    equal(
      { ...identity, entitlements: values.values },
      expected,
      "POLICY_MISMATCH",
    );
    equal(facts, actual, "OBSERVATION_MISMATCH");
  };
  requireValue(
    observed.outerStrictVerification === "valid",
    "OBSERVATION_MISMATCH",
  );
  equal(result.signed.appTree, observed.appTree, "OBSERVATION_MISMATCH");
  compareSignature(
    result.signed.outerSignature,
    expected.outer,
    observed.outerSignature,
  );
  result.signed.components.forEach((entry, index) => {
    const actual = observed.components[index];
    requireValue(actual.strictVerification === "valid", "OBSERVATION_MISMATCH");
    equal(entry.signed, actual.signed, "OBSERVATION_MISMATCH");
    compareSignature(
      entry.signature,
      expected.components[index].signature,
      actual.signature,
    );
  });
  return result;
}

export function parseSignedDerivativeProvenance(value) {
  return boundary(() => parseDeclaration(value));
}

export function assertSignedDerivativeBinding(declaration, context) {
  return boundary(() => bindDeclaration(declaration, context));
}

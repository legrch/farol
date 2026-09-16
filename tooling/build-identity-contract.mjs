import { createHash } from "node:crypto";

const product = "Farol Next Preview";
const bundleId = "local.farol.next.preview";
const updateChannel = "local-preview-only";
const exactKeys = Object.freeze(
  [
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
  ].sort(),
);

function payload(identity) {
  return {
    schema: 1,
    product,
    version: identity.version,
    bundleId,
    updateChannel,
    builtAt: identity.builtAt,
    sourceCommit: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    sourceDirty: identity.sourceDirty,
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === exactKeys.length &&
    keys.every((key, index) => key === exactKeys[index]) &&
    value.schema === 1 &&
    value.product === product &&
    typeof value.version === "string" &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) &&
    value.bundleId === bundleId &&
    value.updateChannel === updateChannel &&
    canonicalTimestamp(value.builtAt) &&
    /^[a-f0-9]{40}$/u.test(value.sourceCommit ?? "") &&
    /^[a-f0-9]{64}$/u.test(value.sourceTreeDigest ?? "") &&
    typeof value.sourceDirty === "boolean" &&
    /^[a-f0-9]{64}$/u.test(value.buildId ?? "")
  );
}

export function assertBuildIdentity(value) {
  if (!validShape(value) || value.buildId !== digest(payload(value))) {
    throw new Error("BUILD_IDENTITY_INVALID");
  }
  return value;
}

export function createBuildIdentity(input) {
  const body = payload(input);
  return assertBuildIdentity({ ...body, buildId: digest(body) });
}

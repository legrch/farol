# Detached signed-derivative declaration

`tooling/signed-derivative-contract.mjs` exports
`SIGNED_DERIVATIVE_SCHEMA = "farol.signed-derivative/1"`,
`parseSignedDerivativeProvenance(value)` and
`assertSignedDerivativeBinding(declaration, context)`. Both return a fresh,
deep-frozen DTO. This additive contract is unwired: no producer, package verifier,
Release consumer, installer or updater accepts it as a package format. Existing
package generations 5/6/7 and `farol.github-release/1` remain unchanged.

Parsing validates closed data shapes. Binding compares a declaration with three
separately supplied inputs: `trustedRaw`, `signaturePolicy` and `observedSigned`.
Every input is validated before comparisons. Callers must independently authenticate
those inputs; a caller must never populate missing expectations from the
declaration. Binding establishes agreement among supplied values, without
establishing authenticated signing or proving that raw/signed hash pairs represent
only a permitted transformation. A caller can supply fabricated agreeing facts.

## Exact /1 schema

All properties below are required and exact. `BuildIdentityV1` is the unchanged
identity accepted by `assertBuildIdentity` in `build-identity-contract.mjs`, with
`sourceDirty: false`; its existing optional `buildVersion` remains optional.

```ts
type FileDigest = { kind: "file"; size: number; sha256: string };
type TreeDigest = {
  kind: "tree";
  version: "farol.tree-digest/v2";
  sha256: string;
};
type ContentDigest = FileDigest | TreeDigest;
type RawComponent = {
  path: string;
  role: "bootstrap" | "backend" | "archive-helper" | "electron-code";
  raw: ContentDigest;
};
type TrustedRaw = {
  buildIdentity: BuildIdentityV1;
  buildManifestSha256: string;
  inputLedgerSha256: string;
  runtime: {
    version: string;
    platform: "darwin";
    arch: "arm64";
    distributionAsset: string;
    distributionSha256: string;
    extractedTree: TreeDigest;
  };
  components: RawComponent[];
};
type ExpectedSignature = {
  teamId: string;
  identifier: string;
  designatedRequirement: string;
  hardenedRuntime: boolean;
  entitlements: Record<string, boolean>;
};
type SignatureFacts = Omit<ExpectedSignature, "entitlements"> & {
  entitlements: {
    plistSha256: string;
    values: Record<string, boolean>;
  };
};
type SignedComponent = {
  path: string;
  signed: ContentDigest;
  signature: SignatureFacts;
};
type Declaration = {
  schema: "farol.signed-derivative/1";
  stage: "signed-pre-notarization";
  raw: TrustedRaw;
  signed: {
    appTree: TreeDigest;
    components: SignedComponent[];
    outerSignature: SignatureFacts;
  };
};
type SignaturePolicy = {
  outer: ExpectedSignature;
  components: { path: string; signature: ExpectedSignature }[];
};
type SignedObservation = {
  appTree: TreeDigest;
  components: (SignedComponent & {
    strictVerification: "valid" | "invalid" | "unknown";
  })[];
  outerSignature: SignatureFacts;
  outerStrictVerification: "valid" | "invalid" | "unknown";
};
type BindingContext = {
  trustedRaw: TrustedRaw;
  signaturePolicy: SignaturePolicy;
  observedSigned: SignedObservation;
};
```

The declaration contains no verification-success field. Only independently
supplied `valid` strict observations can bind; missing, invalid and unknown
statuses fail. There are no default expectations or policy selections. No real
Team ID, entitlement policy, certificate or designated requirement is chosen here.

All hashes are exactly 64 lowercase hexadecimal characters. File sizes are safe
integers from 1 through 2³¹−1. Components have 1..128 entries, sorted by ASCII path,
without duplicates. Raw, declared signed, policy and observed path sets must match
exactly; raw roles and every raw field must equal `trustedRaw`. This includes the
build identity, manifest bytes hash, compiler/input ledger, original vendor archive
hash and original extracted tree hash. Raw identity/digests are never rewritten
with signed identities. All declared signed digests and signature facts, including
exact observed entitlement plist hashes, must equal observations. Policy compares
Team, identifier, exact designated requirement, hardened runtime and the entire
semantic entitlement key/value set. Backend and Electron policies stay separate.

Component paths begin with `Contents/`, contain at most 1024 ASCII bytes, and use
segments matching `[A-Za-z0-9 _().-]+`. Empty segments, `.`/`..` and segments
starting or ending in a space or dot are refused. Names containing Unicode,
colon, percent escapes, backslashes, controls or other punctuation are unsupported
in /1. This finite grammar admits spaces and parentheses in current bundle names
while refusing absolute paths, URLs, drive prefixes and normalization aliases.
The independent component inventory selects exact paths; the module does not
scan for executables or use extension heuristics.

Team IDs are exactly 10 uppercase ASCII letters/digits. Identifiers are 1..255
printable ASCII characters; designated requirements are 1..8192. Entitlement maps
contain 0..64 keys, each 1..255 printable ASCII characters, and boolean values
only. Empty maps are explicit observations. String, integer, data, array or
nested dictionary entitlement values require a future version decision. Runtime
version/asset strings and build-identity string fields are bounded to 255
printable ASCII characters in addition to existing identity validation.

Objects must use `Object.prototype`, own enumerable data properties and exact
keys. Custom/null prototypes, inherited shapes, getters/setters, symbols, hidden
properties, sparse arrays, array extensions and unsafe numbers are refused.
Arrays must use `Array.prototype`. Property descriptors are inspected before
reading their values, so ordinary accessors are not invoked. JavaScript proxies
can execute traps and are not an authenticated transport or an isolation boundary.
Both entrypoints normalize reflection exceptions and other unexpected JavaScript
failures to `SIGNED_DERIVATIVE_SHAPE_INVALID`. A private identity brand preserves
only contract-created classified errors; thrown values are never inspected for
their prototype, message or code. This classification does not prevent proxy traps
from executing or undo their effects.
Already-parsed values cannot reveal duplicate JSON keys discarded by `JSON.parse`.
Entitlement map insertion order is normalized; no document canonical encoding or
hashing API is defined.

Failures are `Error` objects with a matching fixed `.message` and `.code`:

- `SIGNED_DERIVATIVE_SCHEMA_INVALID`: wrong or missing declaration schema.
- `SIGNED_DERIVATIVE_SHAPE_INVALID`: malformed declaration/context/input, including
  inconsistent declaration inventories or an invalid existing build identity.
- `SIGNED_DERIVATIVE_RAW_MISMATCH`: disagreement with independent raw expectations.
- `SIGNED_DERIVATIVE_POLICY_MISMATCH`: inventory or signature policy disagreement.
- `SIGNED_DERIVATIVE_OBSERVATION_MISMATCH`: supplied observation disagreement or a
  strict-verification status other than valid.

## Evidence and future integration limits

The module reads no files, discovers no identity, invokes no commands, signs or
notarizes nothing, and grants no installation authority. Tests use symbolic facts
and synthetic byte/hash differences; they supply no Apple or native evidence.
A matching Team or signature presence alone is insufficient. A plist hash cannot
prove that unparsed bytes contain no additional entitlements. A future native
adapter must retain exact plist bytes, parse their complete semantics, and retain
full native verification receipts, certificate validity/trust, architecture and
code-directory evidence, same-object observations and content-change fences.

A future isolated producer must authenticate raw compiler/vendor inputs, copy
exact objects into its own workspace, sign inside out without deep signing, and
fence all object changes. A shell bootstrap cannot become an authenticated Mach-O
compiler input through a declaration. Arbitrary agreeing raw/signed hashes do not
prove a permitted transformation.

Keep this declaration detached: inserting its final app digest into the same app
would create a circular dependency. The only stage is `signed-pre-notarization`.
There are no ticket, stapling, notarized, final ZIP/DMG or installation fields.
Post-notary/stapled bytes require an explicit later stage/version and fresh digest.

Existing unsigned producer/verifier metadata, vendor tree pins, shell launcher,
exact resources and outer contents, raw core-artifact proof, compiled host resource
expectations, archive-helper pins, trusted updater bundle and installed predecessors
all remain integration barriers. A detached document cannot repair stale compiled
raw expectations. Future changes need a Lead-owned build design with separate raw
and derivative ledgers, reviewed package/Release formats and verified preservation
across copy/archive/extraction routes. This contract creates no package schema 8,
second updater, runtime service or release/installation route.

# Current Task settings comparison

The selected desktop settings writer delegates Task authority-change comparison
to Go `app/services/currentsettings` through `contracts/currentsettings` and the
read-only desktop method `task.settings.compare`. This capability does not open
a provider, activate Task lifecycle or register Task tools.

The Electron adapter parses/defaults the existing ProductSettings schema and
transports the complete relevant facts. Go selects matching workspaces, preserves
negative evidence, orders set-like fields and compares the resulting values.
Device/inode identities and generation/revision correlations stay decimal
strings. No clock, settings store or native authority is owned by this service.

Task policy identity comes through a consumer-owned port. Boot maps the existing
model-policy owner's full configured-policy identity, including supported and
unsupported harnesses. Missing and invalid policy retain their distinct existing
classes; selecting only a successful Codex model would miss changes elsewhere.

Facts contain parsed/invalid status, full saved route and Codex host provenance,
Computer identity/generation/workspace evidence, and Computer setup verification,
reachability and outcome-unknown state. UI labels and unrelated settings do not
change the comparison. Duplicate/ambiguous JSON, unknown DTO fields, malformed
Unicode and invalid typed facts refuse; an error never becomes equality. Each
raw fact document is bounded to 1 MiB, depth 128 and 65,536 nodes. The unchanged
desktop frame bound also applies to the enclosing encoded request.

Both ordinary saves and conditional Settings delivery retain the existing
serialized writer. Before persistence, the writer first checks the existing
Computer approval projection and otherwise awaits the Go Task comparison.
Startup persistence before a native publication owner is attached has no serving
authority to withdraw. Once attached, a missing/lost/malformed Go result refuses
without a TypeScript comparison fallback. The previous Task projection is kept
only as a test oracle.

The adapter captures both revisions and fact sets before dispatch and verifies
the original request, profile, backend generation and both echoed revisions.
There is no retry. The writer rechecks its original in-memory source after the
await, keeps exclusion until publication, and preserves the original conditional
deadline and synchronous unknown-effect fences. A pure comparison failure before
storage does not reload old disk bytes over a successor snapshot. Native
withdrawal, persistence, readback and publication retain their existing owners.

Portable evidence includes real inherited-pipe Go parity against the retained
projection vectors, negative/unavailable policy cases, bridge correlation and
writer queue/deadline/fence regressions. It does not establish packaged/installed
Task setup, native authority or provider acceptance. Source eligibility, route
publication, catalogue selection and legacy drain still need separate cutovers.

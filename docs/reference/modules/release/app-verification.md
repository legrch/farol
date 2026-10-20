# Installed-helper verification preparation

The desktop selects the Go apply/recovery/rollback helper entries
(`run-closed-release-helper`, `run-live-release-helper`) with no Python fallback;
`resources/native/update_helper.py` stays in the tree and package as the
behavioural reference until a separate deletion packet. The Go components below
are composed by those entries; they do not by themselves remove the packaged
Python resource. Release's existing journal, update/recovery policy,
admission and one-shot effect owners remain authoritative.

`app/services/helperinput` owns the existing `farol.installed-update/1` request
semantics through a consumer-owned decoder port. `infra/native/helperinput`
performs bounded strict JSON decoding. The 8192-byte envelope preserves accepted
source/target/drain, original PID/start, wait/relaunch and optional closed
predecessor/lease correlations. Invalid Unicode, duplicate keys, coercion and
unknown/null fields refuse. PID is explicitly bounded to the native signed
32-bit range. Structural refusals precede later acceptance checks; parsing alone
grants no process, filesystem, lease or mutation authority.

`infra/native/apptree` borrows a trusted parent and application directory plus
its single leaf name. It opens its own physical no-follow descriptors and
checks named/held identity and metadata before and after reads and after the
identity callback. It preserves borrowed descriptors, offsets, flags, locks and
lifetimes. Callers retain parent/namespace custody; sequential observation is
not an atomic filesystem snapshot or a substitute for an effect-boundary check.

Owned descriptor cleanup is synchronous and checked for directory enumeration, tree descent, document traversal, file reads and the reopened root. A cleanup failure clears the observation and retains both the original failure and cleanup cause behind closed I/O text. Cancellation through actual cleanup return keeps its original cause and absolute deadline. Borrowed descriptors remain open. `IsVerificationRefusal` recognizes only this verifier's exact inspected negative observations and a trusted pure identity-policy refusal; an opaque wrapper, joined cleanup failure or cancellation cannot become a negative match.

The verifier retains the existing v2 digest stream, UTF-16 sibling ordering,
raw name spelling, file modes and root exclusion. Component-wise link resolution
uses only the measured inventory, including intermediate links before `..`;
escaping, dangling, cyclic and root-only targets refuse without following them
in the operating system. Limits are 100,000 entries, 1 GiB file bytes, directory
depth 128, 64 MiB retained names/link text and 4096 bytes per link. Cancellation
and all limit failures refuse. No source copies or installation effects occur.

`infra/native/appidentity.Verify` checks the bounded Info.plist and build-identity
bytes against the existing bundle ID and requested version/build. It performs no
filesystem access or process launch. XML and `bplist00` parsers support the
documented test corpus, including UTF-16 XML, UID/null values, padding, signed
128-bit opaque integers and three-byte offsets/references. This is a bounded
producer subset, not every encoding or extension accepted by Python plistlib.
Custom XML entities, malformed Unicode, duplicate keys, cyclic/overlapping
binary objects, nonfinite values and malformed JSON refuse. Documents are each
at most 65,536 bytes; aggregate node/depth/payload limits also apply.

The mandatory identity callback connects physical tree verification to this
identity verifier. Portable composition fixtures use independent static trees
and digests accepted by the original Python checker. Unit tests never launch
Python; Python used once to generate independent test oracles is build/test-only.
Targeted race/vet/fuzz and Darwin cross-compilation are source evidence only.
Darwin execution, APFS exchange, inherited installed descriptors, exact helper
failure-code mapping, journal/fsync, original-process exit, launch/recovery and
OTA/rollback parity remain NOT RUN or unimplemented until their actual owners
are composed and qualified. Do not delete the Python reference helper on this evidence.

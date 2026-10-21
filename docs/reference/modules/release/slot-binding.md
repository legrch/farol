# Go installed slot-binding publication

Go-aware desktop builds select the existing bundled `farol-backend` for immutable
`farol.installed-operation-slot/1` publication. The owning Release application
service is `modules/release/app/services/slotbinding`; its physical adapter is
`modules/release/infra/native/slotbinding`. No second update journal, updater
controller, profile owner or installation authority is created.

The selected source route is `main.initializeInstalledUpdater` → the existing
installed update runtime → `publishInstalledOperationBinding` →
`farol-backend publish-installed-slot-binding --build-id <compiled identity>` →
the Go Release service and publisher. Boot handles this one-shot mode before
ordinary backend/profile initialization. The compiled build identity must match
before inherited descriptors are consumed.

## Host adapter and resource custody

TypeScript retains Electron composition, canonical request encoding, resource
attestation, pipe/child lifetime ownership and correlation with the existing
update admission. The host selects its independently compiled core declaration;
it never trusts a digest freshly measured from the executable. The existing
installed execution snapshot supplies an accepted private immutable image.
Explicit supervisory composition can supply its separately verified controller
resources. The same core executable verifier checks native format, platform,
size, digest and physical path before launch and after the original child closes.
The image owner must retain immutability through that lifetime.

The original operation directory remains held by the host. Its inherited fd4
copy belongs to the child; the Go native publisher borrows it without closing or
seeking it. Bounded canonical bytes arrive through fd3 with a fixed deadline.
Only the child-owned copies close. The existing host rechecks named operation
and parent identities, enforces its original timeout, and waits for the same
child's actual close even after requesting termination.

No selected Go failure dispatches Python. The old string/helper route is removed:
composition without a compiled Go declaration refuses every update action
(`UPDATE_HELPER_GO_CORE_REQUIRED`) before it could publish a binding. The Python
helper resource is no longer dispatched for publication or apply/recover/rollback,
but it stays in the package manifests under the
[bridge rule](../../../installed-update-helper.md#retiring-the-python-helper-bridge-rule). The
historically named `update-archive.py` is already a Go executable; its suffix is
not interpreter evidence.

## Publication and uncertainty

Go validates the exact canonical bytes, including historical Python JSON Unicode
escaping. It binds private owner/type/inode/link metadata, reads existing bytes
without rewriting a matching inode, and refuses a different immutable binding.
New publication uses one exclusive temporary, bounded complete write, file fsync,
checked close, no-overwrite link, exact-owned temporary removal, directory fsync
and exact readback. Operations stay relative to the borrowed directory.

Before a possible mutation, cancellation can refuse. A failure after possible
mutation remains unknown; that publisher lifetime refuses replay. Cross-process
unknown protection stays with the existing update runtime/admission: it fences
before publication and clears only after the exact success receipt and postflight
checks. Visible bytes, exit requests, timeouts and a generic child failure cannot
clear that fence. This capability does not grant apply, rollback or relaunch.

## Acceptance limits and retirement

Portable Go tests exercise real disposable descriptors, filesystem publication,
faults and canonical values. Host tests exercise actual source selection with
mocked admission/process ports, native-format fixture attestation, malformed or
lost receipts and original-child cleanup. They do not execute an installed app.

macOS filesystem/descriptor behavior, packaged child execution, clean-Mac first
launch, installed update and OTA/rollback remain NOT RUN until separately
qualified in their real environments. The legacy Python publication consumer is
removed: a build without the compiled Go core refuses every update action before
admission, so it never publishes a binding. Removing
`resources/native/update_helper.py` from the package follows the
[bridge rule](../../../installed-update-helper.md#retiring-the-python-helper-bridge-rule).

## Read-only helper slot observation

The existing `slotbinding.Verifier` is a separate helper-side capability, called by the selected Go helper entries (`boot/releasehelperclosed.go`, `boot/releasehelperlive.go`), not by the publisher. It captures request-bound expected bytes and an absolute deadline, borrows the exact operation directory, and compares private parent/file metadata and full bytes through actual synchronous return. It never seeks, closes, unlocks or changes the borrowed directory descriptor. The caller retains named-route custody, authoritative lease, slot and admission; a matching observation supplies no readiness, persistence, install, retry or replay authority. All 13 existing phases, schema and UNKNOWN predicates remain unchanged.

`verify_test.go` uses fresh disposable files and independent directory opens to witness a nonzero directory cursor, status/inheritance flags and flock exclusion across success, refusal and expired read/cleanup return. Controlled read and close seams enter before a fixed absolute deadline and return after it, including native errors joined with deadline causes and a context whose cancellation delivery deliberately lags. Cleanup closes the owned read descriptor once even after expiry; the caller retains borrowed custody until the blocked native/cleanup call actually returns and closes its directory only afterward. Later observations cannot renew the verifier's original deadline. These controlled seams are native-descriptor tests on the executing host, not evidence of an arbitrarily blocked kernel call or whole-helper lifetime composition. Existing `helperlocks/deadline_test.go` remains the owner of lock-gate, callback and original-budget witnesses; this packet does not duplicate that research.

## Independent slot byte oracle

The frozen [slot corpus](../../../../modules/release/infra/native/helperprotocol/testdata/slot-binding-golden.json) pins `resources/native/update_helper.py` at producer commit `bf1d1436990e8f1b230042fd4efe3910738fc78b`, Git blob `8d04fed8baeda480212bd27512df0e835ae228d7`, SHA-256 `9bd3bf1e06984deeae37cdc61c30063d01b466d26a518952c599fba9c1142c02`. `TestSlotBindingOriginalPythonASTGolden` reproduces the entire corpus with development Python and compares it to the checked-in fixture before testing the Go input owner, request-bound codec and canonical constructor predicate. Its embedded script selects only class `Refusal`, constants `MAX_RECORD`/`SLOT_SCHEMA`, and functions `fail`, `slot_binding_bytes`, `canonical_slot_binding`, `verify_slot_binding`, `components`, `valid_inode` and `parse_request`. It imports no helper module and executes no helper entrypoint; fd3 input and slot reads are substituted with in-memory bytes. The fixture records this allowlist and its limits.

The 21 request vectors and 19 canonical vectors preserve full bytes, nested/root key order, ASCII escapes, exactly one trailing newline, shared/explicit legacy/absent location behavior, accepted 1–128-codepoint versions, malformed input and classified refusals. The original Python accepts escaped unpaired UTF-16 in versions; the existing Go request decoder intentionally refuses those inputs before replacement can alter identity. The corpus records both results explicitly, while the existing canonical byte validator preserves historical surrogate bytes. This input-domain difference is not silently normalized or expanded by the tests. Synthetic homes/processes provide no native admission or installed evidence.

The application codec-port tests separately exercise 1/8192/8193-byte results and delivered deadline cancellation. Arbitrary port bytes are not reachable valid slot records: even two 128-astral-codepoint versions produce a bounded record well below 8192 bytes. Invalid records at 8192 and 8193 bytes witness canonical refusal only; they do not establish a reachable valid-request maximum. Native absolute-clock enforcement remains with the native verifier; pure application tests establish delivered-context cancellation only.

Reproduce the source-bound oracle with `go test -race ./modules/release/infra/native/helperprotocol -run '^TestSlotBindingOriginalPythonASTGolden$' -count=1 -v`. Run the complete packet with `go test -race ./modules/release/infra/native/slotbinding ./modules/release/infra/native/helperprotocol ./modules/release/app/services/helperprotocol`, then `go vet` on those same packages, `npm run docs:check` and `git diff --check`, using the repository-declared toolchains and a writable Go build cache. Development Python is required for the oracle only. The desktop runs supported apply/recover/rollback and slot-binding publication through the selected Go helpers with no Python fallback; the Python helper stays in the resources under the [bridge rule](../../../installed-update-helper.md#retiring-the-python-helper-bridge-rule). This corpus alone establishes no package, installation, live-provider or release acceptance.

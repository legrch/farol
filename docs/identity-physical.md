# Native identity relocation boundary

This source slice continues the reviewed pure policy without changing it. It is
not installed migration or startup integration. The Darwin filesystem primitive
has no runtime caller and is tested only with disposable synthetic state. Release owns the consumer port, durable journal and admission semantics;
Core owns the root module and composition.

## Physical operation

The only intended forward effect is a single whole-root rename from the accepted
current-alpha directory to `Farol` under one verified Application Support
parent. Production has bundle `io.github.legrch.farol` and browser partition
`persist:farol`; Dev has separate `Farol Dev`, `io.github.legrch.farol.dev` and
`persist:farol-dev`. Development never relocates production. No browser store is
copied, merged or rewritten. No V0 application is started.

The native seam opens each ancestor with no-follow directory descriptors and
retains them through the operation. Ancestors must belong to root or the current
user and forbid other writers; root-owned sticky temporary namespaces are
permitted before a separately protected fixture root. The final parent and
profile must belong to the current user and forbid group/world writes. Physical
device/inode values remain decimal strings. Descriptors are close-on-exec and
owned by one handle.

Before dispatch, it rechecks every retained namespace binding, the exact source
object and destination absence. It refuses symlinks, a foreign source, any
existing destination and a source on another volume. After external admission
and journal I/O, these facts are checked again. The source descriptor remains
open across one `RenameatxNp` using `RENAME_EXCL | RENAME_NOFOLLOW_ANY`. There is no
replace-capable rename, exchange, cross-volume copy or weaker-flag fallback.

After the syscall, it requires both parent `fsync` and explicit Darwin
`F_FULLFSYNC`, then proves that source is absent and destination is the original
physical object. Full-sync errors are not weakened to ordinary sync. Any syscall
error, later sync failure or ambiguous readback returns outcome-unknown. The
handle consumes its one attempt before admission and never calls rename twice.
Repeated observation is permitted; repeated dispatch is not. Descriptor Close
does not turn a retained possible effect into a proven NoEffect result.

## Release-owned admission and journal

A physical fingerprint or an advisory lock alone does not prove that Chromium,
backend, helper and descendant writers stopped. The sole Release admission guard
must cover both profile names and remain valid through durable intent, dispatch,
sync and readback. It must not recreate a lock pathname or open a second lock
domain after moving the profile.

The consumer must bind one operation to the exact accepted alpha package bytes,
complete build identity, profile object and fixed final identity. A directory
name, bundle label or stale receipt alone is not admission. The native seam does
not implement a package verifier or infer accepted bytes from profile spelling.

The adapter maps Release-owned consumer DTOs explicitly. Release supplies the
atomic single-use claim for the bound operation across its admission domain,
retained beyond Close and unknown results. Every filesystem factory borrows the
same authoritative Release owner. The native adapter consumes that claim but
owns no claim ledger, additional owner or replay database. The durable journal
prevents rearming after a descriptor/backend restart.

Acquisition consumes its factory latch before invoking the claim. An invoked
claim's error, cancellation or lost acknowledgment cannot invoke it again from
that factory. After a successful claim, the adapter rechecks admission, physical
roots and the exact prepared journal before issuing an armed lease. It never
releases the claim after a failed acquisition, Close, refused move or Unknown.
Dispatched, Relocated and Completed acquisitions observe only and do not claim.
The old port without the claim failed three explicit replay regressions; the
frozen replacement closes prearmed, Close-before-dispatch and concurrent-factory
arming using the actual retained Release Service in synthetic composition.

A handle may be armed only by an exact fresh durable `prepared` projection. The
journal owner persists `dispatched` before calling the single physical effect.
A handle acquired after a retained `dispatched` phase may observe only, even if
the source still exists. The adapter never rewrites a journal, erases unknown
work, acknowledges a launch or performs an automatic reverse move. Release
retains relocation observations and owns separately admitted recovery intent.

Post-move root readback is not final layout acceptance. The old local-runtime
and remote-ChatGPT sessions have distinct network policies. Core/Desktop/Release
must verify the accepted session/state layout, retained config/grants and
unresolved operation bindings before completing migration. Old absolute paths,
helper identities and partition/build witnesses are not mass-rewritten.

## Source-name race and durability limits

Darwin rename is name-based. It cannot atomically compare the expected source
inode at the rename boundary. The complete stopped-writer proof and protected
namespace are prerequisites, not conclusions from this primitive. A same-user
writer ignoring admission can race after the last precheck; post-effect readback
then detects uncertainty. This source does not claim hostile same-user isolation.

Successful directory sync/full-sync requests are native evidence, not a
power-loss experiment or recursive flush of an active browser store. Unsupported
filesystems or flags refuse/retain uncertainty without rerouting. Physical
backward recovery, accepted byte-verifier integration, writer-enumeration
coverage and durable journal crash injection remain separate Release gates.

## Frozen source dependency

The consumer port and retained claim service bind to Release commit
`2c5a0286c22e78e513ce9de345322d1f19d3245c` on `release-claim`, based on the
accepted Core K1 `acb131d9e7d483296d4edac262cf881cddfb91bb`:

- `modules/release/app/port/migration.go`, SHA-256
  `347544336a000183add3e1f23d7eae5b36950e9ea331a98f8a7919ad616d0b7c`.
- `modules/release/app/services/migration/admission.go`, SHA-256
  `d6f4fc5c2c2ba9b72ad63dd775a0873ada1c85a569c7afde07f1e1f65073491b`.
- `modules/release/infra/native/state/gate.go`, SHA-256
  `1eb4e154ff44ead25062144abce1364b9135acd159093ae0abde0db5cc3fc1d7`.

The temporary harness points to those committed sources through symlinks. It
checks all consumed source hashes and package Go-file inventories before and
after compilation/tests. No Release/Core source is copied or committed into the
Identity branch. Tests share one actual Release Service and native StateGate
across factories; only the writer/provenance guard and journal projection remain
doubles. A fixture wrapper can lose/cancel a claim acknowledgment after the real
Service has retained it; the wrapper owns no ledger or second admission domain.

This pins a source-only dependency. It is not an accepted Release R4, integrated
native migration, durable production journal or product cutover. The old port at
`9520caae2e7cfdb96b9863b6a4b38eaf9d7be750` is historical RED-regression evidence.
The sole-owned frozen dependency must be integrated before compiling this
adapter in the canonical root suite.

## Offline preparation checks

The current writer is based on the accepted Core K0 source foundation, which
has a root Go module. Its canonical native compilation awaits the combined
accepted Core K1 and Release claim-port base. The temporary source harness does
not replace that integration gate. The native source uses the maintained
`golang.org/x/sys/unix` API; the preparation harness consumes cached `x/sys`
`v0.35.0` (module sum `h1:vz1N37gP5bs89s7He8XuIYXpyY0+QlsKmzipCbUtyxI=`),
matching the accepted Core K1 root dependency. No root upgrade is required.
The earlier preparation probe used v0.47.0; compatibility was re-executed on
the accepted v0.35.0 API before integration.
No module, vendor copy or loader trampoline is added by Identity.

Run the native/domain packages through an isolated temporary GOPATH pointing to
these sources, the exact cached Unix dependency and the frozen Release sources,
with `GO111MODULE=off`,
`GOPROXY=off`, `GOSUMDB=off` and a task-owned Go cache. Run `go test -race -count=1
-cover` and `go vet`. The native package is Darwin-only and also runs with
`CGO_ENABLED=0`; this is not Windows/Linux qualification.

Fixtures preserve opaque configuration, grants, unknown task/update operations,
separate synthetic browser stores, unknown files and an internal symlink. They
compare actual content hashes, modes and physical object identities. Other cases
exercise native no-replace contention, replaced source/ancestors, lost syscall
ACK, sync failure, changed readback, same-handle concurrency and descriptor
closure. A real test-child lock-contender proves that filesystem Close does
not release an externally held admission fixture; that fixture does not prove
complete production writer enumeration. Claim tests cover competing factories, Close, unknown native outcomes, lost
claim acknowledgments, cancellation and changed proof after claim. Ordering tests
use projected-record doubles, not an independent durable journal codec. Fixtures do not certify
installed alpha data or live provider state.

The new physical effect has R4 data-corruption/recovery consequences. General,
Specialist and Strong evidence alone is not a completed R4 gate; a permitted,
qualified non-Astra Frontier must complete before integration acceptance.

## Distribution and installed acceptance

The preparation target for a new first installation is `/Applications/Farol.app`.
Any existing `~/Applications/Farol.app` relocation/adoption remains a separate
one-shot accepted operation. Distribution consumes Release's exact descriptor
and physically measured adoption/baseline receipt; it cannot invent installation
success from copying a bundle or seeing the final profile directory.

Published alpha bytes/manifests/digests remain immutable. This slice performs no
package publication, app installation, live profile access, connector mutation,
profile migration or production launch.

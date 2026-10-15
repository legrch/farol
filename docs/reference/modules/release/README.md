# Release Go preparation

The first source-selected native capability is now the
[Go slot-binding publisher](slot-binding.md) in Go-aware desktop builds. This
does not select the Go updater policy or replace the Python apply/recovery
helper. The preparation history and broader cutover requirements below remain
applicable to those separate capabilities.

This additive module is preparation from accepted base
`1eb30bd23df22c9581d277280f8e0699612786b5`. It does not change the active updater,
installed application, package identity or resource path. The source-only archive transfer is explicitly leased from frozen
`a47c9ccea1a00eb210f675f71a0690fc3be6c857`. The next stage is based on accepted K1
`acb131d9e7d483296d4edac262cf881cddfb91bb`, including the root module and
unchanged archive dependency. Runtime wiring/build closure and fresh source
acceptance are still required before cutover.

## Module documents

- [First install and adoption boundary](adoption.md)
- [Current-alpha journal persistence](journal.md)
- [Migration admission lifetime](migration.md)
- [Native boundary](native.md)
- [Go installed slot-binding publication](slot-binding.md)
- [Inherited handoff custody preparation](handoff-custody.md)
- [Installed-helper verification preparation](app-verification.md)
- [Predecessor process observation preparation](process-observation.md)
- [Installed application namespace preparation](install-namespace.md)
- [Source relocation record](relocation.md)
- [Archive provenance](infra/archive/provenance.md)

`domain/update.go` owns the pure updater policy. `app/services/update` serializes
one lifetime through consumer-owned ports. Domain, application and port DTOs are
independent; the service maps them explicitly. The application performs no native
execution, filesystem, networking or ambient timing. A clock is injected. The
service has no background discovery/restart loop and exports no transport method.

`domain/recovery.go` classifies exact measured physical pairs and process evidence.
It does not mutate directories, clear journals, replay apply, or issue launch.
A preparation assessment still requires a durable pre-mutation exit receipt,
preparation-cleanup transition, confirmed cleanup and archive reverification
before Ready. A launch-requested phase stays outcome unknown; a completed phase
only records the launch command returning, not GUI acceptance.

A settled target with its measured predecessor yields `RollbackAvailable` even
when original-helper exit is unconfirmed, preserving the accepted runtime's
startup observation. An interrupted pair requires confirmed helper exit before
`ExplicitRecovery`. Neither assessment authorizes dispatch. Explicit restoration
must acquire the real native admission lease, reverify the retained operation and
record its own durable intent; a lease held by the original helper stays held.
See `src/apps/desktop/installed-update-runtime.ts` (settled startup classification
and `restore`) and `docs/installed-update-runtime.md`. The paired domain regression
and service admission-refusal test keep observation separate from effect authority;
they do not qualify a native adapter.

## Preserved lifecycle behavior

- Recovery observes retained state; it never downloads or dispatches a helper.
- Ready requires verified bytes and confirmed durable retention. Later changes
  presentation only. Apply stays blocked until an explicit check clears one of
  the active updater's six known transient admission blockers without another
  download. Unknown and unclassified blockers remain retained. Every subsequent
  apply must reacquire native admission.
- Readiness ACK is not installed success. Accepted/unknown handoff prevents
  further dispatch in that lifetime; malformed results are unknown.
- A known discovery failure preserves independently measured local rollback.
  Uncertain staging/retention or restore handoff removes that action and fences
  additional work. Raw adapter error text never becomes a presentation error.
- Close cancels only network requests and waits for the issued durable operation.
  A completed verified download still reaches Retain after Close. Caller wait
  expiry returns uncertainty; it cannot claim cleanup or helper termination.
  Retain owns its original bounded native budget, never a refreshed hop deadline.
- Helper absence requires exact recorded PID/process-start observation. A null
  original start cannot settle a present PID; absence alone without a recorded
  helper proves nothing. Unknown and permission errors remain blocked.

`domain/testdata/recovery.json` contains symbolic, independent crash vectors;
`app/services/update/service_test.go` uses policy doubles. Neither supplies native
filesystem/process, package, GitHub, provider or installed acceptance evidence.
Restore-intent clearing, rejected-target inode receipts, durable journal publication
and current-alpha physical state migration remain native parity work after handoff.

## Leased source additions

`infra/archive` retains the frozen bounded Go extractor and all its regression
vectors after declared mechanical edits. Its [provenance](infra/archive/provenance.md)
records source hashes and the unchanged dependency baseline. The old active
resource/consumer route stays with Core/Lead until integrated parity and retirement.

`infra/repos/records` decodes existing current-alpha update journal, retained,
receipt, restore, download and rejected-target records; only the existing helper
journal has an encoder. All 77 independent record vectors agree with the frozen
TS closed schemas plus exact operation binding. Parsing/encoding does not read a
live profile, verify a package, acquire a lease, persist an intent or settle a child.
Malformed UTF-8/unpaired UTF-16 escapes are refused rather than silently replacing
identity bytes. The existing TS schemas' optional/null and UTF-16 string bounds
remain explicit. Promotion/closed-repair receipts and physical file access are
still later parity work.

The consuming [migration port](../../../../modules/release/app/port/migration.go) supplies a read-only durable
projection and an externally held authoritative admission guard to the leased
Identity adapter. Release owns its serializer/intent/dispatch/recovery. See the
[native boundary](native.md) and [first-install/adoption contract](adoption.md).
The corrected [migration admission lifetime](migration.md) owns one atomic claim
across all consumers of a bound operation. The older per-handle-only port is not
accepted for physical composition. These additions have no production caller or
new Desktop wire schema.

## Current parity seams

| Current owner/source                                                | Prepared destination and remaining deletion exit                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/release/app/installed-updater.ts`                      | `domain/update.go` + `app/services/update`; preserve status/check/later/restart/recover/rollback and Close cases. Core must map the existing restart intention to Apply through its accepted generated bridge before the TS controller leaves the active route. |
| `src/apps/desktop/installed-update-runtime.ts`                      | Native journal/retention, work-admission and crash adapters remain pending. Current ready/download/restore/receipt schemas, durable write windows and same-child evidence must pass physical disposable parity before removing this slice.                      |
| `resources/native/update_helper.py`                                 | Go install/exchange/restore implementation remains pending. Preserve no-follow descriptors, exact accepted pair, lease, normal Quit ACK, atomic swap and one-shot launch journal; native/package parity precedes deletion.                                      |
| `src/modules/release/app/github-release.ts` + domain release policy | Discovery/eligibility/manifest compatibility remain pending. Keep the current alpha version/build ordering, provenance, bounded download and reverified-package cases.                                                                                          |

Preparation's policy doubles correspond to existing
`tests/unit/installed-updater.test.ts` intentions; its symbolic crash vectors
retain journal phase names without defining a new persisted record format.
`domain/recovery.go` is a conservative common subset, not full helper/runtime
parity: restore-intent clearing and rejected-target inode evidence remain gated.

## Transitional checks

Core owns the single root `github.com/legrch/farol` module. No private Release
`go.mod`, CLI, protocol or process implementation is introduced. Before K0, preparation tests ran through a disposable GOPATH checkout link:

```sh
release_gopath="$(mktemp -d "${TMPDIR:-/tmp}/farol-release-tests.XXXXXX")"
mkdir -p "$release_gopath/src/github.com/legrch"
ln -s "$PWD" "$release_gopath/src/github.com/legrch/farol"
GO111MODULE=off GOPATH="$release_gopath" GOCACHE="$release_gopath/cache" \
  go test -race github.com/legrch/farol/modules/release/domain \
  github.com/legrch/farol/modules/release/app/services/update
```

The accepted K1 stage now uses `go test -race ./modules/release/...`,
`go vet ./modules/release/...` and `task test:core`. Both root and
`resources/native/go` suites remain explicit until old archive resource retirement.
The existing `task ci:fast` remains required; its pre-K0 execution did not discover
these new Go packages.

## Integration boundaries

Core/Lead own root module, boot, command routing, generated wire/client, common
build/config/resources and test discovery. Release proposes the exact patches
in `relocation.md`; it does not concurrently edit them. Desktop's native browser
and work admission remain effect-owning ports; an idle UI is never permission.
Identity's dedicated `domain/migration` subtree is excluded from this writer.

Distribution's first-install executable binding is pending. Its future narrow
contract must bind operation ID, fixed destination/profile from accepted identity,
full verified package identity and freshly measured installed tree to a baseline
receipt. Outcomes distinguish installed, confirmed pre-effect refusal and
outcome unknown. Observe by the same operation ID; do not repeat or implement a
second copy/swap/verify backend. Manual drag-install is not an accepted baseline
until Release measures and durably binds the installed package. These are contract
requirements, not a currently available command.

Current-alpha native journal persistence and its evidence limits are described in
[journal.md](journal.md). Its borrowed admission is not wired to the active runtime.

# Release Go preparation

This additive module is preparation from accepted base
`1eb30bd23df22c9581d277280f8e0699612786b5`. It does not change the active updater,
installed application, package identity or resource path. Archive ownership and
shared Core K0/build integration are still required before runtime cutover.

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

## Preserved lifecycle behavior

- Recovery observes retained state; it never downloads or dispatches a helper.
- Ready requires verified bytes and confirmed durable retention. Later changes
  presentation only. An explicit check clears a known admission blocker without
  another download, and every subsequent apply must reacquire native admission.
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
Restore-intent clearing, rejected-target inode receipts, journal encoding and
current-alpha physical state migration remain native parity work after handoff.

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
`go.mod`, CLI, protocol or process implementation is introduced. Before K0, tests
can run against these files through a disposable GOPATH checkout link:

```sh
release_gopath="$(mktemp -d "${TMPDIR:-/tmp}/farol-release-tests.XXXXXX")"
mkdir -p "$release_gopath/src/github.com/legrch"
ln -s "$PWD" "$release_gopath/src/github.com/legrch/farol"
GO111MODULE=off GOPATH="$release_gopath" GOCACHE="$release_gopath/cache" \
  go test -race github.com/legrch/farol/modules/release/domain \
  github.com/legrch/farol/modules/release/app/services/update
```

This is temporary compiler/unit evidence, not the final root-module gate. After
K0 integration, use the root Go suite and keep `resources/native/go` explicitly
covered until its archive transfer completes. The existing `task ci:fast` remains
required; it does not discover these new Go packages in the pre-K0 base.

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

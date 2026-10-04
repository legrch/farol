# Desktop/Core checkpoint K0

K0 is an additive backend foundation. The installed Electron application still uses its existing backend. Only the trusted host imports `apps/desktop/bridge/client.ts`; React and remote pages do not receive this client or its pipe.

The accepted Go migration layout places the Core-owned host client, framed decoder and generated TypeScript wire under `apps/desktop/bridge`. This is the explicit migration exception to the legacy `src/` source layout. `tooling/tsconfig.desktop-core.json` makes these modules direct strict compiler roots, independently of test imports. Desktop owns the trusted Electron host integration point and its frontend directory move; K0 supplies the importable client and disposable process witness. Lead owns reconciliation of repository-wide layout instructions during integration.

Run `go build ./cmd/farol`, then `farol serve --profile <id>`. The build owns `boot.BuildID`, set with `-ldflags "-X github.com/legrch/farol/boot.BuildID=<accepted-build-id>"`; development defaults to `development`. The host launches the exact accepted executable with inherited stdin/stdout pipes. Each process generates a fresh 128-bit random incarnation. The Go serve API owns closable input/output pipes and closes both exactly once on every terminal return; context cancellation closes those exact endpoints to interrupt idle reads and blocked writes, and passes the same context to the module handler. Module journals still decide OS/provider cancellation outcomes. The CLI lifetime follows its inherited pipes. K0 does not implement an endpoint discovery service, global per-profile lock, app installation, automatic restart, or MCP socket attachment.

## Normal startup and empty-profile reopen candidate

The local candidate at source `c1d67c072edb72c2d36d46e83474c868612e6b34`
was built with `task package` and declared Go inputs on 4 October 2026. Its build ID
is `478c020d323b1ec0114e1b38a2270f9ddedf83109706b8c030db4d42f0eab17b`;
artifact SHA-256 is
`4e1099c9f91ed84659e31b80bd00505d083114a40745635fda0c3dfa1c88000c`.
It remains unsigned `local.farol.next.preview`, version `0.1.9-owner.beta.1`,
build `11`. These are local candidate facts, not a release or installation.

`tests/e2e/go-core-startup.e2e.mjs --run-native --reopen` exercised the actual
packaged `main.cjs`, React Home, a Computer name change with no workspace grant,
Settings/Graphite, and two confirmed ordinary Quits around a same-profile reopen.
The independent snapshots retained the same profile and physical root identity,
Computer identity and Appearance; the second Go lifetime had a new backend
generation. All test-owned windows were hidden and unfocused. The controlled
site counted zero attempted and accepted provider Sends. The successful disposable
profile was cleaned; the receipt retains its identity, journal and handoff witnesses.

Evidence is retained locally as
`_output/evidence/go-core-startup-f9ff846d-903c-4aeb-b2fb-755933b7fb19.json`.
The harness has 114 browser-free self-checks. `tests/integration/go-core-startup.test.ts`
covers actual Go-host process lifetimes and post-connect startup abort. The frozen
`4c88e84` aggregate passed 7,038 main tests, 125 renderer tests and the Go core gate;
the subsequent narrow abort correction at `c1d67c0` passed 37 host unit tests,
three real-host tests, strict typechecking and an independent targeted recheck.
This reuses unchanged aggregate evidence; it does not claim a new full aggregate
or full-range formal acceptance at `c1d67c0`.

A fresh empty workspace projection now leaves the acknowledged Go authority
withdrawal in place. It does not publish an invalid empty approval or weaken Go
validation. Normal Quit captures the actual live owner's retirement receipt,
acknowledges it, observes the original child's unforced normal terminal event,
and uses an attested narrow recorder. A successor needs that exact handoff and
an independent host drain witness. Late/unknown publication and forced or
unconfirmed closure cannot become a clean successor. Failure after browser
connection uses `abortStartup()` and never publishes retirement.

That candidate accepted **only the same build and an empty Chat registry**;
the newer read/Discard milestone below extends this bounded successor path. Go result bodies remain in memory within one backend lifetime.
Provider-used turns, retained-result recovery across restart, cross-build update,
installation and live-provider compatibility remain unqualified. Transitional
TypeScript policy outside the newer read/Discard slice remains active. Production Go browser control
translations are not qualified. The older K0/K1 sections below describe their
original lower evidence boundaries, not these later packaged claims.

## Go read-preview, Discard and same-profile reopen

Packaged source `f1186ae5dd6e1b52cd79cfa264458cbb0b7594e4` passed the normal-main
read/Discard/reopen journey on 4 October 2026. Build ID:
`453fac7026dcb72b2552c0af344f61ec058aa6656598394c27f175e6a2362e44`.
Artifact SHA-256:
`671d2157a0e1257bd53e366854b0f0e46b0397389e706d451f42dcdc058909fe`.
The package retains the preview identity/version above. No installation or live
provider qualification occurred.

The exact harness at `e630195b5d71efe78e09b3130c32bc7ade999524` used
`tests/e2e/go-core-startup.e2e.mjs --run-native --reopen --read-discard`, with
explicit package, metadata, source, build and artifact pins. It exercised ordinary
preload configuration commands and the real Go child. A disposable multibyte file
produced a preview of 92 bytes and 74 UTF-16 characters. Duplicate prepare returned
the same operation and unchanged journals. Explicit Discard committed the exact
Go `admit → cancel → acknowledge` history; a second Discard added no writes.

Two ordinary Quits observed exit code 0, no signal, confirmed drain and removal of
the run marker. Between them, the same profile and physical roots reopened with
a new Go backend generation and an empty successor registry. Computer settings,
workspace identity and Graphite were retained. All windows remained hidden and
unfocused. The controlled site independently counted zero attempted and accepted
Sends. The successful disposable profile was cleaned after the final Quit.

The retained local report is
`_output/evidence/go-core-startup-e4cc62f3-688b-4d66-b309-d3dd32426c09.json`.
Two earlier harness attempts remain failed: one observed the lazy Browser before
opening it; the other assumed fresh Home on configured-profile reopen. Their
profiles and reports were preserved, not retried or relabelled as passes.
Production bytes did not change during those harness corrections.

The source gate at `bcde314` passed 7,079 main tests, 125 renderer tests, Go
race/vet, generated/import/type checks, Hunt and secret scans. The subsequent
handoff-size fix passed its pure/race/vet and native repository checks, plus a
narrow independent recheck. Eight cancellations and a receipt near the byte bound
now complete all four handoff stages; both regressions failed against the former
16 KiB codec. `RetirementWrite` is bounded to 1 MiB with a separate 32 KiB reserve
for later-stage metadata. The original live-owner receipt, host ACK, exact
unforced child terminal and independent host drain remain mandatory.

This is a scoped packaged witness, not whole-range cutover acceptance. In that
f118 package, workspace verification still uses the legacy listing helper; the
newer Settings milestone below replaces those calls. The
preview exposes path/bytes/character counts, not a content hash. The controlled
page proves readiness only, not a real account or model selection. Normal Go Send
is explicitly unavailable until a legitimate provider/control-profile producer
is qualified; a Go-owned preview cannot fall through to legacy Send. Provider-used
retirement, cross-build recovery and result-body persistence remain open.

The current regression map keeps lower and higher boundaries separate:

| Case                         | Executable evidence                                                                                                                                                                                           | Layer and scope                                                                                                      | Remaining boundary                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| C06 useful output            | `TestReadIntentPromotionRetainsActualOwnerThroughUsefulResultAndFollow` in `modules/chat/app/services/lifecycle/readintent_test.go`; `TestReadIntentSameOwnerPromotionAndFollow` in `boot/readintent_test.go` | Real Go owners with controlled ports; useful output, retained result and same-conversation follow-up                 | Normal provider browser and selected Responses client                                   |
| C07 independent expectations | `tests/e2e/fixtures/go-read-discard-witness.mjs` self-tests plus the pinned packaged harness above                                                                                                            | Independently observed journals, preview metadata and physical Send ledger                                           | Duplicate actual Send/browser-generation sensitivity belongs to the Send journey        |
| C08 policy ownership         | `TestReadIntentFramedReadPromotionAndWithdrawal` in `boot/readintent_test.go`; packaged read/Discard above                                                                                                    | Framed Go composition and actual normal host/Go lifecycle                                                            | Full browser-used queue/cancel/release journey                                          |
| C12 one active owner         | `TestReadIntentRevokedDuringVerifyNeverPhysicallySends` in `boot/readintent_test.go`; no-fallback branch in normal preview and packaged Go journal witness                                                    | Ingress/direct-handle revocation test; final guard removal fails owning regressions; normal read succeeds through Go | Other Computer mutations and explicit legacy-build implementation have not been retired |

These rows map only the current slice. They do not mark the complete C01–C12,
M01–M12 or React R01–R45 obligations accepted. Local native execution also does
not prove containment across every browser, Node, Go and child-process network
path.

## Owner Settings listing through Go

Package and harness source `9671a21d8c359e6dbd5725c48ac6dcf7302b2a77` passed
normal production startup, Settings Verify / Check folder / List folder, and
the read-preview / Discard / Quit / same-profile reopen journey above. Build ID:
`b7440f0e470ab0d166c4a8891fd23674c288344affd156cdc8294da82dbcc560`;
artifact SHA-256:
`69db6c53cbe3a9fde30433cd5f92021af90890292ae6844f01db8a105db2f626`.
The unsigned preview identity and version are unchanged. The package is preserved
separately from f118; neither is a new installed or published release.

All three normal Settings handlers call `computer.settings.list`. The Go app
service obtains current owner approval from the same native Computer store,
checks the exact publication and physical directory identity, applies exclusions
and bounded entry validation, and rechecks authority before disclosure. A fixed
15-second lease is not extended by repeated callbacks. No synthetic Chat Turn,
Task or participant supplies owner Settings access. The wire handler allows
withdrawal to complete while native listing is pending. A refused, malformed or
unknown Go response does not invoke a TypeScript listing fallback.

The exact packaged witness used ordinary preload configuration commands. It
observed the Computer store, Chat journal and physical roots independently before
and after each command: zero retained participants and zero Chat writes until the
subsequent real read-intent admission. Verification advanced the approval revision
without changing its generation or scope. The returned list contained only the
synthetic canary; built-in exclusions hid `.ssh` and `.env`. Both ordinary Quits
had exact exit 0, no signal, confirmed drain and removed run markers. The fixture
recorded zero attempted/accepted provider Sends. All windows stayed hidden and
unfocused; the successful disposable profile was removed after known cleanup.

Local evidence is
`_output/evidence/go-core-startup-f65297f4-50ac-402a-9032-3a0e1f8ba940.json`.
The harness has 723 browser-free checks. On the exact source, `task ci:fast`
passed 7,100 main tests, 125 renderer tests, 164 protocol tests, root and nested
Go race/vet, generated/import/type/style/Hunt/output and secret checks. Independent
source review closed two Settings findings after their regression-backed fixes;
this is not formal acceptance of the complete outstanding migration range.

| Obligation                               | Executable evidence                                                                                                                                                                                                              | Boundary and remaining witness                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C08/C12 owner policy and normal Go route | `TestSettingsListUsesPublishedOwnerWithoutChatAdmission` and `TestSettingsListWireWithdrawalWhileNativeWaits` in `boot/computersettings_test.go`; exact package above                                                            | Real framed Go owner plus normal packaged host. Removing concurrent dispatch makes the withdrawal test fail. Other Computer operations remain separate cutovers.                                             |
| Final current authority                  | `TestFinalWithdrawalAndPolicyChanges` in `modules/computer/app/services/settingsworkspace/service_test.go`; `discards a completed listing if host withdrawal crossed its response` in `tests/unit/go-computer-authority.test.ts` | Pure app and host boundary; omission of the final owner callback fails the owning regressions. Native withdrawal during a packaged List remains a higher-boundary witness.                                   |
| C07 independent expectations             | `tests/e2e/lib/computer-settings-witness.mjs` plus exact packaged report above                                                                                                                                                   | Independently read durable state, physical roots and fixture ledger. No transient admission counter or reply-level executor attestation is claimed; source mapping and package identity establish the route. |

Root selection/measurement, Git metadata discovery and configuration persistence
remain temporary TypeScript. Older unbound folders require explicit binding before
inspection; binding alone never records successful verification. This witness
does not qualify custom exclusions, direct denied reads, edits, shell/Git, live
provider admission or complete network containment. React Chat still lacks a Send
surface, and the normal Go Send path deliberately refuses until its legitimate
account/model/control-profile producer is qualified.

## React guarded edit and retained Go result

Packaged source `04f4f2ad378c0dfb2489134f0b6fc6c47f179508` passed the normal
React/Go guarded-edit journey on 4 October 2026. Build ID:
`64bf86ec797b207f85c59c5ee20e77a2c949b02a7c1f83d702d684c1df7d8924`.
Artifact SHA-256:
`39e9f112046092e1982cd9b540444ed1a243b5dabcb6240034b5c68c1ff404cf`.
It remains unsigned `local.farol.next.preview`, version `0.1.10-owner.beta.1`,
build `12`. It is a local candidate, separate from the installed access hotfix;
no installation, release or live-provider qualification is claimed.

Harness `a4fb1a98f41f6df54c4bf0605a5251859bbe149d` used the existing startup
fixture with `--run-native --reopen --settings-edit-mutation` and exact
package/source/build/artifact pins. Normal configuration granted and verified a
disposable write workspace. Actual React **Prepare edit…**, **Old text**,
**New text** and **Apply edit** controls performed one unique replacement.
Independent reads found 94 resulting bytes, the expected before/after hashes,
and exactly one canonical owner-v2 record. There was no synthetic Task,
participant, Chat turn or legacy TS mutation record. A duplicate of the known
successful operation was refused without another file or journal change.

The first ordinary Quit deliberately left result delivery pending. The same
package and physical profile reopened with a new Go generation, retaining the
original operation, workspace, path, generation and before hash. Actual UI
**Observe existing edit** and a normal read-only observation returned that exact
retained receipt. One React **Record result delivery** click removed the notice,
cleared pending delivery and advanced configuration revision once. File and
mutation journal stayed unchanged after observation, ACK and both Quits. Both
original child processes exited normally with code 0, no signal, confirmed drain
and removed run markers. Every test-owned window stayed hidden and unfocused;
the independent site ledger counted zero attempted and accepted provider Sends.
The successful disposable profile was removed only after confirmed cleanup.

The local report is
`_output/evidence/go-core-startup-080e3a8a-e8fc-44eb-9c4b-2e860bfd1d21.json`.
Its packaged source and harness source are separate identities. The harness has
945 browser-free checks, including 105 mutation checks. Frozen source `d11984a`
passed `task ci:fast`: 7,491 main tests, 253 renderer tests, 164 protocol/architecture
checks and the Go race/vet/static gates. The subsequent narrow transport fix
passed 81 affected tests, strict TS/lint/format and independent source recheck.
Removing its prewrite proof caused the owning regression to fail; restored bytes
passed. These are scoped checks, not formal acceptance of the complete cutover range.

Go owns native edit execution and retained observation. New native profile/2
provisions its isolated mutation journal. Existing profile/1 is not migrated and
cannot silently enable the writer. An unknown or memory-only mutation prevents
clean retirement; a durable terminal result may survive a clean same-build
restart before UI delivery is acknowledged. The operation identity remains
consumed. A proven local transport refusal before dispatch preserves verification;
a missing record after an uncertain response or new host lifetime is insufficient
to infer non-admission. There is no error fallback from Go to TS execution.

**Pending delivery and ACK policy still belong to the temporary TS configuration
service.** Historical pending records still need their reader. This witness does not qualify Go ACK,
legacy-profile migration, cross-build update, all conflict/revocation/failure paths,
create/write/shell/Git journeys, native focus or hermetic network containment.
Normal Chat Send still requires qualified model/control composition.

| Obligation                                   | Executable evidence                                                                                                            | Exact layer                                                                                | Remaining boundary                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Exact-hash edit and retained receipt         | `TestNativeSettingsMutation*` in `boot/settingsmutationnative_test.go`; `mutationEffectWitness` and `--settings-edit-mutation` | Native Go module plus this exact packaged React/Go happy path                              | Packaged conflict, revocation and uncertain publication witnesses |
| No repeated edit after transport uncertainty | `tests/unit/go-settings-mutation.test.ts`; `tests/unit/core-host-context.test.ts`                                              | Closed transport and serialized in-memory pipes; branded-proof sensitivity failure         | Broader native timeout/cancel/reconnect matrix                    |
| Result retention versus UI delivery          | `mutationReplyWitness`, `mutationUiAckWitness`, `mutationTerminalWitness` in `tests/e2e/lib/settings-mutation-witness.mjs`     | Same-package ordinary Quit/reopen and actual UI ACK; independent file/journal/config reads | Go-owned pending/ACK and cross-build recovery                     |
| C07 independent expectations, partial        | `mutationEffectWitness` self-tests reject changed identity, hash, journal, duplicate records and fabricated task metadata      | Browser-free oracle sensitivity plus independently read packaged facts                     | Provider generation/DOM variants remain separate                  |
| C12 one active owner, partial                | Normal source-selected Go Apply/Observe, host no-fallback tests and no TS record in this packaged witness                      | Source/transport plus normal packaged Go route                                             | Go-owned delivery policy and remaining shared Computer routes     |

### Retired Settings TS execution

Source `1279490f85c1a0faef3e3f0837010a7c15eb6afe` removes the former Settings
Task/participant executor and the unused TS edit-snapshot adapter. Prepare and
Apply require the normal Go owner, including in development; a build without
that owner refuses them. This does not remove the shared TS/Python Computer MCP
route, which still has production consumers.

The same React edit, unacknowledged Quit, same-profile reopen, retained Observe
and UI ACK journey passed again on that exact source and package:

- Build: `0d409da67a9a3cc0082b4d42942b2250bb25fcfe4eb6655d1fd30488dd227c6d`.
- Artifact SHA-256: `9783ab190c21613389c1be0122ba17ccd5dd9b2751650c37456569cc306e221e`.
- Local report: `_output/evidence/go-core-startup-9b38ece4-40b7-4ea6-89c3-0ebc2a909f80.json`.

There was one measured edit, one owner-v2 record, zero attempted/accepted provider
Sends, two confirmed normal exits and no extra file/journal change after
observation or ACK. Every test-owned window stayed hidden and unfocused. The
successful disposable profile was removed after confirmed cleanup. Package
`04f4f2a` remains separately preserved; neither package is installed or released.

The historical v1 reader uses existing-only, bounded reads. It never creates a
missing directory, repairs permissions or sweeps an uncertain temporary file.
Unsafe records and detected changes return unavailable. The focused legacy tests
cover symlink, hardlink, FIFO and mode refusal, unchanged receipts and temporary
publication preservation. Restoring the old effectful `load` makes four
preservation regressions fail; restoring the corrected bytes passes. Absence of a
historical record still does not independently prove that no old effect occurred;
concurrent directory swaps are not native-qualified by these static fixtures.

Frozen `1279490` passed `task ci:fast` (7,508 main tests, 253 renderer tests,
164 protocol/architecture checks and Go race/vet/static gates). The focused
retirement checks and narrow independent source review also passed. C12's
Settings execution-alternative removal is closed at this package boundary;
Go-owned delivery policy, the shared Computer routes and the complete cutover
review remain open.

## Owner Settings edit snapshot through Go

Packaged source `f398f9c15b7960351057b7647ebb055820f05d4d` passed the normal
host/Go edit-snapshot path on 4 October 2026. Build ID:
`df54f25d1653527c9f81430165b3a89aeb1602fdee098169c41966964eddbc1a`.
Artifact SHA-256:
`95b7829b5d6a743877d3e4e299afd26f34ed9e486bcd13b5c23e2eb4eecb7e59`.
It is unsigned `local.farol.next.preview`, version `0.1.10-owner.beta.1`, build
`12`. Matching version metadata does not make it the separately installed access
hotfix from source `569bd4d`. This React/Go package was neither installed nor released.

The source-selected `computer.settings.snapshot` route performs one full Go
native read under the current owner approval, with a fixed lease of at most
15 seconds and final publication/policy checks. Its closed reply contains only
root identity, relative path, raw byte count and SHA-256. It admits no Chat task
or participant. Normal `computer.prepare-workspace-edit` uses this route in
Go builds and refuses on failure without selecting the legacy reader. Full
snapshots are bounded to 256 KiB; larger files are refused, never silently paged
or truncated. The native digest includes any initial UTF-8 BOM and line endings.

Harness `0d4296d1bc9149aea143f43b4af26d7cc1ca0bd4` adds `--edit-snapshot` to
`tests/e2e/go-core-startup.e2e.mjs --run-native --reopen --read-discard --read-account`,
with exact source/build/artifact pins. It uses the existing disposable UTF-8 canary
and controlled site. Ordinary configuration commands grant write access, verify
the folder, prepare the snapshot and cancel that exact preview. Independent file
reads confirm 92 unchanged raw bytes and digest
`d5316fef7f10cd316d10cffc1c85f80e5860b7e8559b3ef0ae52eee40a409ed6`.
The retained profile/root/generation, participant map and Chat journal remain
consistent. The harness then restores read access, verifies it and completes the
React account/Discard/reopen journey described below, with account GETs exactly
0 → 1 → 2 and zero attempted/accepted Sends. Both ordinary Quits observed exit0,
no signal, confirmed drain and run-marker removal. All windows stayed hidden and
unfocused. The successful disposable profile was removed after the final Quit.

The local receipt is
`_output/evidence/go-core-startup-ef4e9538-314f-4141-8dbc-ce322a7297a9.json`,
profile `9ceba890-b317-4c63-ade0-28292ea745a8`. The exact package and an independently
digest-checked copy are retained separately from the earlier account candidate.
The witness uses normal preload `configure` for the edit commands: React currently
has no Prepare/edit/Cancel controls. Executor origin is bound to the packaged
source; it is not an independent Go RPC counter. Apply, observe and ACK still use
the temporary TypeScript/Python path. Native BOM, size-bound, denied/revoked and
conflict cases are not established by this particular packaged witness. This is
not full Go mutation, installed workflow, live account or provider-Send acceptance.

Frozen source `d232b72` passed `task ci:fast`: 7,450 main tests, 169 React tests,
164 core protocol tests, Go root/nested race and vet, generated/import/type/lint,
Hunt and secret gates. The subsequent main convergence changes only three version
metadata files; 49 affected metadata tests pass and the full dependency graph is
unchanged. The policy fix already matched accepted main byte-for-byte; its existing
Go-adapted regression was preserved. The harness has 838 browser-free checks,
including 68 snapshot checks. Independent bounded source review found no actionable
defects in the snapshot cutover; full-range formal acceptance remains open.

| Required boundary                      | Executable evidence                                                                                                                                                              | Layer and remaining witness                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full metadata and no Chat admission    | `TestSettingsSnapshotUsesPublishedOwnerWithoutChatOrText` in `boot/computersettingssnapshot_test.go`; `settingsSnapshotWitness` in `tests/e2e/lib/settings-snapshot-witness.mjs` | Injected composition plus exact packaged physical file/hash observations; native size/BOM edges remain separate.                                                     |
| Current authority before disclosure    | `TestSettingsSnapshotFinalCurrentGuard` and `TestSettingsSnapshotWireWithdrawalWhileNativeWaits` in `boot/computersettingssnapshot_test.go`; app snapshot policy tests           | Pure/framed Go owner evidence; removing the final app authority gate caused 13 owning regressions to fail. Real mid-read revocation is not this package witness.     |
| Exact host correlation and no fallback | `tests/unit/go-computer-authority.test.ts` and `tests/unit/go-workspace-snapshot.test.ts`                                                                                        | Closed request/backend/publication/workspace/root/generation checks, one request, no legacy dispatch.                                                                |
| Normal Prepare/Cancel/reopen           | Opt-in `--edit-snapshot --read-account` with the pinned package/harness above                                                                                                    | Packaged preload + real Go/file system and React account controls. This older snapshot-only witness does not cover Apply; the newer guarded-edit witness above does. |

## React read-preview and explicit account confirmation

Package `ac580aa026f9c126297e461a349461067177e30e` passed the normal production
main/React account journey on 4 October 2026. Build ID:
`920503234237bc2930ef24ec466649cff51d4aafd5c8ac8da5b61e6d0052af1f`;
artifact SHA-256:
`c17a0f1b822a7b842ccfc3a4b4ff72fb627207868e482164f3e86967e47a08e1`.
It retains the unsigned preview identity, version `0.1.9-owner.beta.1`, build
`11`. The package is preserved independently of the older milestones above.

The exact harness `dc45d27c4dc5555195d6487ee2fe97ec7581a7ec` ran
`tests/e2e/go-core-startup.e2e.mjs --run-native --reopen --read-discard --read-account`
with explicit source/build/artifact pins. The account mode uses the existing
controlled loopback site and a synthetic session endpoint. After ordinary
preload workspace setup, an explicit Diagnostics refresh updates the React
controller. The subsequent Choose file, Inspect current account, Use this
account and Discard actions are real React controls. Navigation remounts and
same-revision refresh retain the exact preview and confirmation receipt.

The independently counted session reads were exactly `0 → 1 → 2`: one inspection
and one fresh observation before confirmation. Known duplicate inspection and
confirmation commands added no reads; navigation added no account effects.
Confirmation calls the original Go read-intent approval and retains its private
grant in Go. No raw account ID, session, principal key or approval handle enters
the UI. The UI displays safe preview metadata and correlated confirmation state.
There is no independent native Go approval-RPC counter: no reapproval is supported
by these read counts together with the pinned host's cached-command contract,
not by unchanged journal bytes alone.

Exact Discard, normal Quit, same-profile/build reopen with retained settings and
Graphite, then another normal Quit all passed. Both Go lifetimes exited 0 without
a signal, with confirmed drain and removed run markers. All windows were hidden
and unfocused; the owner guard passed. The fixture counted zero attempted and
accepted Sends throughout. The successful disposable profile was removed after
known cleanup. The local report is
`_output/evidence/go-core-startup-0ec68aa1-b329-4122-8dc9-eb74e938f1c1.json`.

Two earlier account harness runs stopped before inspection. The first matched
the entire wrapping label including option text; the second had not refreshed
the controller after preload setup. Both reached ready and had confirmed clean
Quits with zero account reads/Sends. Their reports and profiles remain preserved;
each corrected run used a fresh profile. Only harness code changed between these
runs; the selected package remained identical.

The frozen source gate at `93c8cc8` passed 7,422 main tests (four skipped, two
todo), 163 renderer tests, 164 protocol/architecture tests, Go race/vet and the
static gates. Narrow reviewed UI fixes were followed by 169 renderer and 329
related unit tests under Node 26.7.0. The final harness has 770 browser-free checks.
These reuse unchanged aggregate coverage; they do not claim a new full aggregate
or formal acceptance of the entire outstanding cutover range.

This witness does not qualify a live signed-in account, entitlement, an atomic
provider/account binding, a production model/control mapping, useful streaming
or a Chat Send. Normal Go Send still refuses until that composition is qualified.
Window receipts survive component remounts, not host restarts. Provider-used turn
retirement, persisted result bodies and cross-build recovery remain open.

| Obligation                                   | Executable evidence                                                                                                                                                                                                                                              | Boundary and remaining witness                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M03 current account approval                 | `separates inspection, explicit confirmation, fresh observation and Go approval` in `tests/unit/read-account-confirmation.test.ts`; `TestReadIntentAccountRevokeBlocksQueuedSendAndCannotBeReapproved` in `boot/readintentaccount_test.go`; pinned package above | Injected host/Go policy plus real packaged confirmation. Live account change at actual Send remains unqualified.                                             |
| M09 retained outcome, account-command subset | `retains an unknown approval before fresh current checks after expiry/retirement` in `tests/unit/read-account-commands.test.ts`; known duplicate commands in `--read-account`                                                                                    | Exact IPC outcome retention and zero extra physical account reads. This does not qualify Responses replay or unknown provider Send recovery.                 |
| M11 truthful confirmation                    | `never upgrades inspection to approval without explicit confirmation` and `does not display approval until its evidence intention is settled applied` in `tests/renderer/chat-readonly.test.tsx`; pinned React confirmation/remount witness                      | Component guards have pre-fix failure evidence; actual package displays only the correlated confirmation. This is not model or entitlement attestation.      |
| C07 independent expectations                 | `accountLedgerWitness` / `accountUiWitness` in `tests/e2e/lib/read-account-ui-witness.mjs`, exercised by the pinned packaged harness                                                                                                                             | Separate fixture ledger, UI metadata and journal observations; no production expected-answer injection. Zero Sends does not test duplicate-Send sensitivity. |

## Wire and generation

`api/desktop/v1/schema.json` is the single schema authority. `farol-wire/2` is a deliberately small local generator, not a general schema framework. Run `node tooling/generate-desktop-wire.mjs`; `--check` fails on drift. It uses the locked repository Prettier and Go formatter. Generated Go and TS contain the schema SHA-256; changing the schema requires regenerating both files. Validator templates are generator implementation, not independently authored DTOs. The source format is version 2: method metadata contains read/effect strings, and version-1 metadata is refused by the generator. Wire request/result/event envelopes retain protocol 1.0; the source-format version is not an on-wire protocol revision. Accepted host/backend build provenance and generated schema digests bind the corresponding artifacts.

Frames have a four-byte unsigned big-endian length and 1..1,048,576 UTF-8 JSON bytes. Admit size before allocation. Duplicate keys, invalid UTF-8, depth above 32, unknown envelope fields, numeric request IDs, batches and trailing JSON are refused. A truncated or invalid frame ends the connection; stdout is protocol only, stderr is diagnostics. The TS client counts at most 64 KiB diagnostic bytes and retains no diagnostic contents.

JSON-RPC 2.0 request IDs are opaque ASCII strings, 1..128 characters with letters, digits, `.`, `_`, `:`, `/` and `-`. They are never coerced to numbers. Faults without a recoverable request ID use JSON-RPC `id: null`. Requests use `params: { context?, operationId?, body }`. The handshake body carries major/minor, exact expected build and profile. Major must match and the requested minor must be supported. Adopt context only from that verified handshake result. All subsequent requests bind the exact profile and backend generation. The host remains responsible for accepted executable provenance and IPC sender checks; a handshake alone is not product workspace authority.

Every response echoes request and operation IDs. Outcomes are `ok`, `unavailable`, `unsupported`, `refused` or `unknown`. Unknown methods produce a JSON-RPC fault. Known but unregistered module capabilities return unavailable. Owner data and its worst-case JSON escape expansion are bounded before response serialization; oversized owner output returns `unknown`/`owner_output_bound` without content or replay, preserving request/operation identity. This does not prove a module-owned effect was cancelled. Operation status is explicitly unsupported until its authoritative module owner supplies retained state. It must never dispatch a mutation to answer an observation. Request IDs cannot repeat on one connection. The server returns after at most 4,096 complete frame attempts, including malformed/duplicate requests, without reading another frame; the client limits in-flight requests to 32 and stops admitting while its writer is backpressured. A timeout or loss after dispatch is unknown, closes admission and never resends, restarts or switches executors. Fatal failure ends an owned child's input, waits one second, then stops that exact child; cleanup is confirmed only by a terminal child observation, with a two-second observation budget. Unconfirmed cleanup stays unknown and `close()` reports it. Borrowed children are never stopped. Backend cleanup does not prove cancellation of an OS child/provider operation; module journals still own those unknown outcomes.

PID, uint64 counters and sequences use canonical decimal strings (0..18446744073709551615). JSON numbers use IEEE-754 binary64 value semantics in both peers. Bounded integer fields validate the decoded integer value and its range; `1`, `1.0` and `1e0` decode identically. JSON number token precision is not retained: a sub-ULP fraction such as `1.00000000000000001` also decodes to `1`. Decoded non-integers and out-of-range values are refused. Exact uint64 values use decimal strings, independent of JSON number rounding. Timestamps are UTC RFC3339 with up to nine fractional digits. File ranges are UTF-8 byte offsets, never JS UTF-16 indexes. Transport does not add raw filesystem byte-name support. Module adapters own their independent app/contract DTO conversion.

K0 events admit only `changed` and `gap`, binding context, stream and decimal sequence. Authoritative snapshot events are unsupported until the owning module defines the complete snapshot/acknowledgement contract; a generic payload cannot clear staleness. The client rejects old incarnations/regressions and marks gaps stale; an event cannot change its trusted incarnation. A throwing event observer is unsubscribed; remaining observers and frame parsing continue without changing transport or pending outcomes. No event-producing business service is enabled in K0. Authoritative resnapshot/retention, cancellation, durable operation binding and delivery acknowledgement remain module-owned integration work.

## Composition and next read slice

`cmd/farol` is thin; `boot/container` wires concrete adapters. `transport/desktop.New` accepts only explicitly named methods from the canonical schema. A module-owned adapter maps `desktop.Request` to independent module contracts and supplies `desktop.Outcome`. Module ownership follows the approved package dependencies and explicitly wired owning contracts. The method registry carries read/effect admission only and makes no runtime owner claim. The canonical schema classifies each method as read or effect; generated immutable lookup functions enforce operation identity, and registrations supply only a handler. Effect methods require an operation ID and read methods reject one, but Core supplies no generic durable operation journal: module owners must bind intent durably before effects and reconcile uncertainty. K0 registers no effects.

Computer owns `computer.workspace.read` and all filesystem authority. K1 adds its typed read body/result only after the Computer contract is agreed, then injects disposable trusted repositories through composition. Core supplies the common boundary and never recreates filesystem policy. The existing desktop host chooses the integrated executable; this file does not claim that production uses Go.

## Verification

`node tooling/check-core.mjs` runs generation drift, architecture, root Go race tests/vet, the focused real child-process TS contract tests and strict TypeScript compilation. The repository still requires `task ci:fast` before acceptance. A nested `resources/native/go` module is tested separately whenever it exists; the accepted K0 base predates that release-owned range, so root success cannot qualify it. Go race evidence here is Darwin/arm64 only.

The process/status test compiles the actual executable with `k0-test`, launches a disposable child, verifies its PID/build/profile/incarnation and records round-trip duration. Fixtures qualify hostile wire behavior, not installed application, browser, provider, workspace or update behavior. All processes and test state are owned and disposable; no visible UI is launched.

JSON strings and keys must contain Unicode scalar values. Escaped unpaired UTF-16 surrogates are rejected before Go can substitute U+FFFD; valid pairs, literal backslash escapes and an explicitly named U+FFFD remain distinct valid values. Generated schema validation and the framed decoder share this rule, so a malformed spelling cannot select another path.

The accepted Go in-process contract is a thin owning facade with independent DTOs and explicit mappings; it may delegate to its own application/domain. Neighbors can reach only published contracts through peer adapters. The legacy TypeScript DTO-only contract direction does not replace this Go facade rule. The import guard prevents infrastructure/neighbor leakage. Source review verifies facade delegation, independent DTOs, absence of implementation aliases and explicit mappings.

Malformed owner output is contained as `unknown`/`owner_output_invalid` with exact request/operation/context correlation and no data or replay. Normal bounded replies encode once; invalid output uses one small correlated fallback, preserving the shared pipe for subsequent requests. Canonical operation identity is checked before unavailable/unsupported returns, so missing effect IDs and extra read IDs are refused even when the capability is absent.

`farol-wire/2` admits only the implemented protocol 1.0 limits: 1 MiB frames, depth 32 and 4096 request attempts. The generator refuses missing, coerced or different limit metadata before producing either peer. A limit change needs an explicit coordinated implementation/version change; regenerating types alone cannot change framing or admission.

Closing or fatally failing a borrowed Client detaches only that wrapper's stream, child and drain handlers, clears its observers and rejects its pending requests. It leaves the owner's child, streams and foreign listeners intact. Owned-child terminal observation and cleanup remain separate.

## K1 disposable Computer read checkpoint

`ComputerReadRequest`, `ComputerReadResponse`, `ComputerReadRefusal`, range and page types are authored only in the canonical schema and generated in both languages. The adapter in `transport/desktop/read.go` explicitly converts to Computer's final independent workspace contract and checks exact result correlation. Owner/session/task/participant/turn/call/workspace/path values are preserved; task epoch, request generation, byte counts and all page offsets/sizes use uint64 decimal strings. Range length is a bounded JSON integer, 4..262144. The native contract still refuses offsets above its existing safe bound; lossless wire encoding does not broaden filesystem admission.

A refusal preserves Computer's classified code and source with `retry: never`; malformed typed bodies use `invalid_read_request`/`transport`. A valid refusal includes the exact request correlation. Neither requests nor methods carry roots, grants, trusted home or revocation commands. Core adds no Computer policy, filesystem implementation, command execution or journal.

`ReadMethod` receives the trusted context of its owning server. After native disclosure, it measures the complete encoded response with that exact context before the server writes a frame. HTML/control escaping can expand a 256 KiB native result beyond the unchanged 1 MiB frame ceiling. That case returns typed `refused`/`output_bound` from `transport`, with no content, widening or retry; the pipe remains usable.

`tests/native/core/read.go` is a Darwin-only test executable. Its trusted startup composes `accessrepo.New`, privileged Put methods, `filesystem.New(trustedHome)`, `service.New(access, native, clock)` and `contract.New(service)` for a disposable physical root. Test-only startup flags revoke the participant after native IO and drop a read response after handshake. These seams are absent from production modes and the wire. Production `farol serve` continues to leave Computer unavailable. The TS tests run the actual Client through this executable, verify full/ranged UTF-8 bytes and correlations beyond JS precision, root escape, post-read revocation, output expansion, malformed input, stale backend generation, absent backend and response loss without replay.

Focused generation/import fixtures, Go race/vet, real disposable reads and strict TS compilation are preparation evidence. K1 is not installed desktop acceptance, production authority persistence, provider/command parity or Computer R4 acceptance. Prerequisite Computer preparation remains feature-only; aggregate gates and required independent review remain integration work.

K1's Unicode regression supplies a malformed path while an explicitly named U+FFFD file exists in the disposable tree and proves refusal before native IO. Its `--race-refusal` fixture injects Computer's classified native error to qualify route code/source/retry preservation only. The actual changed-file regression belongs to Computer's filesystem tests; this synthetic route vector is not native race proof.

## Selected Task common-wire source checkpoint

The source candidate includes generated Task DTOs and `TaskIngress.Methods()`.
The facade captures one trusted Task Owner, current turn, provider/model binding
and parent identity. Request bodies cannot select or renew that authority.
Construction does not open a journal, connect to a provider or admit work.
`NativeRuntime` does not register this facade yet; the default unavailable result
remains until trusted selection, provider qualification and lifetime ownership are
composed and accepted. These methods are not exposed to React or remote pages by
this checkpoint.

| Method                       | Operation | Behavior                                                                                                           |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `task.resolve`               | Read      | Inspect the selected binding and supported capabilities.                                                           |
| `task.create`                | Effect    | Create within the captured owner using the envelope operation ID.                                                  |
| `task.continue`              | Effect    | Continue the exact completed Codex dispatch supplied in the body; the existing journal CAS binds that parent.      |
| `task.resume`                | Effect    | Resume the exact terminal Claude dispatch in the same selected provider session, with a newly admitted invocation. |
| `task.observe`               | Read      | Explicitly observe the current selected provider invocation and retain its state.                                  |
| `task.status`, `task.result` | Read      | Read one exact retained dispatch, including historical results; never poll or dispatch a provider.                 |
| `task.operation.status`      | Read      | Inspect an exact module-owned operation receipt, including retained uncertainty.                                   |
| `task.observation.read`      | Read      | Read bounded progress metadata, cursor/gap state and optionally the retained result.                               |

Progress, terminal provider evidence, retained result and parent delivery are
separate facts. Model claims and plan checkpoints are advisory; a terminal
notification alone does not settle the Task. Default progress contains bounded
correlation and classification, never tool command bodies or private transcript
text. Cursors use decimal uint64 strings. A page contains at most 32 events; the
owning module reports missing history explicitly. A retained unknown receipt is
an observation, not permission to send again.

`boot/taskwire_test.go` composes the real framed server, facade, Task Service,
Owner and concrete Codex client against an in-memory storage boundary and strict
RPC peer. `tests/unit/task-wire.test.ts` covers the generated TypeScript boundary.
They qualify source composition only. Native process/socket/storage behavior,
installed provider support, normal app selection and owner journeys still need
separate evidence. Active steering, cancellation and generic execution are not
advertised by this facade.

The selected Claude Root composition defers its Computer execution lease, process
Service, published contract, concrete peer and Host until the Task Owner has
successfully admitted the exact operation. `Supports` requires an independently
supplied host qualifier and does not create an execution lease. The first
selection is one-shot; subsequent observation reuses the same Host and original
lease. Missing qualification stays unavailable, and an unknown selection, process
start or cleanup cannot select a replacement process. When trusted composition
omits a reservation port, Root maps the exact Computer process intent into the
same selected Task route's durable reservation contract. The original operation,
full admission binding, prepared command seal and representable absolute deadline
must match. A known fresh publication returns `Reserved`; retained state or a
repeat returns `Existing`, which never permits another spawn. Lost publication
acknowledgement fences the original owner; restart or a missing old field cannot
restore permission. No argv, stdin or provider transcript enters the reservation.
This source path still needs a qualified native preparer and normal app startup
selection. Controlled aggregate tests do not qualify native durability or CLI
execution.

The native profile layout includes a separate private `task` child, held by the
same qualified profile lifetime. First provisioning creates it; opening an older
profile without this child fails instead of repairing or migrating it. Its
physical metadata creates no task, active admission or process permission.
Existing profile update/recovery must be qualified separately before deployment.

`boot/taskclaude_test.go` exercises that complete Go composition with controlled
native boundaries: useful text precedes terminal output, the result is retained,
and later result reads neither renew an expired lease nor start another child.
`boot/taskprogress_test.go` checks Codex metadata before completion and across
same-thread follow-up, including notifications arriving before the new turn ACK.
Failed event publication stays uncertain without another Send. These CPU
scenarios preserve the separate native/provider and installed-product gates.

`boot/taskclauderesume_test.go` extends the controlled chain through `ResumeExact`
and the framed `task.resume` method. The parent dispatch is checked in the same
Task snapshot/journal CAS; the request cannot supply a provider session or choose
latest state. A fresh trusted Root turn composes the new invocation, while the
previous result remains readable without touching the old process. Lost start ACK
keeps the resumed invocation unknown and does not launch a replacement.

`TaskProfile` composes one journal for the qualified profile and one Task Owner
with its original Codex client per TaskID. Trusted Root supplies each independent
Task admission binding and the explicit parent association; the Chat generation
is not an admission epoch producer. Selection opens no provider connection and
publishes no Task admission. A completed dispatch can continue through the same
Owner/client while earlier results remain retained. Closing first withdraws
facade authority and fences every route, then closes the original clients and
journal once. Unknown cleanup cannot select a replacement lifetime. This Root
join is source-only: its native journal open, ordinary startup selector, current
host/provider qualification and NativeRuntime activation are not accepted.

`TaskSelector` now mints independent coding identities and selects a fresh scope
for a known completed dispatch. It retains the original actual Chat family;
an unrelated active Chat cannot replace that parent, including after the
original is cancelled. A later turn of the same Chat uses its actual published
parent peer while preserving the original Task Owner, client and provider thread.
`BeginCurrentCodex` composes this path with Task's immutable selection authority.
That authority compares the current complete grant, host/workspace generations,
model policy and actual handoff/follow-up schema witnesses before and after
physical verification. Each follow-up retains the same current reader and a
separate actual parent peer. Controlled aggregate tests cover same-Chat follow-up
and grant/parent withdrawal during provider qualification.

The existing Settings publication now carries a closed optional `TaskCodexSource`
projection. The desktop reads the saved host witness and explicit model policy;
it retains the original grant dates and policy digest. Missing/stale provenance
stays unavailable. Settings changes compare the final Computer and Task projections
and await the existing negative Go fence before saving. Only an exact successful
readback is published. Failed host writes retain the desktop's in-process source
withdrawal across recovery reads; this is not a durable restart reconciliation.

`BeginPublishedCodex` reads the actual known Root publication on every authority
check, under the existing negative fence. A withdrawn, missing or poisoned source
cannot fall back to old disk data. An identical known publication retains the
original Task client across new publication/settings/store counters and Computer
activation. Root cross-checks the same approved workspace and generation; native
Task scopes with exclusions or without full Git approval remain unavailable
because this adapter cannot enforce those narrower restrictions. Host identity
and qualified private scratch remain fixed Root inputs.

Controlled Go tests cover withdrawal before save while physical verification waits,
withdrawal during provider qualification, same-thread continuation after identical
republication, and current reads before/after Computer admission. Separate TS tests
cover the real Settings queue and bridge mapping with memory/transport doubles.
Together these are source composition evidence; they do not prove a delivered Go
ACK, normal startup or native qualification. A lost transport response after a known
Root commit is distinct from the tested unknown storage commit. No publication or
Task effect may be replayed to reconcile that uncertainty. NativeRuntime Task
activation and the exclusive journal/host/scratch qualification remain required.

`TaskSurface` provides source-only addressing for these retained facades on one
common desktop connection. Trusted Root selects a Task turn and returns an opaque
`TaskHandle`; there is no wire selection or authority-grant method. `TaskRouted*`
bodies carry only that handle and the existing typed request. The surface delegates
to the captured facade, preserving its admission, original client and journal.
A later trusted turn gets another handle on the same Task Owner. Old or missing
handles cannot select another turn; profile closure withdraws all addresses.
The bridge still uses the original operation ID, and reading an unknown operation
after reconnect cannot turn it into a new Send. Protocol method registration does
not establish provider capability or normal startup qualification.

`apps/desktop/bridge/task.ts` uses this routed surface through the existing
verified desktop `Client`. It snapshots the selected handle, request and backend
context; checks the actual reply and nested dispatch/operation identities; and
preserves partial lineage on unknown outcomes. An attempted effect ID remains
consumed after refusal or loss. The adapter neither selects a provider nor
reconnects or resends. An actual Client timeout closes that transport; a mock
allowing subsequent reads on the same Client is not recovery evidence. Reading
retained Go state after transport loss requires a separately trusted connection
to the original retained owner, without issuing another mutation.

The controlled cross-language Task journey uses the actual TypeScript Client and
TaskBridge, inherited pipes, Go Server/TaskSurface, Task Owner and concrete Codex
adapter. Its scripted provider records one connection/thread and two turns for
same-thread follow-up, with useful progress before retained completion. A lost
provider reply retains the original unknown operation; a duplicate effect ID
and a new Create are both refused without another physical Send. The desktop
pipe remains connected in that fault, so it does not qualify transport recovery.
Follow-up and lost-reply each passed scoped runs; this is not a complete green
run of the final suite bytes. The fixture directly selects TaskSurface and does
not exercise the settings-backed selector or qualify native persistence/startup.

The Task service rechecks the original parent after capability waits, before
admission, before dispatch and before returning a mutation result. Withdrawal
after durable intent keeps the operation unknown without another Send. Historical
queries keep their existing read-authority rules. The concrete Codex client also
requires an immutable dispatch check at the physical mutation write boundary;
service checks alone cannot cover later provider qualification/history waits.
Root constructs that client with the guard from the outset. It checks the same
pending journal intent, host grant and exact current Task route before the final
actual Chat parent read. Profile withdrawal uses an atomic flag, so no profile
mutex or independent Task-gate wait follows that parent read. The transport also
retains the originally qualified connection and account-notification epoch; a
change observed while waiting for the write lock or Root guard prevents a new
write. These are pre-write checks, not atomic remote cancellation. A partial
thread creation must retain its original lineage and cannot be retried through
another client.

The Task parent peer uses the actual retained Chat admission facade. Root binds
it explicitly to the initiating external thread/turn; those IDs are not derived
from the Chat TaskID. Every recheck compares the complete current binding without
provider calls or admission changes. Completion, cancellation and a later Chat
turn invalidate the old association. This supplies the parent check only; current
host/account/model qualification and normal Task startup selection remain open.

## Running Chat to Computer source join

The conversation facade can capture the admission of its actual running owner,
commit a correlated `RequestComputer`, and retain an opaque call until the exact
host result-return acknowledgement. It uses the existing lifecycle journal and
queue. The call context includes logical owner/turn identity, physical browser
lease/document identity, observed user/reply IDs and the source watermark.

Root composition in `boot/chatcomputer.go` attaches that same admitted owner to
current Computer publication without creating a second Chat admission. It narrows
the first attachment to a read-only workspace, commits Computer membership once,
and selects one bounded execution lease for the actual read. Independent new
conversations receive distinct participants at their original admission; a
same-conversation follow-up preserves its task and participant identity.

`boot/chatcomputer_test.go` composes the real Chat owner, browser adapter, result
retainer, admission facade, Computer policy, snapshot repository, execution lease
and workspace service against controlled physical browser, native persistence and
filesystem boundaries. Useful text precedes the read; an exact simulated host
return ACK permits the next separately observed answer. Lost ACK, crossed identity,
cancel, publication uncertainty, revoked authority and expired leases do not
produce a duplicate read or Send. The participant collision regression is retained
as a failing baseline and a passing corrected source witness.

The inherited desktop registry now includes `chat.computer.read` and
`chat.computer.return`. `boot/chatcomputerrelay.go` selects the existing Chat handle,
retains its opaque call, and binds an original relay operation to the exact output
UTF-8 digest and byte count. The read creates no return acknowledgement. Only a
matching private receipt can resolve that original call, once. Unknown admission,
lost Resolve acknowledgement or another transport operation cannot repeat the read
or owner callback. Generated Go and TypeScript definitions share the same schema.

`ChatComputerBridge` verifies the common response identity, closed payload, original
operation correlation and exact output bytes. `chatComputerReadRelay` connects that
bridge to the existing caller-relay's optional `invokeOwned` callback for one actual
Chat handle and the whole-file `computer_workspace_read` capability. Other tools,
namespaces and windowed requests are refused without legacy execution. Root still
owns current admission, authority, execution and lifecycle settlement.

The relay's trusted client parses the complete original result before sending one
private receipt through the same endpoint. The server checks its original bounded
operation record and invokes the captured callback at most once; the callback sends
only the captured opaque Go receipt. Socket write/end is not an acknowledgement.
The queued original callback also rechecks turn closure and expiry before starting
any owned effect. Private receipt fields and operations stay outside the public MCP
schema and result. Lost receipt, callback uncertainty or lost final confirmation
never triggers recovery reconnect, result replay or another tool execution. A lost
confirmation after known Go settlement leaves the client uncertain; it does not
undo the durable Go fact.

CPU evidence covers the real framed Go Server/Chat/Computer composition, generated
cross-language frames, the real relay server/client with in-memory network and
filesystem boundaries, and the selected TypeScript adapter/bridge against a
controlled Go transport. These are separate controlled witnesses, not one launched
native/provider journey. `Returned=true` by itself is not evidence: the trusted
parsed-result producer supplies the return edge, and provider consumption requires
its separate observation.

After an exact known return, the same running Chat handle can issue another
distinct whole-file read within its original workspace ceiling. Root retains the
original immutable route selected by that opaque handle and binding, then asks the
existing Computer issuer for a fresh operation lease. It does not repeat membership
admission, widen policy or reuse/extend the prior operation's deadline. The current
Computer and Chat owners are checked on every lease and disclosure phase. A return
attempt or an observed settled owner does not replace the original known Root
receipt; missing/unknown receipt keeps that chain closed.

This remains one attachment for one running turn. Normal product routing must
select the adapter for an actual Go conversation and qualify the complete path.
A new turn/backend or follow-up cannot inherit this route; multi-turn Computer
attachment remains pending. The external Responses owner/function-call SSE path
is a separate join; an internally executed read must not become a second
caller-executed function call. No native storage, package, install or live-provider
acceptance is claimed.

## Internal Computer mutation source join

The canonical desktop schema includes `chat.computer.write`,
`chat.computer.edit` and the read-only `chat.computer.mutation.read` observer.
Root selects the actual running Chat handle before attaching Computer membership.
The initial write attachment requires explicit existing write approval for the
selected workspace and captures task mutation ownership in its original ceiling.
A route first attached for reading cannot acquire write permission on a later call.

Each mutation retains one copied request, one original execution lease and one
Computer service. Chat's durable outstanding call precedes Computer admission;
Computer's durable mutation intent precedes native execution. Repeated execution
and new-key requests on an unsettled relay chain cannot dispatch another write.
Only a known durable completed/failed result can produce an opaque relay receipt;
the original parsed host return, rather than transport delivery or observation,
settles that exact Chat call. A known `memory_only` completion remains readable
under the original lease, but receives no usable relay receipt. Prepared or unknown
outcomes remain fenced. Observations cannot admit, renew, Save, execute or ACK.

The private Go mutation repository preserves the existing canonical v1 identity
fingerprint and content-free records. A fresh permit requires this writer's
confirmed create; an existing-name result can only observe Existing or fence
unknown. Terminal publication is attempted once. New Go-only failure vocabulary
that cannot fit v1 remains in memory instead of silently changing the stored
schema. See `modules/computer/infra/repos/mutation/README.md` for the exact limits.

Wire text is bounded to 256 KiB per field and existing typed arrays to 128 edits;
empty edits are refused. Root additionally bounds the complete copied mutation
before durable intent. The native 8 MiB capability does not enlarge the 1 MiB
framing envelope or authorize chunking/retry.

The selected TypeScript adapter accepts the existing external tool arguments,
including the original stable `operationId` and `expectedSha256`. A nullable write
preimage maps to the omitted wire `expectedSHA256`; the request digest still
covers the original arguments. The effect ID stays separate from the relay call
ID. Reusing either in the same bridge lifetime refuses another dispatch. Output
checks bind the original handle, turn, generation, operation, path and receipt;
a fresh retained observation also enforces the native 8 MiB result bound. Only
known durable output reaches the existing single-attempt parsed-return ACK join.
These controlled bridge tests do not replace the framed Go or native gates.

`NewChatComputerMutationIngress` requires already qualified concrete journal and
native workspace owners. It creates no roots and supplies no exclusive handoff
from an old TypeScript writer. Ordinary `NewNativeRuntime` still selects its
read-only join until that handoff and native qualification are accepted. The
framed aggregate tests exercise real Go Chat/Computer services with explicitly
controlled persistence and filesystem ports; they do not qualify native storage,
installed startup, a live provider, or release acceptance.

## External caller-tool round source join

`chat.caller.begin`, `claim`, `output` and `return` compose one external
caller-native tool round on an already admitted Go conversation. The existing
host catalogue supplies its resolved function name, namespace and exact argument
bytes. Root captures the actual logical/physical Chat context and retains the
opaque `CallerToolCall`; the wire carries correlation and an opaque ticket, never
admission, a Computer route or a caller-supplied authority snapshot.

The first `response.completed` ends the HTTP round while the same Chat turn and
worker remain outstanding. A single current `ClaimDispatch` is required before
its original executable delivery. Reading retained frames or acknowledging a
frame does not grant another dispatch. Exact external scope, call/item IDs,
namespace and arguments bind the returned string or typed-text output. Accepting
that output opens the next HTTP round on the same handle and does not Send again.
The next round has distinct response/message IDs and only the new text suffix;
the retained conversation result still contains the full answer.

Output acceptance does not settle the tool. Only the original private relay
parser receipt can return the captured Root receipt through `chat.caller.return`.
That receipt binds a fresh receipt ID, original ticket/relay/call correlation and
normalized UTF-8 output digest/length. Unknown publication, dispatch or settlement
cannot mint another ticket or retry through another method. Cancellation keeps
the existing unknown outcome and lease behavior. No external caller tool is
executed by this attachment; an internal Go Computer read remains a distinct
selected path and never produces another executable external function call.

`chat.caller.check` reads the current state of the same already-claimed call
under the actual Go owner gate. It issues no claim, write permit, execution,
journal entry or acknowledgement. Cancellation or freeze can occur after the
snapshot; a successful check is not a transport fence across an awaited write.

`chat.conversation.submission` reports the actual owner snapshot as
`not-dispatched`, `intent-committed` or `unknown`, bound to the exact handle and
backend generation. None permits releasing an external replay guard. In
particular, a queued or prepared handle can report `not-dispatched` and still
perform its original Send later. Lost intent/Send replies remain unknown; even a
known browser `NotSent` after durable intent remains `intent-committed`. These
read methods cannot withdraw a handle or grant a replacement request.

`chat.caller.issue` consumes one delivery attempt for that same claimed call.
The Go owner returns only the original contiguous completion group captured at
publication, including preceding text-completion frames. Root uses the existing
Responses encoder, validates original correlation and bounds, and binds an
opaque issuance ID plus SHA-256 and UTF-8 byte length to those exact bytes.
Neither retained Events nor a successful `check` can replace this issuance.
Lost reply, encoding failure, unavailable frames and unknown publication cannot
reissue the group.

The thin `writeGoCallerDelivery` adapter binds that issuance to one original HTTP
response and its preceding sequence cursor. It installs monotonic abort/close/
error listeners before awaiting issuance, then makes at most one exact
`response.write` without an await after its final local fence check. A false
write result means bytes were already buffered; drain never grants another
write. Late withdrawal discards an in-transit reply or leaves a possibly written
group unknown. Returned metadata is neither output acceptance nor a parsed
receipt, frame ACK or proof of atomic network delivery. Composition must close
its local fence before awaiting its own Go cancellation; already-issued remote
data can remain in flight, so a Go freeze alone is not confirmed transport stop.

The typed bridge is available from the existing desktop Go lifetime. The optional
`goResponses` startup input selects the Go transport in `startRouteBRuntime` before
a legacy provider turn exists. Existing HTTP authentication, model/schema parsing,
compaction exclusion and durable external replay identity remain in that path.
There is no legacy fallback after Go admission. The trusted `resolveCreate` producer
must supply a legitimate browser account/model selection; ordinary production
startup has not yet qualified that producer.

The selected transport emits Go SSE frames incrementally, retains the original
handle through a tool round, and resumes observation only after the original
private parsed-result receipt returns to Go. The actual global Prepare result
selects the connection; a known `CHAT_CAPACITY` from Prepare leaves the sixth
conversation queued without a Send. Other preparation failures stay unknown.
A successful Send command response does not erase submission uncertainty reported
by the owning Go lifecycle.

HTTP response observers remain attached until the original local `finish` event.
Premature close/error first withdraws the local write fence. A continuation arriving
before finish has a separate fenced response and cannot replace the old binding.
Local finish, socket write and drain never become Go business acknowledgement.
A later ordinary user turn and worker reuse still require their separate delivery
settlement; this optional transport currently refuses that reuse. It supports one
external tool round per Chat turn, not a general multi-round tool engine.

The controlled Go process/ordinary HTTP tests use the real services, framed bridge
and existing relay with scripted physical browser and memory journal ports.
They are not a launched Electron, native filesystem, live provider, packaged or
installed journey. The finish-order regressions require their own executed test
receipt; prior transport results do not qualify changed afterimages.

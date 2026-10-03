# Installed update helper

**State:** narrow native replacement/recovery mechanism used by the current installed
updater. It does not discover releases, authenticate a package, decide work is idle,
or perform first installation. Those owners are
[release discovery](release.md), [package verifier](verifier.md),
[updater admission](runtime.md), and [promotion](../../start/installation.md).

## Caller sequence

1. Verify downloaded release/archive/app identity, accepted source/target pair, and
   all work obligations. Hold existing admission/promotion gates through normal Quit.
2. Capture the **live** app PID and actual `/bin/ps -o lstart=` value, matching the
   owning run marker.
3. Start the digest-attested packaged helper and persist its exact PID before sending
   program/request bytes.
4. Await its identity-bound `waiting_for_exit` readiness acknowledgment.
5. Only on `ready`, perform normal coherent Quit. The helper observes that PID ended,
   the run marker disappeared, and a fresh drained Quit receipt has no unconfirmed child.
6. The helper acquires the same kernel promotion lease, rechecks both bundles and
   directories, then performs its journaled operation.

The helper never kills the app. A spawn, write, absent PID, stale Quit receipt, or
held/replaced lease is not readiness. Uncertainty keeps the app running and retains
the same child/operation, without a substitute launch.

## Launch API and result

[startInstalledUpdateHelper](../../../src/modules/release/infra/native/installed-update-helper.ts)
attests the packaged `resources/native/update_helper.py` bytes and runs reviewed
`/usr/bin/python3 -I -S -B -` detached. The caller supplies the packaged path, not
checkout/workspace code.

| Result            | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `ready`           | Exact live apply/rollback/recover acknowledgment; permits normal Quit                            |
| `not_started`     | Classified pre-spawn refusal or proven native exec failure before any request/program submission |
| `refused`         | Classified handoff refusal; no Quit permission                                                   |
| `outcome_unknown` | Spawn/response/process uncertainty; retain operation and observe the same child                  |
| `terminal`        | Finished offline recover (`relaunch: false`), without live Quit handoff                          |

Every spawned result retains `operationId`, PID, `observe()`, and `completion`.
A late ACK cannot upgrade an unknown initial decision. Child terminal observation is
not installed startup acceptance. Durable journals survive the caller's exit.

Request is inherited on descriptor 3; readiness uses private descriptor 4. One frame
must match operation/action/source/target/PID/start, within 4096 bytes and complete
EOF. Terminal stdout is independently bounded. Readiness timeout defaults to
180,000 ms and is configurable within 1–300,000 ms. After handoff, observation pipes
are unrefed so the caller can exit naturally without interrupting journaled work.

## Request and fixed locations

The request schema is `farol.installed-update/1`:

| Field                 | Contract                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `action`              | `apply`, `recover`, or `rollback`                                       |
| `operationId`         | 32 lowercase hexadecimal characters                                     |
| `source`, `target`    | Exact digest/version/build ID                                           |
| `drain`               | Reconciled source/target assertion from existing work owners            |
| `pid`, `processStart` | Bound live caller identity for the live handoff                         |
| `waitSeconds`         | 1–120                                                                   |
| `relaunch`            | One launch request after reconciliation; false selects offline recovery |

The OS account owns the derived home and fixed `$HOME/Applications/Farol.app` slot.
Operation data is beneath the existing `Farol Next Preview/installed-updates/`
product profile: `staged.app`, preserved `previous.app`, optional `failed.app`, and
`journal.json`. Caller-supplied arbitrary homes/slots are not admitted.

Historical schema 5 helpers owned `Farol Next Preview.app`. They cannot be redirected
by archive/slot renaming; [closed cutover](../../maintenance/preview-cutover.md) precedes the new baseline.

## Atomic apply

The helper pins no-follow directory identities, bounds input/tree/journal/wait, checks
both app tree digests and embedded identities, and fsyncs journal/parents around moves.

`prepared` is durable before a single Darwin `RENAME_SWAP` between the occupied fixed
slot and `staged.app`. An unsupported filesystem refuses without a two-rename fallback.
The displaced source is verified and named `previous.app`. `new_installed` precedes
final verification; `verified` means exact current target and preserved source both
matched. No existing predecessor/failed copy is overwritten or deleted.

A failed target check in that same invocation atomically restores the source and
preserves rejected target bytes as `failed.app`; those bytes are not an accepted target.

## Exact-operation recovery and rollback

Recover uses the **same operation ID and accepted pair**, never another apply:

| Observed journal/pair                                    | Reconciliation                                              |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Prepared, slot=source / stage=target                     | Cancel without exchange; preserve both                      |
| Prepared, slot=target / stage=source                     | Verify completed exchange, preserve source, record verified |
| Rollback started, target/source not exchanged            | Perform the one journaled rollback exchange                 |
| Rollback started, already exchanged                      | Preserve target as failed copy and record rolled back       |
| Settled exact pair                                       | Observe/reconcile without repeating replacement             |
| Changed/unknown bytes, paths, identity, or process state | Refuse and preserve the obligation                          |

Legacy empty-slot two-rename journals have a narrow exact-pair repair path; this helper
does not create that gap. Rejected target bytes cannot be re-attested after a crash
using a prior invocation's inode observation. A second rollback intent is refused;
inspect and recover the existing one instead.

Live recover requires the same PID-bound ACK/Quit sequence. Offline recover requires
an already-confirmed Quit and eligible lease/pair. A timeout or old unknown outcome
never proves the original helper ended.

Before one `/usr/bin/open -a` call, the helper journals its launch intent. Recovery
recognizes that intent and never repeats launch. A successful `open` return records
request completion, not GUI startup/activation. The installed app must independently
measure its journal and accepted companion before claiming acceptance.

## Verification boundary

[Helper source](../../../resources/native/update_helper.py) and disposable process/filesystem
fixtures exercise pair reconciliation, ready/terminal frames, timeouts, refusals, and
same-child retention. Transport fakes are not native process proof. None alone proves
a live GitHub upgrade, actual LaunchServices activation, settings preservation,
provider reconnect, Gatekeeper acceptance, or full release readiness.

---

[Updates](README.md) · [Documentation](../../README.md)

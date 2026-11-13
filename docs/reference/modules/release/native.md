# Native release boundary

This checkpoint began as an additive, source-only move of the leased archive
package, the existing record codecs and the consuming migration port (the
migration port and its adapter were later removed, see below). The
desktop now runs the Go update helper entries for apply, recovery and rollback
(see [helper recovery](helper-recovery.md)). The TypeScript updater policy, root
dispatcher, package pins and installed identity stay under the integration
owner's existing lifecycle.

## Durable owner and physical adapter

Release alone owns durable operation binding, record serialization, intent,
dispatch, retention and recovery. Core supplies composition; a shared primitive
appears only with real consumers.
The leased alpha profile relocation adapter
(`infra/native/migration`), its consuming `app/port/migration.go`, the
`app/services/migration` claim owner and `domain/migration` plan were removed on
2026-11-13 without ever gaining a production caller. The
[identity cutover](../../../identity-cutover.md) replaced profile migration with
reinstalling earlier betas. Their single-claim, no-replace rename and
outcome-unknown design remains in Git history; a future relocation would need a
new decision and fresh review rather than restoring that source.

## Current-alpha record slice

Source reference: `a47c9ccea1a00eb210f675f71a0690fc3be6c857`, definitions in
`src/apps/desktop/installed-update-runtime.ts` and `resources/native/update_helper.py`.
The codec preserves the existing journal schema and 13 phases, full source/target
triples, missing/null helper identity, optional restore/download/retention fields
and decimal-string physical identities. Limits are 65,536 bytes for a record read
and 8192 bytes for the helper's existing journal encoding. Encode is not fsync,
a dispatch acknowledgment or a verified package. A copied manifest stays opaque
until Release's separate accepted manifest/package verifier succeeds.

The current persisted TS build schema permits an empty version syntactically;
a decoder preserves that parsing distinction. Full operation binding and native
verification still decide usability. UTF-16 string limits match the existing TS
record schemas. Malformed UTF-8 or unpaired escaped surrogates are refused to
avoid Go JSON replacement changing retained identity. Ordinary closed-schema
and binding parity is exercised by 77 synthetic vectors against frozen TS schemas.

This is not complete alpha filesystem parity. File owner/mode/no-follow/hardlink
and race checks, temporary-file write/fsync/rename/parent-fsync windows, download
cleanup, promotion/closed-repair receipts, restore-intent clearing, rejected-tree
inode checks and current-alpha state rebinding remain separately required.

## Helper readiness and process evidence

The update helper (the Go entries, as the retained Python program did) consumes one bounded request on descriptor 3 and one private
ACK frame on descriptor 4. Readiness requires exact operation/action/build/app
PID/start binding and EOF, not a spawn, write or partial JSON chunk. Refusal ACK
does not prove child exit or absence of all metadata effects. Terminal close for
the retained child is separate from journal/physical/installed acceptance.

An initial timeout/protocol failure remains unknown when a late ACK or close
arrives. The same child handle is retained; there is no second dispatch. Before
one launch the journal records `*_launch_requested`; recovery never repeats that
launch. Completion records only the launch command returning, not GUI acceptance.

Read-only journal decoding can report retained phase/binding. It cannot establish
helper exit after the original caller loses its child handle. The current source
uses `ps` for process-start/absence observation; it exports no durable reconnect
to that child handle after caller restart. A previously platform-refused observation
is not retried or rerouted by this source preparation. Offline recover is a
mutation path, not a substitute for read-only reconciliation; the Go entries
refuse it, and the desktop never sends it. Until supported
same-child or approved exact native process evidence exists, process uncertainty
and all resulting admission limits remain explicit.

## Integration exits

The desktop runs the attested Go helper entries from the build's private
execution image. Both transitional Go suites stay explicit until the old nested
module is retired. Physical archive/package/resource and legacy-alpha
compatibility must pass before resource/consumer deletion. The Go helper's
durable, ACK, normal-Quit, lease, swap, restore and crash behaviour is tested
against disposable native state ([helper recovery](helper-recovery.md)); package
and installed acceptance remain separately owned evidence.

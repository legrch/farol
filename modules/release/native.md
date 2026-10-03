# Native release boundary

This source-only checkpoint is additive and unwired. It moves the leased archive
package and prepares existing record codecs and the consuming migration port.
The active updater/helper, root dispatcher, package pins and installed identity
stay under the integration owner's existing lifecycle until parity and cutover.

## Durable owner and physical adapter

Release alone owns durable operation binding, record serialization, intent,
dispatch, retention and recovery. Core supplies composition; a shared primitive
appears only with real consumers. Identity's leased native filesystem subtree is
`infra/native/migration/{filesystem.go,darwin.go,filesystem_test.go,darwin_test.go}`.
It implements the consumer-owned `app/port/migration.go`, with no journal or
second lock engine. None of those leased Identity files is written by this slice.

`MigrationBinding` binds operation, accepted alpha build and physical source
object. `MigrationRecord` is a read-only projected version-1 policy view, not a
Desktop wire message or independently persisted schema. It cannot be guessed
from a directory name, lock or digest supplied by a caller. Release's authoritative
admission capability must prove accepted byte/profile provenance, the existing
exclusion domain and all stopped profile-owning writers/helpers. The native
adapter rechecks that capability and exact directory identities before mutation.

Only a handle acquired against exact `prepared` can arm a move. Release confirms
its durable `dispatched` record before invoking `MoveOnce`. Acquisition against
`dispatched` or `relocated` permits observation only. One handle makes at most one
same-volume no-replace rename attempt; there is no overwrite, copy or retry path.
Moved requires source absence, exact destination object and confirmed durability
of both parents. A post-syscall/readback/fsync uncertainty remains unknown, even
when a later directory observation appears correct. Release then observes the
same operation; it never interprets source presence as permission to redispatch.

The filesystem handle owns its descriptors only. Closing it does not release
Release's retained guard, clear an intent, manufacture a completed record or
permit profile startup. `VerifyLayout` remains a stop at Core/Desktop's explicit
partition/state/generation reconciliation. The local-runtime and remote ChatGPT
sessions retain distinct network policies; a whole-root move does not merge them.

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

The existing helper consumes one bounded request on descriptor 3 and one private
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
mutation path, not a substitute for read-only reconciliation. Until supported
same-child or approved exact native process evidence exists, process uncertainty
and all resulting admission limits remain explicit.

## Integration exits

Core/Lead accept root module/command/build closure and fresh executable attestation,
then wire one active runtime. Both transitional Go suites stay explicit until the
old nested module is retired. Physical archive/package/resource and legacy-alpha
compatibility must pass before resource/consumer deletion. A new Go helper needs
fresh durable/ACK/normal-Quit/lease/swap/restore/crash tests against disposable
native state; package and installed acceptance remain separately owned evidence.

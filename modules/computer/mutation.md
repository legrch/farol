# Go Computer hash-bound mutation foundation

Status: pure source foundation only. Source dependencies through `bac075e` remain
UNACCEPTED and required R4 review is pending. There is no Go mutable Execute,
native mutation implementation, durable Go mutation journal, live qualification,
root/schema/generated change or active TS/Python retirement in this slice.

## Current operation and policy

The active TS contract accepts `workspace.write` with a required nullable expected
SHA256, and `workspace.edit` with a required expected SHA256 and 1..256 ordered
old/new pairs. A null write precondition is create-only; it never means overwrite
without comparison. A nonnull precondition is a lowercase 64-hex digest of the
entire original bytes, including BOM. Missing edit files are not_found; unequal
observations are mutation_conflict. Pure CheckPrecondition consumes an already
qualified observation; it neither opens a file nor proves that observation.

Canonical file-relative paths exclude the root dot, absolute/traversal/empty
segments, backslash and control characters, with 4096 UTF-16 units. Public request
owner IDs have an 80-unit bound; other mutation IDs have 160, distinct from the
readonly 120. Epoch/generation reflect the existing TS safe nonnegative integer
bounds. Core owns eventual wire encoding/parsing, including any protocol migration.

Request text has the TS 8 MiB UTF-16-unit bound and excludes NUL. Native request
preflight has a separate 8 MiB UTF-8-byte ceiling, including the aggregate old/new
edit bytes. These checks retain distinct contract-invalid versus native-invalid
classifications. Python's subsequent normalized edit validation/matching is not
implemented here. It normalizes CRLF for matching, requires one unique nonoverlapping
match per edit, preserves untouched bytes/BOM/local endings, and bounds resulting
bytes. Those exact rules remain prerequisites for the native slice.

The injected digester must match SHA256 of the exact TS JSON.stringify canonical
array: workspace, wire operation kind, path, nullable expected hash, content or
ordered edit pairs. Identity and Turn/Generation/CallID are excluded. No plain Go
JSON encoder, approximate fingerprint or new digest implementation is supplied.
A fingerprint failure precedes journal admission; no effect can run after it.

## Journal state and recovery

The key is operationId/owner/session/task/epoch/participant. Workspace and request
digest bind that key; changing either is operation_conflict. The existing private
journal owner ID bound is 160 even though public requests use 80. Records retain
only fingerprints and receipts, never content or edit text. Prepared has no outcome;
completed has a receipt; failed has a known deterministic/authority code and source;
outcome_unknown permits only the unknown code with native-workspace/operation-store
source. Restore validates this closed shape without creating authority.

Only prepared may transition to a terminal state. Identical terminal saves are
idempotent; terminal change/reopening/rebinding is refused. Recovery returns an
existing completed receipt or original failed/unknown fact; interrupted prepared
becomes an operation-store unknown tombstone. There is no recovery execution state.
All exposed receipt/hash/operation/edit values are independent copies. Stored
receipt schema is intentionally distinct from stricter native receipt correlation:
the active private schema accepts a bounded receipt path; this is metadata, never
permission to use that path. Native parsing requires matching kind/path, write's
zero replacements or edit's positive replacements, and bounded bytes/digests. It
does not independently compare/recompute the receipt's before/after hash; only the
native implementation can attest the actual operation. Lost/malformed receipt,
interruption and unclassified native failure map to outcome_unknown. None implies
retry permission or allows a new key.

## Ports and missing execution seam

Consumer-owned MutationRepository owns atomic same-key admission and immutable
terminal storage. Admit may report admitted only after durable publication; a
failed/uncertain publication is an error, never absence or permission to mutate.
The memory double tests only same-process state/coherence; it supplies no durable,
restart, native filesystem, Task/Computer or effect serialization proof.
MutationDigester and MutableWorkspace are injected ports without concrete adapters.
Native IO cannot run inside either existing Computer/Task inspect callback.

The published in-process Check delegates to pure app checking and returns an
independent content-free correlation summary. It does not read owners or grant
permission, admit a journal record, emit a receipt or call an executor. It is not
the public mutable wire Execute endpoint. Syntactically valid body IDs cannot
select the current task. No shared method/schema/registration is added.

Actual Execute still needs: the real Task/Chat owner-bound fixed lease; coherent
current authority at initial admission and effect handoff (Computer -> Task lock
order); one owner-controlled in-flight coalescing lifetime across operation-scoped
services; and native effect serialization/cancellation with an explicit
linearization point. The TS no-await authorize -> native call sequence must not be
approximated by a Go callback-to-IO race or by holding Task's callback over native
IO. A matching existing receipt must never re-execute, and a revoked/expired owner
must not be bypassed by new body correlation. Durable admission delay, terminal
save failure (completed result memory_only), prepared recovery and receipt
redelivery/rebinding require the full executor orchestration in a later slice.
Lead and Task/Chat/Core owners must settle this narrow handoff/observation seam
before activation; this foundation invents no second authority or task engine.

Pure vectors cover create-only/hash/not_found, header/path/text/native aggregate
bounds, copy isolation, strict state restore, terminal immutability, same-key
conflict, interrupted-prepared unknown, original terminal recovery, receipt shape,
and native error mapping. Tests do not mutate native files or exercise a provider.
Existing live operation/refusal/unknown and reviewer quota fences remain intact.

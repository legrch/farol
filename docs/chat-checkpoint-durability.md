# Existing context owner checkpoint durability

`PrivateContextStore` remains the Electron primary process's private context
owner. Its original `StoredContextSource`, `ContextBinding`, compaction admission
and session are authoritative. This change adds no database, conversation engine,
provider request, task grant or account permission.

## Immutable original records

Original source and checkpoint writes use the existing create-only sealed
publication mechanism instead of read-then-rename. A simultaneous different value
under the same ID conflicts; it cannot overwrite the first published original.
Existing v1 record bytes, `put`/`get` signatures and legacy reads remain compatible.
A complete publication interrupted with its temporary hardlink still present is
qualified using the existing exact temporary name/inode finalizer. Unrelated
hardlinks, symlinks, unsafe modes, corrupt or oversized bytes remain refused.

## Explicit same-owner publication

`checkpointPublicationPolicy()` returns the complete configured storage policy,
including validation/record limits, retention and the 2 MiB publication-record
ceiling. It is storage policy only: it is not a Go context window, a reservation,
a provider capability or disclosure authority.

`publishCheckpoint(request, originalLease)` accepts the validated checkpoint and
an expectation containing the complete immutable `StoredContextSource`, its
SHA-256, source epoch and exact storage policy. The original admission token must
still belong to this primary process instance. The durable full binding,
epoch/boundary admissions, validated session operation and original source must
match. Positive IDs cannot grant publication.

The existing primary-process owner serializes publication with session saves,
lease release, source deletion and task deletion. A create-only operation intent
under the existing checkpoint directory freezes the full request before its
checkpoint is published. Any failure after attempting intent publication is
`CONTEXT_PUBLICATION_OUTCOME_UNKNOWN`. Publication never overwrites an admitted
request or retries an incomplete original. A repeated identical completed request
only reads its already published result; it does not acquire a new lease or write.

`observeCheckpoint(binding, operationId)` returns:

- `absent` only when no publication intent or original session compaction
  operation/admission, summary attempt/receipt, retirement or legacy checkpoint
  bookkeeping exists. A pre-admission source-only copy is input data, not a
  checkpoint effect; its existence and cleanup do not change proven publication
  absence;
- `outcome_unknown` when the durable intent exists without the exact checkpoint,
  or original operation bookkeeping exists without the new intent;
- `published` only for the full exact original request and checkpoint bytes.

Observation does not send, acknowledge delivery, retire history or grant retry
permission. It may finish the original sealed temporary-link cleanup, following
the same qualified read behavior as legacy admission records. Corrupt, foreign or
inconclusive storage throws; it is never reported as absent. Lost ACK recovery
reads the original intent and bytes with a new store instance. It does not resume
publication. Uncertain originals block source/task deletion, including original admitted
operations that predate the new intent record. Pending compaction sessions and
unconfirmed summary/retirement records are retained; source-only pre-admission
input cleanup remains compatible. Exact completed legacy cleanup requires an
active session without an operation, the original completed request and matching
checkpoint at the previous epoch. An earlier exact checkpoint may be cleaned
only when that same owner has a later active completed head; missing original
checkpoint evidence stays retained. `checkpoint_requested/not_observed` is saved
before awaiting the original summary request, so that label cannot prove the
request was never sent. Mere positive IDs or a published checkpoint
without that terminal owner state cannot permit cleanup. Immutable publication
intents protect their checkpoint from legacy retention; their original source
bytes remain inside the intent even after a confirmed source cleanup. No automatic
publication-intent pruning is introduced.

## Explicit remaining boundaries

This TS owner identity includes the real host thread/task/session fields. The Go
`contextbudget.SourceRef` has a different identity and policy, and the new live
Chat source lease has no original host-thread history mapping. No invented mapping
or atomicity across those owners is supplied here. The existing `CompactContext`
service still uses its original port; boot/app-port activation is separate work.
The serialization authority depends on the existing Electron single-primary
process contract and physical original admission lease. It is not a cross-process
lock for arbitrary new writers. Pre/post checks must not be cited as atomicity
with a distinct Go source/account owner.

The regression fixtures use actual bounded disposable filesystem records,
simultaneous publications, lost acknowledgements and exact child process death.
They preserve original UNKNOWN content and exercise strict hardlink refusal.
They do not prove native filesystem qualification, power-loss durability,
provider/account behavior, live product activation or macOS acceptance.

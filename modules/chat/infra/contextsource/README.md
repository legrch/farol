# Original live Chat context source

`Source` adapts the existing `lifecycle.Conversation.CaptureContext` lease into
`contextcheckpoint.Source`. This adds neither a conversation engine nor a
permanent transcript store. Boot must supply the **original** selected-account
`DisclosureLease`; matching opaque IDs do not grant disclosure permission.

The lifecycle owner retains at most its existing 1,024 admitted prompts, each
bounded by the existing 8,192-byte input limit (at most 8 MiB additional private
text per live owner). Send still clears its separate one-shot input. Normal
admission and bare-read promotion retain the same original input. The lease pins
its original owner, exact chain, revision and fence; later Follow, pending/unknown
writes, observation, freeze and retirement reject that lease. It never reacquires
a fresh activation to make an old source current.

Completed user and assistant events preserve their actual provider user/reply
IDs and full original Chat turn identities. The latest unsent user event uses its
original Chat admission TurnID, not an invented provider/browser ID. Duplicate
or invalid original IDs are refused. Exposed values are detached; the digest
covers the full mapped source, not just selected input text.

This first production adapter deliberately supports complete **text-only**
originals. Older cleared inputs, partial answers, failed/unknown terminal results
and any original Computer/caller round return a classified incomplete source.
The current owner discards tool output and retains only one tool call; resolving
or acknowledging it cannot silently turn that missing transcript into complete
context. Existing result reads/stream replay do not reconstruct those originals.

`WithCurrent(ctx, fullSourceRef, callback)` holds the actual lifecycle source gate
around a synchronous no-IO callback. It is a source fence, not an account or Send
grant. Composition enters the same account owner guard first, then this source/
Chat gate, matching the existing Browser Send order. Source-to-account inversion
can deadlock with that route. Do not reacquire an earlier guard or reenter source
Read/Check, Context/View, models/cache or either owner in that callback.
Native/provider/durable operations occur outside
these guarded callbacks with original pre/post fences and UNKNOWN semantics.

Tests run actual lifecycle admission, original journal CAS transitions, output,
Memory result retention, context selection and MaterializePlan. Browser, disk
journal and account guard ports remain controlled fixtures. These tests prove
original source composition and fencing, not account/provider entitlement,
production transport activation, native persistence or package acceptance.

Durable checkpoint publication still requires a narrow extension of the existing
private checkpoint/source owner. This adapter does not implement another
checkpoint database, claim native CAS, restore a retired source or acknowledge
any delivery or compaction operation.

# Go Computer catalogue and bootstrap

Status: owned source/native fixture implementation; UNACCEPTED dependencies and
required boundary review remain pending. No public route, installed runtime or
owner/provider acceptance is claimed. The active TS/Python executors remain.

## Composition proposal

Use the existing `execution.Service` and its already admitted immutable `Lease`.
Construct one `workspace.Service` with `NewForExecution(lease, native, clock)` and
one published Computer `workspace.Contract` per parsed composite operation. The
consumer-owned `ExecutionAccessRepository` adds only the lease's pure value
`Binding()` to its existing `AccessRepository`; the binding is correlation, never
positive current admission proof. Capture it once. Catalogue/bootstrap refuse
ordinary `workspace.New` construction or missing/invalid binding. Existing
Read/List/Context constructors and contracts stay compatible.

The trusted route, owned by Task/Chat and Core, must select this operation's
existing admission before calling Computer. It must restore the original seal on
reconnect/restart; request IDs, a startup config and an ambient latest-task lookup
cannot select or create authority. Compare owner/session/task/epoch/participant/
turn with the captured binding. Generation and CallID remain correlation values.
No lifecycle, approval store, consent cache or second authority engine is added.

Reuse the SAME lease for initial snapshot, every context/read, and final composite
publication, including an empty catalogue. No phase remints or extends execution.
Current Task/Computer owners, fixed deadline, cancellation and sealed policy are
checked again before publication. Snapshot qualification precedes Computer ->
Task callback entry; no native IO or owner mutation occurs inside either callback.
Native filesystem IO happens after the admission callbacks return. This proposal
requires real owner bindings and current settings composition before activation;
no root boot, schema, generated binding or method registration changes are made.

## TS parity

Catalogue candidates are only the selected participant's materialized `subtree`
grant scopes, in original order. Approval-only roots and exact-file scopes do not
become candidates. The limit is 32 unique nonempty IDs of at most 120 UTF-16 code
units. Duplicate/bound errors precede native IO. Two complete context passes check
all candidates; a refusal/change discards the whole collection. Empty is explicit,
with zero native calls and a final current-owner gate.

Bootstrap inspects `AGENTS.md` at the task scope root and each prefix through the
selected directory, with depth 32. It never inspects ancestors outside the scope
or other descendants. Reads are full, never ranged. Missing is `not_found`;
path denial/refusal, oversized, non-file and non-text instruction files are
`unavailable`; other errors abort with no collection. Each pass charges raw read
bytes, including a UTF-8 BOM, against 64 KiB, continues the bounded chain after
exhaustion, and resets the budget only for the second full pass. It retains no
partial text for an over-budget file. Full-read shape requires UTF-8, raw byte
count (text bytes or text bytes + three BOM bytes), lowercase 64-hex hash, and no
Page. The projected instruction (status/text/bytes/code) is compared, matching TS;
SHA is validated but is not compared or recomputed by orchestration. A final
context and current-owner gate precede publication.

Published contracts have independent DTOs and explicit conversion. Instruction
variants are closed: ReadInstruction -> `read`, MissingInstruction -> `not_found`,
UnavailableInstruction -> `unavailable`. Core must explicitly map these to the
existing wire surface; blindly serializing Go app/interface values is unsupported.
Exact coverage, consistency, next and precedence labels are preserved. Instructions
never expand roots, capabilities, task scope or ownership. Neither composite
claims an atomic filesystem snapshot or repeats possible effects.

## Verification limits

Co-located policy vectors cover candidate selection/bounds, two complete passes,
UTF-16 identifiers, depth/canonical directory bounds, byte budget/BOM/per-pass
reset, missing/unavailable/fatal distinctions, malformed full reads, projected
change, crossed correlation, ordinary construction, and final revoke/expiry/cancel.
Disposable native Store/filesystem/published-contract vectors cover narrowed scope,
physical roots, missing and unavailable instructions, concurrent edit, later-phase
revocation/generation/fixed deadline, empty catalogue, outer expiry, fresh symbolic
turn, reconnect and cold restore. Task owner and clock are controlled fixtures;
they are not live ChatGPT turns, owner settings, installed restart or connector
proof. Native cleanup is scoped to TempDir and exact Store.Close/child Wait in the
existing suite. No global process observation, provider call, search/regex, write,
shell/Git or production executor retirement is part of this slice.

The required final boundary review remains PENDING under the existing review
provider quota fence. Lead owns aggregate projection, review choice, root activation,
accepted main, packaging/install and same-chat Brain/code renewal qualification.

## Setup directory inspection

Adding or changing a folder starts its access check automatically. Setup uses
`computer.settings.inspect`, a content-free read under the exact current owner
publication, rather than requiring a stable listing of every child. The native
adapter opens the selected directory through no-follow descriptors, verifies its
physical identity and rechecks the approved root. Child-file churn does not
invalidate that access result. Listing and file operations retain their own
snapshot, scope and identity checks.

The response contains the original publication, workspace ID, relative path and
physical root binding; it contains no child names or file contents. Current
approval, exclusions, withdrawal and cancellation remain authoritative before
dispatch and disclosure. The host records a green folder check only after the
bound result and current configuration agree. A missing inspector fails closed;
it never falls back to listing or grants wider access.

The desktop adapter waits at most twice (100 ms, then 250 ms) for local
publication/read contention or a known undispatched backpressure failure before
trying the pure inspection. Changed generations, genuine refusals, unknown
responses and mutations are never automatically replayed. Persistent failures
remain actionable recovery states rather than successful checks.

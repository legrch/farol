# Go Computer write/edit source

Status: source-only implementation in the `computer-write` writer based on full
`829bb0fb368734daa14566b4cc3b1f25019a9036` (unaccepted dependency). No root
registration, common schema/generated change, durable journal implementation,
TS/Python executor retirement, package, installation or live qualification is
included. Lead owns canonical native/race/aggregate checks, cumulative review,
commit and integration. Existing refused/unknown operations remain frozen.

## Selected execution and durable intent

`New()` preserves pure Check. `NewForExecution` captures one trusted operation ID,
consumer-owned Execution lease, injected clock/gate, journal, digester and native
producer. Body owner/session/task/epoch/participant/turn must equal the selected
binding. Turn Generation and CallID are correlation, not Computer generation or
permission. The same immutable ordinary deadline is captured once; construction
rejects a lease beyond 15 seconds. No outer TaskGrant renewal or admission owner
is added. Root composition must supply the existing current-owner serialized lease
for every phase, including revoke/generation/restart fences.

Execute validates/clones the operation and fingerprints its exact payload. Its
journal identity is operation/owner/session/task/epoch/participant; workspace and
digest bind that identity. Atomic Admit must publish the exact Prepared record
**durably before effects**. A malformed/lost admission ACK is unknown and the
service never admits/dispatches again. Same-key payload/workspace changes conflict.
An Existing record grants no execution, including Prepared. A Prepared observer
reports unknown without saving a guessed interrupt over a still-active peer; Read
can later observe that SAME key's terminal result. Root journal owns cross-service
coalescing/incarnation tracking, result retention and client ACK; the module adds
no acknowledgement/deletion owner.

Current authorization is rechecked after Admit, at the native pre-effect boundary,
and during final disclosure. Both grant and current approval exclusions narrow
the native descriptor. No journal/native IO runs inside an owner callback. Local
pending calls report in_progress; they cannot become another Mutate. Only one
native Mutate attempt is admitted, and only one terminal Save is attempted. Lost
terminal publication acknowledgement retains the known completed/failed/unknown
fact in the same service as `memory_only`, without another Save. Restart sees the
durable record (possibly Prepared/unknown), never execution permission. Known
completion survives denied disclosure; a fresh selected reader may re-deliver it
under current owners. Read never Admit/Save/Mutate and exposes no ACK method.

Root/Core must map these independent in-process DTOs into the accepted wire
contract, including local pending/not_found states. They are not advertised public
methods. Source checks cannot prove production activation fencing or atomicity
between the synchronous current-owner callback and the following native syscall.
The trusted root must qualify that handoff and confinement before activation.

## Operation and fingerprint parity

Write's nullable expected SHA256 is create-only when null; a string must match the
entire original bytes. Edit requires a lowercase expected hash and 1..256 ordered
old/new pairs. Missing edit is not_found, stale/different preimage is conflict.
Requests retain the existing 8 MiB UTF-16-unit limit and native 8 MiB UTF-8/aggregate
ceiling; paths and hashes retain the pure domain bounds. Native component parsing
also retains the existing filesystem byte/component limits.

`filesystem.Digester` emits the exact JS JSON.stringify array for valid UTF-8
values: workspace, `workspace.write/edit`, path, nullable expected hash, content or
ordered edit pairs. It excludes outer identity/turn/generation/call. It preserves
raw HTML, Unicode, U+2028/U+2029 and JS control escaping. Go domain cannot represent
unpaired UTF-16 surrogates: the future wire parser must refuse them before lossy
replacement rather than claim legacy fingerprint parity for such strings.

Native edits match simultaneously in the original LF-normalized view; each old
text must be unique, including overlapping occurrences, and original spans must
not overlap. CRLF matching, untouched bytes, BOM and replacement-local line endings
are preserved. Result bytes are bounded. The app validates receipt kind/path,
preimage hash, replacement bounds and SHA shapes; the native producer computes the
actual pre/post digest and final observation.

## Native publication and ownership limits

The Darwin producer uses descriptor-relative no-follow traversal and approved
ancestor device/inode verification. It pins the root/parent chain and rechecks
physical name bindings, modes and owners before effects. Root must have current
UID and no group/other write bits. Symlinks, hardlinks, FIFO/nonregular files,
credential exclusions, Git metadata and write-denied paths are refused. There is
no non-Darwin implementation or plain-rename fallback.

Writes may create absent parents. Each mkdir follows the same current guard;
a successful parent creation is already a possible effect, so any later failure
or cancellation is unknown. Private sibling staging is mode 0700; its candidate is
exclusive/no-follow, written, chmod'd and fsync'd. Existing target mode is preserved.
Create publishes with one Linkat that cannot overwrite. Replace publishes with
one Darwin RenameatxNp(RENAME_SWAP), then verifies the displaced original inode
and expected digest through a descriptor.

**One effect means one admitted native Mutate attempt.** A displaced-preimage
mismatch permits at most one guarded internal undo while the target still holds
the owned candidate, before reporting any outcome. A newer target prevents undo.
A failed/lost undo ACK, a changed recovered candidate or a newer object moved to
staging is unknown: retain stage/displaced objects, no additional undo/cleanup
attempt and no executor retry. Unsupported swap refuses without weak rename.

Cleanup deletes only an immediately verified owned staging candidate or checked
original, removes only the same empty stage directory by rmdir, and never recurses.
Uncertain cleanup retains the stage and reports unknown. After the last workspace
mutation, parent fsync and final descriptor readback require the candidate's inode,
single link, mode/owner, size, modification time and exact digest. Failure/cancel
then is unknown. A later writer after the final observation is a separate write.

This is the existing bounded swap/verify/guarded-undo algorithm, **not adversarial
same-user isolation or atomic hash CAS**. Residuals include an already-open original
written after its digest check, an already-open candidate changed after undo
verification, a save between the pre-undo identity check and swap (retained in
staging), deliberately replaced/written staging entries, and revocation/parent
rename in the check-to-syscall interval. Descriptor pinning detects substitutions
at observations but cannot prevent every intervening same-user/root action. No
stronger confinement/ownership claim follows from the injected tests.

## Verification boundary

App/contracts tests inject owners, clock, journal, native receipts and gate. New
filesystem tests inject a private in-memory inode/FD/syscall model; digest/edit
vectors use synthetic text. They cover expiry/revoke after durable admission,
one attempt, uncertain admission/save, restart Prepared, pending peer observation,
retained disclosure, create-only/hash/conflict, safe undo/newer saves, uncertain
cleanup/cancel, parent identity, BOM/mixed endings and exact fingerprints.

These tests never execute the native filesystem producer on real files and do not
prove durable persistence, Darwin syscall/filesystem behavior, fixed-lease native
cancellation/confinement, race safety, common route export, installed same-chat
Brain/code renewal, shell/Git, native providers or production acceptance. Native,
race, full CI, review, commit and activation remain in Lead's canonical lane.

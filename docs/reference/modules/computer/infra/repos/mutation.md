# Computer private mutation repository

Source-only Go adapter for the existing `PrivateWorkspaceMutationStore` contract.
No boot registration, schema/TS changes, legacy-state inspection, migration,
repair, runtime activation, filesystem qualification or execution is included.

`New(ctx, Root)` takes an explicit, independently qualified existing private root
and physical identity. Both that root and its `mutations` child must already
exist and have owner-only permissions. Construction retains native descriptors
and one nonblocking writer flock in the root. There is no mkdir/chmod, PID probe,
lock stealing, path fallback or automatic successor. Other executors do not
honor this new adapter's lock; Lead must qualify an exclusive handoff before
activation. The lock is adapter ownership metadata, not another task journal.

Records retain schemaVersion 1, kind `workspace_mutation`, the same filename
SHA256 over JSON.stringify identity array, the content-free record/receipt/error
shape, UTF-16 identity limits, safe integer epoch, 64 KiB bound, canonical field
order/escaping and trailing newline. Canonical valid UTF-8 v1 bytes only are
accepted. This does not promise all input accepted by TS's JSON.parse/Zod: old
noncanonical bytes, unsafe integers, unpaired UTF-16, alternate versions and
Go-only COMPUTER_* / authority-store failures are refused without conversion.
Those newer failures remain known in the app as memory_only when Save refuses.
No schema enum is widened here. This is a compatibility limit, not a migration.

Admit serializes exact-key lookup and create-only durable publication. Existing
Prepared/terminal is observation, never another execution permit. Save permits
only an exact no-op or Prepared-to-terminal with immutable binding. One failed
publication or lost/cancelled acknowledgement fences the retained writer,
including Load, so visible unconfirmed bytes are not labelled durable. A later
owner requires independent Root qualification; disk history never admits work.
Load only reads: it creates/repairs/syncs/removes nothing. Close releases owned
descriptors once and retains records, lock and uncertain staging. No result ACK,
deletion, task admission, lease or effect execution is owned by this package.

Native publication follows the existing private sibling staging algorithm:
exclusive 0600 temp, bounded write, file fsync/close, create Linkat or terminal
Renameat, exact owned temp cleanup, directory fsync, exact final readback.
Only this attempt's checked temp may be removed. There is no orphan sweep.
Descriptor/name and previous-byte observations detect substitution; they do not
provide adversarial same-user isolation or atomic CAS against writers ignoring
the exclusive ownership contract. Parent replacement, open-FD same-user writes
and check-to-syscall races remain native qualification concerns.

Tests use a private injected byte store, without New/native adapter calls, real
filesystem/profile/process operations, Electron or live state. Targeted CPU/race,
codec and publication-fault evidence does not prove Darwin persistence/crash
windows, host cleanup, restart qualification, installation or product acceptance.

`ConnectorProcessReservation(scope)` supplies a source-only `process.Reservation`
port from this SAME Repository, with no constructor IO and an exact scalar scope
copy. It uses the existing external-connector-v3 stable operation key shared by
write/edit, and a separate strict schemaVersion 4 `workspace_connector_process`
record. Legacy mutation APIs refuse v4; process reservation refuses v1-v3.
The reservation retains the full host, call, generations, original task binding,
launch seal, physical root identity, root/cwd, and original deadline. All uint64
counters are lossless canonical decimal strings, consistent with the access
owner's full-width counters; this format does not apply v1-v3 safe-integer limits
or relax the process app's own admission guards. Deadline is a positive signed
int64 UnixNano decimal string with an exact time roundtrip. There is no ambient
clock, expiry renewal, command/argv/stdin/output or credential persistence.

Only a new durable create with exact readback returns Reserved. Exact retained
bytes return Existing, including an independently injected repository lifetime;
changed scope/intent and a different record kind refuse without replacement.
Lost publication ACK, readback substitution and post-create cancellation/check
failure fence the same repository, including ordinary mutation APIs. An EEXIST
race supplies Existing or refusal/unknown, never a fresh permit. No retry,
repair, deletion, result, terminal record or retirement acceptance is provided.
Pure tests use memory storage and the existing process Service with a fake
selected child. Separate Darwin tests in `processnative_test.go` exercise real
disposable repository roots: durable reservation, duplicate observation after a
known Close, changed-host refusal, and the shared process/write operation fence
in both orders. They independently inspect the original record key, bytes and
permissions. Host, consent and execution identities remain fixtures; these tests
do not qualify crash recovery or a process launch. Root production registration,
shell/process execution, Task/provider activation and packaging remain unactivated.

## Preselected owner Completed observation

Known limitation: the separately selected preserved-record inspection and its
IPC contract remain limited to 128 records. Fresh-start history inspection does
not change that recovery limit or grant permission to replay an unknown effect.
The fresh inspection also fails closed above 4,096 retained files or its byte
budget. Further native qualification should cover the 4,096/4,097 boundaries,
partial directory reads, individual close failures and cold-start performance.
The separate staging baseline still inspects at most 128 records; beyond that,
the optional Deep test is unavailable. Historical writable processes without
confirmed descendant cleanup can independently withhold that test. Supporting
such profiles remains future work and must not infer settlement or replay.

`InspectOwnerCompleted(ctx, root, OwnerSelection, []ExpectedOwnerRecord, visit)`
is a separately selected read-only observation of an existing private store.
`OwnerSelection` binds owner, profile and computer. Composition independently
selects exactly 1..128 canonical keys, complete stored-byte SHA256 digests and
full immutable owner-settings bindings before IO. Selection is copied and
validated with the original key and domain Prepared validator; directory contents
never discover or expand it.

Only canonical schemaVersion 2 `workspace_owner_mutation` owner-settings
Completed records qualify, using the existing codec and record qualifier plus
valid Write/Edit receipt shapes. Other schemas/scopes, process records,
Prepared/Failed/OutcomeUnknown, mixed sets, crossed identities, altered bindings
or bytes, missing/duplicate/extra records and staging refuse. The existing
exact-empty, exact-two v3 settled, exact-five interrupted and preserved policies
remain independent and unchanged.

The caller's original absolute deadline is required and captured once before
native observation. A fixed context checks that deadline directly as well as
cancellation, including when the original context's timer lags. The Darwin path
reuses `inspectBoundedNative` and `observeSettledRecords`, opening only existing
state under the original exclusive mutation lock with retained pins. It never
opens a mutable repository, creates a lock, writes, repairs, syncs, deletes or
poisons a store. Other platforms return unavailable.

The trusted visitor is synchronous, read-only and non-reentrant; it must honor
the original context/deadline, return normally and launch/defer no work. The lock
and pins remain held through the full final namespace, bytes and metadata
recheck even after visitor error or cancellation. Expiry/cancellation or a
recheck/close failure takes precedence; otherwise the original visitor error is
preserved. All failure paths return no partial result. Visitor and result slices
are independent of each other and the copied input. A stuck callback cannot be
forcibly interrupted; cooperating locks and repeated observations do not provide
atomic isolation from same-user writers ignoring the lock.

`OwnerInspection` reports root, mutation-directory/lock device and inode, and
sorted retained key/digest/identity values. These are recorded historical
observations only: no mutable State or receipt body, ACK, current authority,
original process closure or successor proof. Root composition still owns
maintenance/process exclusion and every other profile journal. This supplies no
recovery, admission, retirement, replay, relocation, cold-boot, cleanup or
promotion authority and selects no normal/installed route.

Pure tests cover canonical selection, bounds, identity/digest/binding/scope/phase
refusal, slice ownership and visitor/cancellation/absolute-expiry precedence.
Explicit Darwin flag `-owner-inspection-native` enables retained disposable
actual filesystem fixtures for 1..128 bounds, lock retention through final checks,
record replacement, extra inventory, relocation, metadata and cancellation
refusal, and preservation without writes/fences/repair. Every owner-inspection
fixture is retained under `/private/tmp/farol-owner-inspection-*`, including
failed/unknown cases. These synthetic records are neither successful app
publications nor process, ACK, recovery or installed-route evidence.

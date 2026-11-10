# Computer Stop prerequisite: original-operation custody

Status: proposed, before implementation. Source baseline: `c430010177aed88e266872e0c815b3c5041381c6`.
This is a narrow amendment to the accepted [transition decision](workspace-transition-decision.md),
not runtime, package, installed, or release acceptance.

## Question, timing and success

Before implementing the production continuity route, how should the existing
Computer owners prove the ORIGINAL prerequisite Stop, stopped-Settings publication,
and cleanup completed before admitting the first migration WAL? Decide before
building this producer; there is no artificial provider deadline.

Success: original-operation intent precedes every effect; each original ACK is
retained and independently correlated; restart, lost replies, and a second ordinary
request cannot turn uncertainty into success or dispatch another Stop. Fresh setup
and legitimately already-stopped commands remain usable. This is not new authority.

## Evidence and scope

The existing read-only `computer.continuity.status` protects an existing C4 WAL,
not an unrecorded earlier Stop. This design packet asserts no test outcome.

Relevant existing owners:

- `src/apps/desktop/main.ts`: `stopAndConfirmComputerMcp`,
  `configureDrainedWorkspaceChange`, owner Stop, repair, recovery, update and quit.
- `src/apps/desktop/workspace-configuration-drain.ts`: in-memory Stop/record/apply.
- `src/modules/computer/infra/mcp/private-mcp-lifecycle.ts`: native lifetime
  exclusion and stop confirmation; its marker and confirmed revision do not prove
  a historical cross-process ACK.
- Existing `ProductConfigurationService` and `ProductSettingsStore`: sole Settings
  writer and conditional publication. Generic commit/read fallback is insufficient.
- `modules/computer/infra/repos/access/{store,journal,transition}.go`: protected
  Computer owner, lifetime lock, bounded canonical WAL and classified publication.
- `modules/computer/app/services/migration/owner.go`: `Prerequisite.Completed`
  currently accepts a boolean, which does not bind an original operation.

`settingsdelivery` is a workspace FILE-EDIT service, not a ProductSettings journal.
Operations audit and a legacy run/stopping marker are not effect receipts.
No new writer, database, provider call, or approval owner is authorized here.

## Options

1. Keep the in-memory prerequisite and infer completion from stopped bytes.
   Reject: lost original replies/restart permit unsafe admission.
2. Move prerequisite effects inside C4 before its WAL, or fold native Stop and
   Settings writing into a new generic transaction engine. Reject: effects would
   precede custody or ownership would move across the accepted boundary.
3. Add a typed prerequisite record to the existing C4 WAL. This CAN preserve
   durable-before-Stop ordering and existing ownership; it is not rejected on the
   false premise that sharing one file moves native/Settings ownership. It would
   need a new closed journal document/entry schema and compatible readers: the
   current schema-1 decoder rejects unknown fields and the current transition
   state machine treats its entries as migrations. Pending/terminal, capacity,
   first-publication and current-admission predicates would all need to distinguish
   prerequisites from children. It eliminates cross-file reference retention, but
   expands the already-built C4 journal/reader state machine and its compatibility
   surface before production qualification. A future coherent unified schema is
   credible; it is not assumed to be a drop-in unchanged WAL entry.
4. Extend the existing Go access owner with one narrow protected prerequisite
   record family, retaining native Stop and TS Settings ownership. Recommend this.
   It keeps existing C4 transition PHASE semantics and the existing lock witness
   intact, but DOES require the closed C4 certificate-link schema extension below.
   Cost: one additional protected file/witness and explicit immutable certificate
   reference retention. Single-file C4 child admission below removes any need for
   an atomic publication across those files. The trade-off favors this bounded
   separate family for this candidate; it does not claim fewer total code lines
   or inherently better safety than a fully specified unified schema.

## Selected construction constraints

Use the existing access private directory, lifetime lock and Store mutex. Proposed
files: `computer-stop-prerequisite.json` plus a permanent first-presence witness
`computer-stop-prerequisite.present`. Reuse protected descriptor-relative I/O
principles, not a second owner: no-follow, exact owner/mode/binding validation,
bounded canonical closed JSON, CAS, fsync, directory sync, and exact readback.
Do not change the existing lock's single-byte C4 witness format implicitly.
A presence witness with absent/corrupt/mismatched ledger refuses admission. A ledger
without its required witness also refuses. Qualify a compatible reader and witness
before enabling a writer. An uncertain first publication poisons the current
operation. No lossless history before confirmed first durable admission is claimed.

Retain original parent UUID, canonical request digest, purpose and exact scope,
expected Settings revision and generations, current runtime/backend binding and
trusted boot correlation. Distinct one-shot Stop, Settings and cleanup effect IDs
retain their original intents and exact ACKs. A caller-provided boolean, stopped
process observation, or equal Settings bytes cannot replace an ACK. Strictly bound
record capacity never evicts unfinished/UNKNOWN custody or silently recycles IDs.

Closed phases are admission intent, Stop intent/ACK, Settings intent/ACK, cleanup
intent/ACK and prerequisite complete. Known pre-effect refusal needs positive proof
no Stop dispatched. Every ambiguous effect, lost reply, malformed receipt or uncertain
persistence stays unresolved; do not fabricate later delivery evidence. The original
operation is observational only after uncertainty, including after restart.

`refused_before_stop` is an explicit known-terminal no-effect phase. It requires
positive original evidence that Stop dispatch never occurred (including a known
not-written Stop intent); retain the original admission/refusal evidence and
release its current reservation without a migration certificate. It is not pending
custody and permits a later independently identified ordinary command. Ambiguous
intent publication or dispatch can NEVER enter this phase or clear a pending fence.

Under the existing authority-change reservation, create/retain the original UUID
before the first await/effect, capture the request and current binding, then:

1. Check pending prerequisite and C4 custody before any new native effect.
2. Confirm durable admission and Stop intent before native Stop dispatch.
3. Existing desktop/native owners perform exactly one Stop. Require original
   lifecycle revision, connector drain/cleanup and Go closure binding receipts.
4. Go confirms the matching original Stop ACK; a lost ACK is never redispatched.
5. Confirm stopped-Settings intent, including expected revision and exact next
   document digest. In the existing writer's exclusive scope, use one narrow
   conditional-save/readback method; no generic commit fallback or reclassification
   of equal bytes after an unconfirmed call.
6. Confirm original Settings ACK and separately admitted verification-receipt
   cleanup ACK. Cleanup failure prevents a complete certificate.
7. Confirm a terminal prerequisite certificate bound to the original request.
   `migration.Begin` verifies its exact receipt instead of `Completed() bool`.
   Use the single-file child-admission protocol below; never assume a mutex makes
   two filesystem publications atomic.

### C4 certificate-link format and reader boundary

The selected option does NOT claim unchanged C4 bytes or schema. Add a closed
schema-2 C4 document/entry extension for the parent certificate reference, stable
child intent (including mode), and full child request digest. Preserve existing
transition phase rules and original schema-1 semantics. A compatible reader first
strictly reads both historical schema 1 and new schema 2 without interpreting
absent legacy fields as a new certificate. Linked admissions require all schema-2
fields; old schema-1 entries cannot acquire invented parent ACKs or mode bindings.
Schema 2 has its own exact canonical encoder/decoder; reject unknown/duplicate or
inconsistent fields instead of relaxing the schema-1 decoder.

The first linked child admission upgrades and appends in the SAME single C4 WAL
publication under its existing lifetime lock/witness, after compatible readers are
qualified. Unknown format publication remains original restrictive custody. Prior
schema-1-only readers are incompatible with the new format and must refuse it;
0.5.23's broader lack of custody support is not qualified rollback. The separate
prerequisite family still avoids mixing prerequisite phases/entries into the C4
state machine, but its compatibility cost includes BOTH record families. Real
startup, recovery and package/update reader exclusion remain activation gates.

### Single-file child admission and restart

For a workspace migration, the original prerequisite admission already fixes ONE
intended child UUID and a versioned `childIntentSha256` before Stop. This is a
canonical projection of the stable command intent: command kind, explicit closed
migration mode (`legacy-confirm` or `enrolled-rebind`), exact selected
workspace/profile/computer scope, requested fixed root and unchanged permission
fingerprint. Mode is independently bound even if command kind happens to imply it;
Begin and Confirm must match the original mode before any mode-dependent effect.
It EXCLUDES the later Settings revision/generation, native observation,
boot-derived evidence and any measured resulting binding. It is not the digest of
the full future C4 journal request. The original prerequisite's own request digest
also retains its captured pre-Stop expectations without pretending they are the
future migration snapshot. These values are immutable. Other Stop purposes cannot later be
upgraded into a migration certificate. No mutable consumed bit is written to the
prerequisite file as part of child admission.

Under the existing Store mutex/lifetime lock, `BeginTransition` verifies the
complete immutable prerequisite and exact intended child. AFTER known Stop,
Settings and cleanup completion, capture the actual resulting revision/generation
and policy snapshot as required by the accepted transition decision. The terminal
certificate retains the exact original stopped-Settings ACK/digest and these
post-prerequisite expectations. Begin checks that the full child's stable intent
projection equals `childIntentSha256`, its revision/generation and policy match
that original post-prerequisite evidence, and current trusted bindings are fresh.
A later unrelated change refuses admission; it cannot substitute a new snapshot.

Then atomically append ONE C4 admission entry containing parent UUID, certificate
digest, child UUID, stable intent digest and canonical FULL child request digest
to the existing C4 WAL. This single C4 publication is the
sole durable consumption authority. It refuses a different child, a changed
full request, mismatched stable projection/post-prerequisite expectations, or a
conflicting retained parent/certificate reference. The original child ID and intent
never change when the exact post-Stop snapshot is added. Same-child
observation does not dispatch native work or reconstruct lost delivery.

Crash before confirmed C4 admission dispatches no child native effect. If its
publication is uncertain, retain the original child uncertainty and restrictive
custody; do not dispatch/repeat Begin or Stop to learn whether the write happened.
On restart, a matching retained C4 entry identifies only that original child;
missing, mismatched or uncertain evidence stays restricted. A known unconsumed
certificate with no child entry may be inspected, but it never authorizes a new
child UUID. Historical caller delivery remains unknown unless separately recorded.

The certificate is immutable during admission, so there is no interval with a
consumed-parent write but absent child write, or an admitted child followed by a
required second consumption write. Never delete/recycle a prerequisite certificate
or C4 consumption reference while any unfinished/unknown child depends on it.
Completed record succession needs explicit known-terminal, cross-reference-safe
retention under the same owner; exhaustion refuses a new effect rather than evicting
custody. Ordinary subsequent commands receive new original identities and never
reuse an earlier certificate. Production activation waits for bounded succession
and all crash-window tests, not merely the initial happy-path append.

No Go mutex may be held across a native desktop or TS Settings callback. Original
Stop suboperations keep their own existing ownership and cleanup evidence. Protective
cleanup on shutdown remains distinct from permission to replay an uncertain effect.
Current binding/policy freshness still needs revalidation; a historical certificate
is not current Computer authority. Terminal historical result and caller knowledge
remain separate. Observation never becomes a new permission to execute.

## Real paths, restart and compatibility

Integrate admission checks into live workspace drain, already-stopped workspace
changes, explicit owner Stop, authority-changing direct Stop, connector repair and
Start/recovery, challenge-failure cleanup, update drain, and quit. No caller may
bypass the pending original operation merely because no C4 WAL exists yet. A fresh
setup with no pending effect and no required Stop does not create a spurious pending
record. Define and test bounded lifecycle of completed records so ordinary later
commands remain possible without losing unknown custody.

On restart, pending or malformed custody stays restricted. Re-observe only the
original UUID; do not manufacture an ACK from a legacy stopping marker or clean
host. A complete certificate can be observed/requalified without redispatch.
The old 0.5.23 binary does not understand the new record family. Production writers
remain disabled until actual startup/recovery/compatible-reader behavior and any
update/rollback compatibility boundary are qualified. Do not claim old-version
rollback preserves new enrolled authority.

## Tests and acceptance conditions

Proposed, NOT RUN: first intent failure means zero Stop; lost Stop ACK and restart
mean no second dispatch; unknown Settings CAS blocks migration despite equal bytes;
known pre-rename refusal supplies no fabricated ACK; wrong UUID/runtime receipt is
refused; concurrent workspace edit/Stop/Start has one owner; cleanup failure cannot
certify; child B cannot consume child A's certificate; missing witness/ledger fails
closed; fresh setup and safe already-stopped changes still work; bounded terminal
record succession preserves ordinary subsequent commands. Exercise actual existing
caller seams, not only isolated helper state machines.

Implementation proceeds as source checkpoints with L0 checks. Production activation
still requires real compatible readers/recovery, actual native folder qualification,
the complete source-risk review, full CI and separate package/installed gates.

## Reversibility and dissent

Before writer activation this is reversible source design; after first durable
record, old readers cannot safely ignore custody. This compatibility cost is the
strongest dissent. It would favor a unified existing journal format only if that
format can retain independently admitted original prerequisite ownership, missing
record detection, and all existing C4 reader semantics without ambiguity. Review
that trade-off explicitly. Delay costs further helper-only work while the actual
runtime path remains disabled; do not relax admission to accelerate release.

Unknowns requiring implementation proof include exact native closure correlation,
conditional-save error classification, the specified single-C4-publication crash
oracle, terminal capacity/recovery, and actual old-reader exclusion. The first implementation
must expose these limits rather than call a proposed test or helper a working route.

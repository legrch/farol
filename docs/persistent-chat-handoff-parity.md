# Persistent handoff parity

Status: saved-project create/status/exact-result, active-turn message,
same-thread continuation, neutral task-model policy and read-only adopted-turn
status are integrated on standalone main. Their control tools remain gated by
serving-host qualification. The saved ChatGPT Browser create/status source is
integrated with synthetic page/IPC/MCP and packaged fake-endpoint transport
fixtures; live Browser/account proof is still required. No native shared-runtime or
live-model qualification has been completed.

## Two different destinations

| Route                      | Owner-visible result                                                                            | Current standalone state                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Saved ChatGPT conversation | A normal-history browser conversation with an exact first message and later reopen proof        | Integrated source; synthetic page/local IPC/MCP and packaged fake endpoint fixtures; no live Browser/account proof |
| Persistent Codex task      | One task in an **existing saved Codex project**, one issued turn, status and exact final answer | Integrated create/status/result; disposable connector fixtures; no live task                                       |
| Product Agent              | A correlated child of the current host task                                                     | Intentionally disabled; it is neither of the handoff routes above                                                  |

The V0 browser route is documented in the V0 repository's
`docs/persistent-chat-handoff.md`. Its Legacy browser partition, Hub bridge,
receipts and fixture results do not transfer into this standalone repository.
Neither route changes temporary Consult defaults or grants Product Agent
admission.

The saved-chat candidate uses the active new-product Browser partition, a
private write-once journal and a hidden sending surface. A UUID reservation and
durable send-intent precede the only Send click. A candidate URL is not success:
the sending helper exits, a new helper reloads the exact canonical private URL,
and the first user message plus a link inside a visible history container must
match. Title verification is reported separately. Unknown transport, click,
navigation or journal outcomes never cause another Send. The desktop owns the
Browser route and a short-lived authenticated local socket; the Computer MCP
process receives its endpoint only in the sealed launch contract. A missing
endpoint means neither `chatgpt_chat_create` nor `chatgpt_chat_status` is
advertised. Normal launches are default-off. For a disposable packaged preview,
the owner can set `FAROL_NEXT_SAVED_CHAT_PREVIEW=1` on the `task run`
process after the new build's ChatGPT Setup connection has been verified, then
restart and refresh the new connector. Publication requires that opt-in and a
current, unambiguous Next-partition readiness receipt for the exact build.
Before durable Send intent, Farol shows the exact key, requested title,
request digest and first message in a native owner confirmation dialog. Denial
is recorded without a Send; missing owner window refuses. Immediately before
the submit call it rechecks the same build/profile admission. The readiness
receipt proves a signed-in partition, **not the account ID**; the owner must
inspect the intended account in the same Farol Next Browser partition before
the one-send confirmation. An account-writing
operation retains its desktop execution-fence lease until its Browser work
finishes, even after the MCP caller disconnects. Connector stop drains the
bridge and revokes its socket before reporting a confirmed stop. A disconnect
observed before the page submit call prevents Send; one during or after the
asynchronous page script leaves an outcome-unknown receipt without retry. A
fixture endpoint proves
transport only; current selectors, owner account selection, connector schema
refresh and persistence still need one bounded live canary. A Computer folder
grant alone never authorizes the external send, and an outcome-unknown response
must not be retried under another key.

## Read-only target-bound project resolution

`codex_project_resolve` reads the saved-project catalogue through the existing
task route and its approved physical authority. It returns `writerRoot` separately
from the canonical `projectRoot`, plus explicit resolved/missing/ambiguous/stale
selection or unavailable outcomes. Only matching canonical-root project IDs/names
are disclosed. A complete scan is bounded to 32 pages of at most 100 entries and
32 matches; malformed, duplicate, cyclic or partial pages never prove absence.
The supported optional omitted `nextCursor` is terminal. A matching requested ID
can disambiguate; a stale ID never falls back to a different project.

The sealed task admission keeps its existing exact project ID. The MCP does not
take a root path, create a project, persist a preference, edit a title, read
history or launch/resume/fork a task. It remeasures the writer/canonical repository
binding and checks expiry/cancellation before returning. Project creation with
unknown-outcome reconciliation, automatic preference-based admission and broader
project-scoped history discovery remain separate unimplemented N3 rows. Cancellation/deadline stops
further catalogue pages; an already sent read remains bounded by its transport
response/timeout, and Farol does not kill the shared server to cancel observation.
Fresh-install project
creation is not qualified by this read-only slice; existing task-create ambiguity
rules are unchanged.

Public MCP and packaged disposable-socket fixtures qualify this source route.
They do not qualify the serving native Desktop identity or experimental protocol
negotiation. The separately prepared initialize/experimentalApi patch remains
behind its recorded platform-blocked commit operation; this slice neither moves
that patch nor bypasses the refusal. No real model/provider task is used merely
to resolve a project.

Observer metadata maps the supported optional nullable host Thread.name field to
the public title field. It does not fall back to an unrelated title-shaped host
property. Malformed names remain unknown; omitted/null names return null. The
local host-contract inspector requires the supported name field shape. This
does not itself qualify title mutation or prove the serving native host's field support.

## Qualified one-shot task name update

`codex_task_title` is wired through the published task contract, admission and
Computer MCP only when the serving host's explicit title control capability is
selected. Ordinary production construction leaves it off. Local schema evidence
for `thread/name/set` is optional and separate from ordinary create/status
qualification; it cannot enable serving control. The proxy allowlist adds only
this method and leaves the separately refused initialize/experimentalApi change
untouched.

The caller supplies the issued dispatch handle, exact workspace/project IDs,
one UUID key, expected nullable name and a nonblank new name of at most 1,000
UTF-8 bytes without NUL. Only a verified Farol-created dispatch is controllable;
an adopted owner task remains read-only. Current canonical project, physical
writer, policy, thread, model and admission are rechecked. A changed initial
name returns `title_changed` without a durable intent or provider mutation.
A private dispatch-scoped immutable intent precedes the one setter. The name
and text are not persisted in the journal, only the digest and key-correlated thread receipt. An orphan or mismatched
confirmation fails closed and cannot confirm a new operation.
Concurrent requests cannot send a second setter, including a different key.

Expected-name preflight and supported Thread.name readback are not a native
atomic compare-and-set: a native client can rename between them. A late changed
readback, lost acknowledgement, expired/revoked admission or failed receipt
publication stays `outcome_unknown`. An unconfirmed title blocks further steer
and continuation, including an intent appearing between initial checks and the
mutation-fence preflight. Unconfirmed steer similarly blocks a title effect.
Post-mutation read failures cannot release the fence as a no-submit error.
Matching replay returns `recorded`/`historical`; it proves the old acknowledged
update, not the current name. `renamed`/`readback` is the current observation at
that read, not an enduring title guarantee. Exactly one update is permitted per
dispatch, including after confirmation; arbitrary repeated V0 rename parity is
not claimed. Broader native owner-task control remains separate.

Real private-journal and proxy-process fixtures plus in-memory public MCP tests
prove these limits without model tasks. Packaged default-off catalogue evidence
must prove the title tool remains absent on unqualified bytes. There is no live
native rename, shared Desktop identity or serving capability claim.

## Separately granted stored task metadata discovery

`codex_project_tasks` requires the separate sealed `discoverProjectTasks` grant
for the exact saved project and physical writer. The ordinary create grant does
not imply it; the production desktop issuer currently leaves it absent. Issuing
that opt-in requires serving-host qualification for the database-only list shape,
separate from the local generated-schema inspector. A generated local CLI schema
cannot prove the serving endpoint honors the flag or grant it automatically.

The default route reads one `thread/list` page with explicit project ID, exact writer cwd,
`useStateDbOnly=true`, non-archived filter, descending updated-time order and limit 50. The flag asks the supported host to avoid JSONL scan/repair; Farol does not
open its private database or rollouts. Current canonical-root project membership,
writer identity, expiry and cancellation are checked before and after reads.
Missing/unverified projects and replaced/revoked roots never disclose metadata.

The response labels stored, non-atomic, single-page metadata and selected-writer
scope. `controlGranted=false` is invariant. It returns task ID, nullable name,
configured-model metadata and update time only; no prompt preview, transcript,
reasoning, private path or execution-status claim. configuredModel is not a
per-turn execution binding. Titles/models have a 32 KiB aggregate UTF-8 ceiling,
with at most 50 rows. Foreign or malformed entries, duplicate IDs, invalid/cyclic
cursors and oversized pages fail closed instead of being silently filtered.
`complete=true` requires an initial terminal page; it does not include other
writers, archived tasks or all project history. An ID is an explicit selection
candidate, never permission to observe, adopt or control it. Owner task selection
and serving/native identity remain separate qualification steps.

Pure policy/public MCP/proxy-process and packaged disposable-socket fixtures
prove the source route. No model turn, real task discovery, private database
access or provider mutation is performed in those fixtures. Ensure/persisted
automatic project selection, project-wide discovery across other writers and Claude history
remain unimplemented; this is not complete V0 parity.

### Canonical checkout plus selected writer opt-in

The optional canonical-and-selected-writer scope additionally requires sealed
`discoverCanonicalProjectTasks=true`; existing discovery grants stay narrow.
The production desktop issuer leaves both discovery opt-ins absent until the
serving list contract is qualified. No owner profile is edited by this source
change. A granted fixture uses one supported cwd-filter array containing only
the physically verified canonical checkout and current writer; equal paths
collapse to one string filter. The caller cannot submit root paths. No fallback
to an unfiltered project scan or two repeated host calls is permitted.

The scope is correlated through the public MCP request, admitted route and
response parser. Metadata from any third cwd refuses the whole page. Canonical
and writer identities are remeasured before and after provider I/O; revocation,
expiry or replacement cannot disclose rows. The response remains stored,
non-atomic, bounded metadata with controlGranted=false. This enables an explicit
primary-checkout discovery fixture; it does not cover all linked writers,
transcript history, owner-task adoption/control or live Desktop compatibility.
Real host support for the array filter and the separate opt-in remain unqualified.

## Stored history read/tail for an exact selected turn

When an exact owner-selected thread is sealed in the task admission,
codex_task_history reads a single text-only page for an explicitly supplied,
verified turn in that thread. The physical writer and canonical project roots are
remeasured. Saved-project membership and exact thread/project/cwd are checked;
the latter is read again after item retrieval. No task start/resume/fork, adoption,
message, mutation fence or journal effect is made. Selection does not grant control.

The response labels source as stored, snapshot as non-atomic and coverage as
single-page-text-only. The read proves provider history, not live execution or
native Desktop identity. One page has at most 50 items and 32 KiB of aggregate
UTF-8 message text. tail=true asks for descending order; a continuation keeps the
same direction and exact thread/turn. nextCursor explicitly reports more items.
complete is true only when no input cursor was supplied and the page has no next
cursor; it never means all raw transcript content was returned. User text parts
preserve their boundaries, assistant commentary/final-answer text is explicit,
and non-text user content, reasoning and tool payloads are omitted with counts or
type-only records. Foreign/duplicate entries, oversized text, malformed/looping
cursors and partial turn scans cannot disclose a successful history page. The
turn lookup is bounded to 32 pages of 100 records.

Cancellation/deadline is checked between reads and before output, including after
authority awaits. Revoked or replaced physical authority cannot disclose text.
An already submitted read still waits for response/transport timeout. Reads are
not an atomic snapshot and never imply permission to control another owner task.
This does not yet provide project-wide thread discovery/search or Claude history.
Synthetic and packaged disposable-socket evidence is separate from the pending
owner-created observer canary.

## First Codex saved-project task slice

The selected first path is: explicit owner request → approved Computer workspace
and current physical writer root → exactly one **existing** saved project at its
canonical project root in the same Git common directory →
durable one-key reservation → one persistent `thread/start` → one `turn/start` →
issued dispatch handle → exact metadata-only status. Zero or multiple project
matches, root drift and policy drift refuse before a new side effect. A lost
acknowledgement remains outcome-unknown; replay never creates a second task or
turn.

`PersistentCodexHandoff` in Chat app code owns the closed create/status
policy. The result extension pages `thread/items/list` with the issued
`turnId`, checks every returned entry against that turn, and returns text only
from one explicit `final_answer` item after the turn is completed. Incomplete,
foreign, conflicting or unreadable results remain outcome-unknown; a result
read never starts work. The private append-only journal and request digester
have hermetic tests for conflicting keys, restart, lost acknowledgement and
exact status/result readback. The caller supplies a workspace ID, not an arbitrary root;
the trusted adapter must resolve the approved writer and canonical project
roots, both device/inode identities, their shared Git common directory, and
the selected sandbox/approval policy. The source includes the physical
resolver and a host adapter, but native shared-runtime compatibility remains
unqualified. The caller-facing connector exposes only the dispatch handle,
not internal thread/turn IDs.

The earlier fixture-only journal format has no saved-project identity. It is
intentionally read as outcome-unknown after this contract change and never
replayed. No production handoff journal existed for that format. Read-only
status for a current-format dispatch remains available when the execution
policy changes, provided both physical roots still match.

The integrated source has explicit host-task creation admission, a trusted
Computer workspace adapter and a typed desktop/Computer MCP
create/status/result route. The active-turn source candidate implements
`codex_task_message` for one exact steer per issued dispatch. Production does
not advertise it until the serving host is qualified. It binds a
separate message UUID to the dispatch, saved project, approved workspace,
model and effort. The exact turn ID comes from the durable dispatch record,
is checked as active, and is supplied as the host's `expectedTurnId`; the MCP
caller does not have to know an internal turn ID. A durable content-free intent precedes
`turn/steer`; a lost acknowledgement stays outcome-unknown and never causes a
second send with the same or a new key. A confirmed receipt can be read after
connector restart. The send checks the admission deadline and current
workspace again inside a cross-process fence lock shared with desktop summary
raises. A crash or outcome-unknown after submitting the host request leaves
that lock fail-closed for explicit recovery; a preflight refusal releases it.
`PhysicalCodexHandoffAuthority`
re-measures the approved writer and saved-project root device/inode and
requires their current Git common directory to match the explicitly selected
repository. It refuses symlinked, replaced or foreign roots. This adapter
requires a separately issued task-creation grant from desktop; a Computer
folder grant alone never creates a task. `SharedCodexProxyHost`
connects through the supported `codex app-server proxy --sock` command to an
**already running, explicitly selected** Unix socket. It checks executable
digest, socket ownership/canonical path and serving Codex home; it never starts
or stops the daemon. The proxy child gets a private disposable `HOME` and a
fixed executable search path; the selected socket determines which serving
profile it reaches. A dropped proxy rejects pending calls and cannot silently
reconnect/replay them. Provider approval requests are refused until an explicit
owner-facing approval path exists. Its local fixture uses the installed CLI
against a disposable fake socket; this is not a connection to the owner's
running daemon or proof that native Desktop shares that runtime.
The source-only `inspectCodexHandoffHostContract` gate now checks the relevant
installed-host schema methods and response fields, including
`thread/items/list`, its turn filter, the typed final-answer phase, and
`turn/steer` with an expected turn ID. It is not yet attached to
that route. It was checked against the locally installed Codex CLI's generated
schema without launching a task.
The adapter must preserve the owner-selected host execution policy and refuse
an ambiguous or unavailable saved project; it must not silently fall back to a
projectless task. Qualify malformed inputs, stale/symlinked roots, ambiguous
projects, process restart and both lost-start boundaries with local fixtures
before any live smoke. A Computer folder grant alone is not task-creation
authority.

The Computer MCP composition accepts an optional published Chat task port.
When no distinct task port is supplied, none of the `codex_task_*` tools is
advertised. A private canonical launch contract can carry a separate exact
task grant, selected Codex executable digest and an explicit existing proxy
socket. It must match a verified Computer Git workspace and the desktop's
selected Codex executable. The built Computer MCP entrypoint attaches once,
constructs a durable journal and refuses a different project, workspace,
invalid model policy or expired grant before starting a task. An in-memory MCP
test and a built-byte test with the installed CLI proxy against a disposable
fake socket prove create/status/result. A separate in-memory test covers an
explicitly qualified steer fixture. The public route exposes only the dispatch
handle and exact final text, not internal thread, turn or item IDs. These
fixtures consume no model turn. The owner-facing Native hosts setting selects
an exact existing socket,
serving Codex home, saved project ID/root, verified Computer workspace and
execution policy. The candidate's `tasks` section in `product-settings.json`
selects `defaultHarness` and each harness's `defaultModel`, model aliases and
optional `defaultEffort`. Only Codex is implemented; an unsupported harness
refuses instead of falling back. A create request may override the alias and
effort. Desktop checks the saved project through
`project/list` and re-measures the physical Git roots before saving a 12-hour
route selection. The next connector launch includes the separate task grant
and a parsed task-policy snapshot. The issued journal record retains the
resolved model, optional effort, alias and policy digest. A config-only edit
affects a later launch and new task, not a previous dispatch. The three-case
settings-store → MCP regression checks that difference, including a model
without an effort override. A qualified-route fixture also continues the old
dispatch in its original thread with its original model and optional effort;
production does not advertise `codex_task_continue` until the serving host is
qualified. A continuation retains a turn-bound confirmation only after the
post-start history check passes. A turn ID without that confirmation remains
outcome-unknown on replay, status, result and further parent selection, even if
later provider history looks healthy. This is a local fail-closed journal rule,
not an atomic cross-client `turn/start` contract.
The config file must be edited while the new app is stopped; concurrent raw
JSON edits are not supported by this slice. An unavailable task socket
leaves Computer running without task tools; no daemon is started or repaired.
The owner may select one exact native thread ID in the desktop task-route
Settings. The desktop verifies that thread's saved project and writer cwd
against the selected host before sealing it into the connector grant; without
that selection the tool is absent. The read-only `codex_task_observe` route
accepts only this sealed thread ID, workspace ID and saved project ID. It
rechecks the physical writer
and canonical project identities, checks the host's thread project/cwd, and
returns a bounded first page of turn statuses with an explicit `hasMoreTurns`
flag. The grant expiry is checked again before returning the read result. It
never calls `thread/start`, `turn/start`, `turn/steer`, resume or fork.
With the same selected thread, `codex_task_adopt` can persist a read-only
handle for one exact turn found on that first bounded page. It verifies the
project and physical writer again before recording the turn; a missing turn on
an incomplete page remains unknown. Repeating the same request returns the
same handle, while a conflicting binding refuses. `codex_task_status` and
`codex_task_result` use that handle without creating a provider turn. The
handle cannot be steered or continued, and reads stop when the selected thread
or grant expires. A changed project/root or unavailable host refuses or remains
unknown. Durable owner-task control is still separate.
The inspected CLI schema supplies model and reasoning effort in `thread/read`,
but does not supply sandbox or approval policy there. Those fields in
`thread/resume` do not authorize resuming a selected task merely to obtain
observation/control metadata. Adoption therefore does not infer the native
task's execution policy from the configured Farol creation grant. Bounded
owner-task control still requires a supported policy readback or a separately
qualified exact control proof; the CLI schema is not serving-runtime proof.
Fixture PASS is not proof of a native shared
host task, paid model result or provider delivery. Project creation,
project-root rebind, title mutation, owner-task control, live control
qualification, live terminal result retrieval and archive/delete remain open.

With a selected installed Codex CLI path, the content-free local route proof is
`FAROL_CODEX_PROXY_BINARY=/absolute/path/to/codex npm run test:e2e:codex-task-fixture`
after `npm run build`, or `npm run test:e2e:codex-task-fixture:package` after a
clean `task package`. Both commands create only disposable Git roots and a fake
Unix socket; they never attach to the owner's Codex daemon or start a model
turn. A failure on this fixture blocks any later live task canary.

## Saved ChatGPT route qualification backlog

The saved-chat route now composes a private write-once journal, an app service,
the dedicated Next Browser adapter and a gated desktop/Computer MCP endpoint.
It reserves a
lowercase UUID before opening a browser, writes a durable send intent before
the one Send boundary, and cannot retry that key after an unknown outcome.
Only a canonical private conversation URL with a separately verified
first-message/reopen/history proof may become `verified`; title verification is
a separate boolean. The journal stores digests and status only, never prompt
or answer text. Fault fixtures cover concurrent same-key calls, crash-like
acknowledgement loss, bad URLs, corrupt private state and malformed browser
proof. These source fixtures do not establish account identity, current real
DOM selectors, packaged route or live saved-chat delivery. The remaining proof
uses an exact new package, a refreshed connector, an owner-checked account and
one bounded message; no real send has been performed by these fixtures.

The standalone browser conversation route requires its own
owner admission, account identity, exact first-message digest and one-send
proof, canonical private URL, fresh-navigation/history reopen, title readback,
durable reservation, process-restart recovery and no duplicate send after an
unknown outcome. Its helper lifetime, isolated browser partition and retained
evidence must be qualified independently of a Codex task. Do not import V0
`integrations/farol-chatgpt-chat-bridge.mjs` or treat a Codex task's
`threadId` as a ChatGPT conversation URL.

Keep pure policy in Chat domain/app, concrete host/browser and journal adapters
in infrastructure, and lifecycle wiring in boot. Peer access must use the
owning module's published contract. Do not add an extra model or permanent
supervisor merely to make the two handoffs look alike.

## Immutable saved-project preference handles

`codex_project_preference` remembers or reads an explicit saved project already
selected in the sealed task admission. It publishes a local private receipt under
one UUID handle; the handle cannot be changed to another choice. This is not an
automatic "latest project" setting, a project creation request, a new owner profile
or an authority grant. Clients retain the handle and explicitly read it before
using the choice. The existing public resolver remains unchanged.

The receipt binds the canonical project path, device/inode and Git common directory,
separately from the active writer cwd. An independently approved writer of the same
physical project may read the handle. Each operation revalidates physical authority,
expiry/cancellation and a bounded complete saved-project catalogue. Missing, stale,
partial or corrupt proof never selects a replacement. Catalogue checks are non-atomic.
Only the exact project selected in current task admission is accessible.

Remembering takes the existing Computer mutation fence. An uncertain publication or
post-write revocation remains `outcome_unknown`; read the same handle to reconcile,
never blindly retry with a new key. Atomic no-replace publication and private closed
records prevent concurrent overwrite. The local receipt has no model, prompt, turn
or transcript. No provider mutation or task execution occurs. Source/filesystem and
sealed packaged fixtures do not qualify live project API or native Desktop parity.
Project ensure, cross-writer discovery and serving interactive approvals remain open.

`codex_project_preferred` reads the latest locally published choice for the exact
physical canonical repository without requiring the caller to retain a handle.
It still requires the existing sealed project ID; it cannot pick a different
project or supply authority for one. Missing local selection is `missing`, not a
unique-project fallback. A different/removed project is `stale_preference`.
Every result revalidates the physical canonical/writer identities, the complete
bounded provider catalogue and the local selection before disclosure. Cancellation,
revocation, expiry, changing selection or unreadable state refuses disclosure.
These reads are non-atomic, stored preference evidence, not native/live acceptance.

New remembers append a private, bounded 256-slot no-replace publication log per
canonical physical identity. Each slot and its independent no-replace witness
contain only the receipt UUID; a lost tail slot or witness cannot silently make
an older choice latest. Both namespaces must match before disclosure. This is
not protection against wholesale rollback/removal of all private state copies. The old
immutable receipt format is unchanged. Intent is durable before receipt publication:
a missing/corrupt receipt blocks lookup and further selection, never falls back to
an older choice or repairs itself by retry. Concurrent slot contention is unknown;
there is no automatic retry. Successful readback of complete local bytes reconciles
publication, without claiming the original acknowledgement was delivered. Replaying
an old handle never changes latest ordering. Existing receipts remain readable;
legacy handles without a publication slot are not silently imported or ordered by
mtime. The limit is explicit and has no automatic pruning or truncation. No task,
model, native project, user configuration or execution policy is modified.

Source and disposable filesystem/MCP fixtures exercise this path. Actual packaged
MCP qualification is recorded separately for exact clean committed bytes. Serving
project API, current NEW connector and native Desktop visibility remain unqualified.

## Saved-chat local frame and cleanup boundaries

A response with a dispatch ID must match the exact create key or status target.
A foreign verified/refused/outcome-unknown response is invalid; no automatic retry
or new dispatch follows it. Strict frames reject mixed result/error-shaped data.
A complete frame settles without waiting for peer end; an abrupt close refuses
without retaining the full timeout. A connect event after settlement/deadline
never writes a request. The bridge uses one owned connection per
request and ignores late frames after settlement.

Controlled socket fixtures qualify these client rules. The packaged MCP fixture
also exercises six disposable peer cases: foreign verified/refused/unknown IDs,
mixed frame, complete-frame/peer-open, and abrupt close. Each request has one
transport write and a bounded current-connection close proof; there is no account
operation, actual Send or descendant-process qualification. Disposable native socket
fixtures continue to prove existing lease draining and disconnect behavior, not
account/Send or shared Desktop parity. Replacement-inode cleanup is explicitly
NOT_QUALIFIED on the current Node host: a preserved RED shows public
server.close() can unlink a later resource at the same pathname before an
application lstat guard runs. The attempted guard and reproducer are retained in
candidate evidence, and the corresponding regression remains a visible todo.
No private handle internals, foreign pathname moves, or unsandboxed fallback is
used to disguise that limitation. A supported identity-preserving close path is
required before claiming full socket-ownership cleanup.

## Thread-wide waiting state

`codex_task_status`, `codex_task_observe`, and a running `codex_task_result`
include `threadRuntime`, decoded from the supported `Thread.status` union. Its
`scope: thread`, `source: thread/read`, and `snapshot: non-atomic` separate it
from the issued turn status. An active thread reports only the closed
`waitingOnApproval` and `waitingOnUserInput` flags. Idle, notLoaded, and
systemError are runtime states, not terminal turn outcomes. Omitted runtime
is explicitly unavailable; malformed, duplicate or unknown flags remain
outcome-unknown. A later read can report resolved waiting without starting,
resuming, approving, steering or forking work. Physical authority is remeasured
after the turn read, including for Farol-created handles. Result reads recheck
authority after their journal read and before disclosing final text. An exact turn
with an unsupported status or duplicate identity refuses immediately; a later
page cannot replace that unknown snapshot.

A completed old turn can share a thread with a different waiting active turn.
These flags do not identify that active turn, a server request, its permissions
or an approval decision. Exact terminal results remain bound to the issued turn.
The snapshot does not make an owner-created task controllable. Interactive
approval request correlation/decisions, event subscription and shared native
Desktop identity still require separate qualification. The original blocked
experimental initialize change is not included. Tests use deterministic host
data and a packaged disposable socket; no live provider or account proof is
claimed. The selected saved CLI schema is supplemental contract evidence,
not an attestation of the serving runtime.

## Fresh-project ensure contract checkpoint

`ensureCodexProject` is a pure application/port contract with **in-memory tests only**.
It is not wired into Computer MCP, Desktop admission, a native project mutation
method, or a production filesystem journal. The refused experimental handshake
and existing shared proxy remain unchanged; no new native capability is enabled.
This is the independent Morning D2 foundation, not a serving ensure API or parity PASS.

A complete bounded catalogue resolves only the approved physical canonical project,
separately from the current writer cwd. Missing, ambiguous and stale explicit
preference are distinct. Creation additionally requires a separately qualified
owner project-mutation admission and the existing mutation gate. The journal port
requires one durable no-replace intent per canonical physical identity across
**different keys** before the single create submission, using the provider's
idempotency key. The in-memory journal tests this policy; it proves no actual
fsync, cross-process lock, native method or provider idempotency implementation.

An exact create acknowledgement and a complete unique post-create catalogue are
required before local confirmation. Every asynchronous boundary revalidates
current physical roots, admission and absolute deadline. Unknown mutation paths
throw through the gate so its error policy can quarantine; returning an unknown
value alone cannot release the mutation lease. No user profile, model, task,
preference or execution permission is changed or automatically granted.

Lost acknowledgement, uncertain journal publication and concurrent claim remain
unknown and never submit a second create, even under a new key. `inspect` is
read-only: a unique current project can be reported as `observedProjectId` while
**creation outcome remains unknown**. It neither confirms a missing acknowledgement
nor grants task control. Replaying a confirmed intent uses the current catalogue
and reports current resolution, never a new create. A missing/replaced confirmed
project does not become permission to recreate it.

Catalogue/create/readback are non-atomic. A concurrent native creation can still
produce duplicate projects before readback; ambiguity is unknown, with no automatic
delete/rename/retry. A real provider-side atomic ensure/CAS is not claimed. Actual
journal adapter, exact serving methods/admission and owner qualification remain
required before publication. The retained Computer-only candidate/trial is independent.

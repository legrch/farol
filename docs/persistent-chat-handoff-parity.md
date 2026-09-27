# Persistent handoff parity

Status: saved-project create/status/exact-result and the Computer MCP route are
integrated on standalone main. The neutral task-model policy and internal
active-turn steer are separate source candidates. Built and packaged fixtures
use a disposable fake socket. No native shared-runtime or live-model
qualification has been completed.

## Two different destinations

| Route                      | Owner-visible result                                                                            | Current standalone state                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Saved ChatGPT conversation | A normal-history browser conversation with an exact first message and later reopen proof        | Separate backlog; the V0 implementation and its private-alpha evidence are historical references, not standalone code or acceptance |
| Persistent Codex task      | One task in an **existing saved Codex project**, one issued turn, status and exact final answer | Integrated create/status/result; disposable connector fixtures; no live task                                                        |
| Product Agent              | A correlated child of the current host task                                                     | Intentionally disabled; it is neither of the handoff routes above                                                                   |

The V0 browser route is documented in the V0 repository's
`docs/persistent-chat-handoff.md`. Its Legacy browser partition, Hub bridge,
receipts and fixture results do not transfer into this standalone repository.
Neither route changes temporary Consult defaults or grants Product Agent
admission.

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

## Separate saved ChatGPT conversation backlog

A standalone browser conversation route, if selected later, requires its own
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

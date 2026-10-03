# Persistent chats and native tasks

Farol has several distinct destinations. This reference describes their source
contracts; [current status](../status.md) owns the release and qualification snapshot.
Similar names and fixture results do not transfer acceptance from an older product.

## Route status

| Route                      | Destination                                                                        | Ordinary product state                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Saved ChatGPT conversation | Private conversation URL in Farol's ChatGPT partition                              | Default-off experimental opt-in; live account/Send proof is separate                                              |
| Codex task handoff         | One turn in an existing saved project on an explicitly selected running Codex host | Separate task-route admission; create/status/result and observer fixtures, incomplete live shared-host acceptance |
| Product Agent              | Correlated child of the current task                                               | Disabled, `AGENT_NOT_READY` without child effects                                                                 |
| Claude handoff             | Owned sandboxed print process                                                      | Fixture-only; [separate reference](claude-handoff.md)                                                             |

A Computer folder grant is not authority for a new native task or external Send.
This page does not offer projectless fallback, another daemon, native owner-task
control, or a promise of Desktop visibility.

## Codex host and physical project

The user selects an exact Codex executable, an existing Unix proxy socket, serving
Codex home, saved project ID/canonical root, verified writer, and execution policy.
Desktop verifies project membership and physical writer/canonical roots before saving
its bounded route admission. Those roots must share the selected Git common directory.
Symlinked, replaced, stale, foreign, missing, or ambiguous identities refuse.

The sealed Computer launch carries this distinct grant and policy snapshot.
`SharedCodexProxyHost` connects once via the supported `codex app-server proxy --sock`
path to the already-running selected endpoint. It checks executable/socket provenance;
it never starts or stops the shared daemon. Connection loss rejects pending calls
without reconnect/replay. An unavailable task socket leaves ordinary Computer running
without those task tools.

A local CLI-generated schema is supplemental contract evidence, not proof of the
serving host, experimental project API, account, or shared native Desktop identity.
The source initializer opts into the experimental API and sends `initialized` before
paged project/thread reads; live compatibility still needs its own qualification.

## Create, status, and exact result

`codex_task_create` follows: explicit task request, current approved writer/canonical
project, exactly one existing saved project, durable exclusive reservation, one
`thread/start`, one `turn/start`, then an issued dispatch handle. Zero/multiple project
matches and policy/root drift refuse before effects.

The request UUID and its content-free digest bind the original model/effort, project,
workspace, and policy. A lost start or publication acknowledgment remains unknown.
Same-key replay observes the existing record; it cannot create a replacement thread
or turn. [Model discovery](../configuration.md) describes exact selection and
binding through continuation.

`codex_task_status` observes the issued turn. `codex_task_result` pages items for that
exact turn and returns only its explicit completed `final_answer`. Foreign,
conflicting, incomplete, malformed, or unreadable results stay unknown. Result reads
do not start work and keep internal thread/turn/item identities out of the public
create/result handle surface.

Read admission carries the actual MCP AbortSignal and a deadline clipped to immutable
grant expiry. Checks occur between provider pages and after journal/physical authority
reads and fence release, before disclosure. An already-submitted read waits for its
bounded transport response; this is not remote query cancellation or an atomic snapshot.

## Project selection and preferences

| Tool / contract            | Scope                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `codex_project_resolve`    | Read-only bounded saved-project catalogue for the admitted physical canonical root; writer root remains separate |
| `codex_project_preference` | Publish/read an immutable local UUID choice for an already-selected existing project                             |
| `codex_project_preferred`  | Read the latest complete local choice for that same physical repository and sealed project                       |
| `codex_project_tasks`      | Stored metadata only, requiring an additional discovery grant                                                    |
| Project ensure foundation  | Pure policy plus private journal adapter; not wired into MCP/desktop/native project creation                     |

Resolution cannot create, rename, persist a new native project, or choose a replacement
for a stale explicit ID. A complete scan is bounded to 32 pages of 100 entries and
32 matches; malformed/partial/cyclic catalogues never prove absence.

Local preferences do not grant authority. Every read revalidates catalogue and physical
identity. Their bounded no-replace receipt/publication log cannot silently fall back
from partial or corrupt history. An unknown publication requires readback of the same
handle; it is not another remember/create opportunity. There is no automatic pruning,
mtime ordering, or migration of older unlogged handles.

Production does not issue the project-task discovery opt-ins. A granted fixture uses
`thread/list` database-only stored metadata, limit 50, without transcript or execution
status claims. Canonical-plus-selected-writer scope needs another explicit opt-in and
one supported exact cwd-filter array. No unfiltered or all-writer fallback is allowed.
`complete` describes the selected single-page coverage, not all project history.

The unwired ensure contract requires separate project-mutation authority and durable
intent across different keys before one provider create. Its current journal/tests
cannot prove server-side idempotency, atomic ensure, or native project creation.

## Selected-thread observation and adoption

A separate exact selected-thread grant admits `codex_task_observe`, text-only
`codex_task_history`, and `codex_task_adopt`. The thread must match saved project and
physical writer; checks surround host reads. No observation starts, resumes, forks,
steers, or approves work.

History is one bounded page for an explicit verified turn: at most 50 items and
32 KiB aggregate text, with cursor/coverage flags. It omits reasoning/tool payloads
and non-text content with explicit counts/type records. Tail preserves direction and
identity. A terminal page reached after a cursor does not make the whole history
complete. Project-wide transcript search and Claude history are not provided.

Adoption persists a **read-only** exact-turn handle. It cannot infer the native task's
sandbox/approval policy from Farol's creation grant, nor grant steer/continue control.
A turn missing from an incomplete scan stays unknown.

`threadRuntime` observes supported `Thread.status`, including thread-wide
`waitingOnApproval` / `waitingOnUserInput`. An old completed turn can coexist with
another waiting turn in that thread. These flags do not identify the approval request,
prove terminal status of another turn, or permit a decision. Missing runtime is
explicitly unavailable; malformed/unknown flags fail closed.

## Separately gated controls

Ordinary production construction leaves these control capabilities off:

- `codex_task_message`: one exact active-turn steer, with durable intent and the
  host's `expectedTurnId`.
- `codex_task_continue`: explicit next turn in the same issued thread/model binding,
  with confirmed post-start history before acceptance.
- `codex_task_title`: one exact Farol-created dispatch name update, with expected-name
  preflight, immutable intent, and readback.

Adopted owner tasks remain read-only. Title preflight/readback is not a native atomic
compare-and-set; another client can rename concurrently. Lost acknowledgments,
post-effect authority loss, and uncertain confirmations retain their fences. A historical
recorded receipt is not a guarantee of the current title or execution state.

## Shared-host requests and cleanup

The proxy leaves recognized interactive consent requests unanswered: execution/file/
permission approvals, user input, MCP elicitation, and supported legacy approval
methods. It does not claim their ownership, expose payloads, or issue a decision.
Unsupported unrelated server methods receive a method-unavailable response. Separate
server/client ID namespaces prevent a server request from completing a client call.

Synthetic multi-client framing tests are not proof that another native client can
resolve an actual provider request. Correlated owner approval lifecycle, event
subscription, shared Desktop identity, and serving compatibility remain open.

A refused exact-child signal keeps cleanup unverified without repeated signaling.
Only independent terminal observation can establish exit. This does not prove cleanup
of detached descendants. Saved-chat socket replacement cleanup is also unresolved:
Node's public server close can unlink a replacement pathname before a later application
identity check. Its regression remains unqualified, not a completed socket-ownership
claim.

## Experimental saved ChatGPT conversation

The optional `chatgpt_chat_create/status` endpoint uses Farol's isolated ChatGPT
partition, a short-lived authenticated local bridge, and a private write-once journal.
No endpoint means no advertised tools. Ordinary launch is default-off; the developer
opt-in is `FAROL_NEXT_SAVED_CHAT_PREVIEW=1` on `task run`, after exact-build Setup
readiness and an explicit owner decision to exercise that experiment.

A UUID reservation precedes browser work. Native confirmation shows the exact request
and first message before durable Send intent. Missing owner window or denial refuses
Send. Readiness proves the partition's signed-in state, not the account ID; the user
must inspect the intended account in that same partition.

Only one submit is allowed. A candidate URL is not success: a fresh helper must reopen
the canonical private URL and verify the first-message digest and visible history;
title verification is separate. Disconnect before submit prevents Send; uncertainty
during/after submit or journal work stays unknown without another key or click.
The operation retains its execution-fence lease through browser work and connector drain.

Controlled page/socket fixtures prove transport, identity, framing, and no-replay.
They do not prove current real selectors, account choice, authenticated Send,
connector metadata refresh, or saved-chat persistence on a live account.

## Focused fixture checks

After a build, the disposable Codex proxy route uses an explicitly selected CLI:

```sh
FAROL_CODEX_PROXY_BINARY=/absolute/path/to/codex npm run test:e2e:codex-task-fixture
```

After `task package`, use `npm run test:e2e:codex-task-fixture:package` with the same
explicit CLI binding. These tests use temporary Git roots and a fake Unix socket;
they do not attach to a user's shared daemon or start a model turn. Follow
[testing](../../development/testing.md) and keep fixture/native/live results separate.

Implementation anchors: [Codex handoff service](../../../src/modules/chat/app/service/persistent-codex-handoff.ts),
[admitted route](../../../src/modules/chat/infra/native/admitted-codex-task-route.ts), and
[Computer MCP composition](../../../src/apps/computer-mcp/main.ts). Coding-task delegation
will move to the Go Task owner only through the accepted capability cutover.

---

[Native tasks](README.md) · [Documentation](../../README.md)

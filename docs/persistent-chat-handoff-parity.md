# Persistent handoff parity

Status: a fail-closed, fixture-only **Codex saved-project task** create/status core
is committed at `6772aa7`. It has no desktop/Computer MCP route and no live
Codex-host qualification. Standalone Farol does not yet expose a persistent
handoff tool.

## Two different destinations

| Route                      | Owner-visible result                                                                                 | Current standalone state                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Saved ChatGPT conversation | A normal-history browser conversation with an exact first message and later reopen proof             | Separate backlog; the V0 implementation and its private-alpha evidence are historical references, not standalone code or acceptance |
| Persistent Codex task      | One task in an **existing saved Codex project**, one issued turn and a metadata-only dispatch status | Private `PersistentCodexHandoff` core and hermetic fixtures only; no tool, host adapter or live task                                |
| Product Agent              | A correlated child of the current host task                                                          | Intentionally disabled; it is neither of the handoff routes above                                                                   |

The V0 browser route is documented in the V0 repository's
`docs/persistent-chat-handoff.md`. Its Legacy browser partition, Hub bridge,
receipts and fixture results do not transfer into this standalone repository.
Neither route changes temporary Consult defaults or grants Product Agent
admission.

## First Codex saved-project task slice

The selected first path is: explicit owner request → approved Computer workspace
and current physical root → exactly one **existing** saved project at that root →
durable one-key reservation → one persistent `thread/start` → one `turn/start` →
issued dispatch handle → exact metadata-only status. Zero or multiple project
matches, root drift and policy drift refuse before a new side effect. A lost
acknowledgement remains outcome-unknown; replay never creates a second task or
turn.

`PersistentCodexHandoff` in Chat app code owns the closed create/status
policy. Its private append-only journal and request digester have 21 hermetic
tests, including conflicting keys, restart, lost acknowledgement and exact
status readback. The caller supplies a workspace ID, not an arbitrary root;
the trusted adapter must resolve the approved root, device/inode and selected
sandbox/approval policy. The caller-facing connector must expose only the
dispatch handle, not internal thread/turn IDs.

The next source slice must add explicit host-task creation admission, a trusted
Computer workspace adapter, an App Server adapter against the **installed**
host's current schema, and a typed desktop/Computer MCP create/status route.
The source-only `inspectCodexHandoffHostContract` gate now checks the relevant
installed-host schema methods and response fields; it is not yet attached to
that route. It was checked against the locally installed Codex CLI's generated
schema without launching a task.
The adapter must preserve the owner-selected host execution policy and refuse
an ambiguous or unavailable saved project; it must not silently fall back to a
projectless task. Qualify malformed inputs, stale/symlinked roots, ambiguous
projects, process restart and both lost-start boundaries with local fixtures
before any live smoke. A Computer folder grant alone is not task-creation
authority.

Until that outer route and a separately authorized live test pass,
`codex_task_create` and `codex_task_status` remain unavailable. Fixture
PASS is not proof of a native host task, paid model result, or provider
delivery. Project creation, project-root rebind, title/message/continue,
terminal result-body retrieval and archive/delete are later slices.

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

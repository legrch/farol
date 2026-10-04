# Selected Codex App Server client

This package implements the Task-owned Go `port.CodexClient` producer. It attaches
to the explicitly selected existing Codex App Server through the selected CLI's
`app-server proxy --sock` pipes. It never launches a server, discovers a socket,
reads authentication, or reconnects a lost client.

Trusted boot supplies an immutable selection, qualified executable/schema
digests, saved project and physical writer identities, execution policy, resolved
model/effort, grant lifetime, and a mandatory current-grant recheck. `New` is inert.
`Options.RecheckDispatch` is immutable, mutation-only trusted Root wiring. Root
must create the original retained Client with the exact initiating Parent peer
and owning Task/journal intention check already connected. It receives the
actual `task.Intent` before each `thread/start` / `turn/start` write, after all
awaited qualification/history, write-lock waiting and frame construction. It
checks current original Parent and exact selected Task/binding/intent; it does
not issue admission. Its owner-gate callback performs value checks only and
returns before provider IO. No context values, late guard rebinding or replacement
Client may recover possible-effect work. A nil hook leaves construction/Observe
available for source-compatible reads, advertises no effects through Supports,
and makes attempted mutations sticky unknown without launching qualification.
Hook failure/cancellation after a durable intent remains unknown without Send
or retry; if thread creation already happened, its partial lineage is retained
and the later turn start is prevented. Reads do not invoke this mutation hook.
The originally qualified connection identity and account epoch are carried to
each mutation write. They are matched after the write lock and again after the
awaited Binding/dispatch checks. `account/updated` or `account/login/completed`
during lock waiting or a guard invalidates this witness; no newer epoch is
accepted, no requalification or replacement connection is attempted. The same
unknown/partial-lineage fence applies before thread creation, between thread
and turn, and before exact follow-up. Withdrawal after writing begins cannot
undo bytes or attest remote cancellation; this is a point-in-time pre-write
check, not a remote account/Parent CAS.

`NativeBoundary` implements the actual macOS executable, socket, physical root,
Git identity and exact proxy process checks. Other platforms are unavailable.
Schema evidence and initialize home/platform checks do not identify an account
or prove Codex Desktop visibility. No live installed capability is claimed here.

With a dispatch hook present, `Supports` performs fresh project/model catalogue
checks on one connection and advertises create. Continue additionally requires the independent bound witness
described below; an ordinary create/status selection leaves it unsupported.
An effort-capable model requires the resolved binding's explicit effort; the client never rewrites the binding with a guessed default.
Create reserves its bounded local operation fence before qualification, sends
one `thread/start`, publishes its verified lineage, then sends one `turn/start`
and publishes the full reference. The owning Task journal must persist intent
before invoking this producer. The local fence does not replace that journal.

Any uncertain mutation reply, failed lineage callback or post-effect recheck
failure fences all later mutations in this client. Known failure before mutation
has no provider effect. Reuse of the same operation never sends it again; changed
payload is a conflict. The operation fence retains at most 8192 entries without
eviction. Failed launch/initialize and lost transport are final for the client.
Creating a replacement client is not authorization to replay durable pending work.

Observe reads an exact project/worktree/model-bound thread, traverses bounded
turn pages to establish a unique exact turn, and accepts a completed result only
with one explicit final-answer item from that turn, at most 64 KiB to match the
Go Task result contract. Requests retain the existing 8 KiB message limit. Duplicate identities,
malformed data, cursor cycles, partial results and changed grant/connection epoch
are unknown. Observation never settles a pending mutation or issues admission.
Provider terminal evidence and parent delivery acknowledgement remain separate.

Completed-parent follow-up uses `Task.Continue`, never `Message`. Trusted boot
must supply `Options.Followup` with a `codex-followup-schema/v1` witness from
`inspectCodexFollowupHostContract`. Its independent digest covers the descending
`thread/turns/list` sort direction as well as the baseline handoff snapshot. The
baseline create/status digest alone cannot qualify follow-up. Qualification is
bound to the whole immutable selection, including executable, schema, host,
profile, saved project, physical writer, model/effort, policies and grant times.
This value is trusted composition evidence, not live permission or account proof.

The owning Task service must persist a new durable intent, select a strictly
higher Task epoch and a different Farol turn through existing trusted admission.
The producer requires valid task-bound admission, but cannot prove advancement
from a dispatch alone; use the owning service/journal, not a direct MCP shortcut.
It does not alter selection, issue a grant, revive old admission or settle pending
work. If the current grant's recheck is tied to an old closed Farol turn, boot must
explicitly select a fresh client/grant lifetime for the known terminal task and
new admission. That is a concrete composition requirement, not automatic client
replacement. Never replace a client to replay a pending/unknown operation, recover
a refused launch, reconnect a lost transport, or bypass a denial.

Continue verifies the same project/writer/model-bound thread and the exact latest
completed parent using descending history. It sends exactly one `turn/start` on
that thread, with pinned model/effort and policy, publishes the new exact pair,
and requires the history prefix to be `[new turn, completed parent]` before a known
ACK. Failed or interrupted parents remain unsupported by this first slice even
though the neutral Task model allows them. The vendor method has no parent CAS;
a concurrent mutation or contradictory post-effect history becomes sticky unknown.
Partial/lost ACKs, persistence callback failure and post-effect grant/epoch changes
retain available lineage and fence all later mutations. No reconnect is attempted.

Message and cancel explicitly return unsupported. No turn interrupt,
active steering or consent ownership is qualified by this slice. Consent requests
on the shared connection are left unanswered, without retaining their payload.
Other server requests receive only the existing unsupported-method response.
RPC errors do not attest that a mutation had no effect. Account-change notices
invalidate the local catalogue epoch without reading or retaining auth state.

The wire is the existing vendor JSON request/response shape over RFC 6455 at
`ws://codex-app-server/rpc`, using only the exact proxy pipes. No Farol protocol or
private listener is introduced. JSON rejects duplicate keys, invalid UTF-8,
excessive nesting and trailing values. Messages are bounded to 8 MiB; calls share
one 20-second absolute budget capped by grant expiry. Proxy stderr is discarded
with a 64 KiB bound. Close signals only its exact proxy once and requires exit
proof within a two-second cleanup budget; it never claims cancellation of the provider task. Signal refusal or
missing exit proof is unknown, with no escalation, fallback or relaunch.

Hermetic tests inject a source-only pipe peer and OS boundary. They exercise the
production client and WebSocket/RPC implementation but prove no actual host,
socket, subscription, installed catalogue, process cleanup or provider operation.
Boot/MCP registration, accepted integration, schema/host qualification, native
tests and bounded live create/follow-up acceptance remain with Lead.

The follow-up slice is source-only and unaccepted on its delegated base. Its
hermetic tests do not qualify installed schema, real parent delivery, lost-ACK
recovery or a production tool catalogue. Those gates and integration remain Lead-owned.

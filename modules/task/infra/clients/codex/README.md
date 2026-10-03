# Selected Codex App Server client

This package implements the Task-owned Go `port.CodexClient` producer. It attaches
to the explicitly selected existing Codex App Server through the selected CLI's
`app-server proxy --sock` pipes. It never launches a server, discovers a socket,
reads authentication, or reconnects a lost client.

Trusted boot supplies an immutable selection, qualified executable/schema
digests, saved project and physical writer identities, execution policy, resolved
model/effort, grant lifetime, and a mandatory current-grant recheck. `New` is inert.
`NativeBoundary` implements the actual macOS executable, socket, physical root,
Git identity and exact proxy process checks. Other platforms are unavailable.
Schema evidence and initialize home/platform checks do not identify an account
or prove Codex Desktop visibility. No live installed capability is claimed here.

`Supports` performs fresh project/model catalogue checks on one connection and
advertises only create. An effort-capable model requires the resolved binding's
explicit effort; the client never rewrites the binding with a guessed default.
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

Message, continue and cancel explicitly return unsupported. No turn interrupt,
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

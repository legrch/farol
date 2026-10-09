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
actual `task.Intent` before each `thread/start` / `turn/start` / `turn/steer` write, after all
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
checks on one connection and advertises create and active Message. Continue additionally requires the independent bound witness
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

Root's `TaskProfile.SelectPublishedCodexRead` composes this same lazy client with
the exact thread and turn from the existing Computer authority publication. It
retains one reader/client for the profile lifetime, without selecting a Chat
parent, admitting a Task, or writing either journal. Fresh current-source and
exact-reference checks surround physical verification and later disclosure.
Changed or withdrawn authority, a failed claim, and a lost connection cannot
retarget or replace that lifetime. Its dispatch hook always refuses effects.
Completed result text is opt-in provider-history evidence, not a retained Task
journal result.

The optional trusted `NativeLaunch.CodexRead` input now composes that reader in
`NativeRuntime`. It names the existing `codex` host slot and the canonical temp
parent supplied by the native launcher. Construction is inert; the first read
retains one profile, one qualified empty scratch, one reader and its original
client. A nil selection preserves ordinary startup. `ReadSelectedCodex` accepts
only the result opt-in; it cannot choose another thread or turn.

Quit and retirement join the original client and read handlers before publishing
an ACK, using one fixed cleanup budget. Invalid or mismatched ACKs refuse before
closing this reader. A proved metadata refusal before any client claim remains
sticky for reads but does not itself prevent known resource cleanup. Opening,
claimed-client, physical release and late-exit uncertainty still block cleanup.
Scratch closure releases only original descriptors and retains every directory.

The portable `task.codex.selected.read` method is registered only on an admitted
connector when trusted composition explicitly selects `NativeLaunch.CodexRead`
and the same current publication contains the complete source and exact pair.
Its private launch receipt carries that selection witness. The validated socket
handshake and witness jointly gate the `codex_selected_thread_read` MCP tool;
ordinary backends omit both. Requests accept only the result opt-in. The adapter
holds one Computer read lease, checks the original publication around provider
IO, and rejects crossed selections, oversized text or invented retention.

Portable tests exercise real Go transport/Task adapters with a controlled proxy,
and real TS socket/bridge/MCP adapters with controlled backend replies. These are
separate in-memory segments, not a live native or installed end-to-end proof.
The real launcher does not select this source. Native scratch/runtime/client
joins, trusted launcher wiring, current account/host qualification, final review
and one real external T0 read remain separate gates. No create, Continue, active
steer or Shell authority follows from this read.

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

Message uses the existing Task owner's durable intent and active admission, the
same binding/account epoch and original dispatch hook, and the existing handoff
schema witness. The transferred actual CLI 0.160.1 schemas confirm the covered
`turn/steer` fields; no extra follow-up witness or new engine is needed. The
producer verifies exact project/writer/model-bound thread membership and one
unique active turn through bounded pages, rereads the same thread's membership
after those awaited pages, then sends one `turn/steer` with
`threadId`, `expectedTurnId` and one bounded text input. The vendor's required
active-turn precondition prevents substituting a completed or replacement turn.
The membership reread shares the original deadline/epoch and is a point-in-time
witness; the vendor supplies no remote project/writer/model membership CAS.
An exact completion notice during qualification/write-lock/owner-hook waiting
also prevents the write. No thread, turn, reconnect or replacement is started.

Only an ACK naming the same exact turn publishes the existing reference once.
Missing, crossed or malformed ACKs, failed persistence callbacks and post-effect
grant/account changes retain that reference and fence all later mutations.
Running is a nonterminal control acknowledgement, not fresh lifecycle or result
evidence: completion after the ACK does not invent cancellation, rollback or
retry. Steering preserves the original execution dispatch's event sink, including
when called through `DispatchObserved`; its ACK does not reassign terminal facts
to the Message operation. Cancel and turn interrupt remain unsupported.

The source producer and controlled-peer tests do not activate product control or
qualify the serving instance, account, provider or native host. Trusted Root must
join Message through the existing exact Task admission and active-reference owner.
Consent requests
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
Product/MCP registration, accepted integration, serving schema/host qualification,
native tests and bounded live create/follow-up/steer acceptance remain with Lead.

The follow-up slice is source-only and unaccepted on its delegated base. Its
hermetic tests do not qualify installed schema, real parent delivery, lost-ACK
recovery or a production tool catalogue. Those gates and integration remain Lead-owned.

## Opt-in original proxy lifetime qualification

`nativeclose_test.go` authors one macOS-only target for the original
`NativeBoundary.Verify`/`Launch`, real `nativeProcess.Close`/`Wait`, and current
Client late original registration. Lead qualified the six selected cases on
macOS with Go 1.26.2 on 9 October 2026; the original terminal and retained
unknown diagnostics are recorded under
`_output/evidence/connection-reliability-20261009/task-native-proxy-26f1e19e/`.
This is bounded adapter evidence, not provider or product acceptance.
Native execution and integration belong to Lead. Ordinary test collection has
no fixture effects. Without `FAROL_TASK_NATIVE_PROXY_QUALIFICATION=1`, this
target explicitly skips; a skip is not native qualification.

After freezing the source, Lead runs only this target from the repository root,
upfront in the host-native lane, with the local Go toolchain/dependencies:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off FAROL_TASK_NATIVE_PROXY_QUALIFICATION=1 go test ./modules/task/infra/clients/codex -run '^TestNativeOriginalProxyLifetimeQualification$' -count=1 -timeout=60s -v
```

The cases cover selected original Close/Wait and exact child exit; changed
executable bytes, socket inode and physical project/writer root rejected by
original Verify without launching; and an original Client closed while the
real Launch return is delayed. A counting wrapper delegates unchanged to that
same child. Late registration must close/wait once, perform no protocol IO,
retain the exact original connection, and never renew the two-second cleanup
budget. The final case lets that budget expire before registration and requires
the original unknown result to remain unknown after same-child exit observation.
Both registration cases require an actual Wait deadline equal to the first
Client Close's original deadline; a missing or substituted deadline fails even
if the child exits promptly.
Real signal refusal is not deliberately induced; existing hermetic refusal
tests remain separate evidence, not native refusal qualification.

Every case creates a fresh private `/private/tmp/farol-proxy-*` root, disposable
Git repository, owned Unix socket and fixed synthetic executable bytes. The
helper accepts exactly `app-server proxy --sock <owned socket>`; `/bin/bash`
builtins alone install a TERM trap, write PID markers and self-exit after a
ten-second deadline (a pending builtin read is bounded to one second). It has
no descendants or provider protocol and never connects the socket. Verify uses
normal host UID, executable, Git and filesystem semantics. Project and writer
share this one fixture Git root; separate-worktree topology is not covered.
The Client grant clock and authority callback remain controlled test ports;
this does not qualify current owner consent or real host/provider selection.

The suite has a 45-second shared context, three-second fixture Git init,
two-second readiness and unchanged original two-second Client cleanup budgets.
Same-child exit observation is bounded to 12 seconds; final cleanup can observe
for at most 12 seconds outside the suite context, keeping work plus cleanup
within 57 seconds under the 60-second test-binary timeout. No test is parallel.
Failure stops subsequent cases. The fixture self-exit is independent of cleanup
and cannot turn missing exit proof into successful Close.

`qualification.log` records only synthetic selection/physical identities and
original launch/cleanup facts; `child.pid` and `term.pid` come from the same
owned child. These are test diagnostics, not production receipt/schema evidence.
Deletion requires successful assertions, known original child exit, closed exact
socket handles and the unchanged outer root identity. Unknown launch,
termination, exit, evidence or socket closure retains the root. The expired
registration case intentionally retains its root/error even after exit is
observed. Cleanup only observes the original `cmd.Wait` collector; it never
signals again, calls another Process.Wait, looks up a PID, escalates, falls back
or relaunches. Failed/partial deletion is not retried. A hard test timeout leaves
the root for Lead. Fresh cases do not retry any old unknown operation.

This lane qualifies only exact owned proxy lifetime and physical selection.
It does not qualify provider/schema/live T0, account/authentication, process
groups/descendants, packaging, installed Farol, Dev or live outputs.

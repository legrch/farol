# Bounded external Computer connector owner

This describes current source composition. Disposable Darwin socket and journal
tests qualify their own native adapters; they do not qualify normal application
startup, external ChatGPT, a packaged application or installation. External ChatGPT MCP
Computer execution has no fabricated coding Task, Farol Chat or browser membership.

Trusted root constructs `connector.New(gate, journal, guard, clock, launch)` once for
one exact profile/backend/build/runtime/connector-generation/launch-digest
lifetime. Root alone supplies the original bounded approval/policy and freshly
minted SessionID, work-scope TaskID, owner TaskEpoch, participant/authority IDs and
TurnCorrelation. They are opaque Computer execution correlations in the existing
`TaskBinding`/authority shape, never provider thread/turn identifiers. Existing
Task/Chat consumers keep their original semantics. The old
`CurrentTaskAdmission` name aliases `CurrentExecutionAdmission`.

Root supplies a distinct `port.ConnectorGate` for this owner; its synchronous
Lock/Unlock must perform no IO and must not share the Store or guard gate. The app
depends on this consumer-owned port, not a native synchronization implementation.

The mandatory `CurrentConnectorGuard` must be selected by root. Its entry and
callback are synchronous. Entry performs no IO; only the callback in
`MutationRequest.WithPublication` may run one absent workspace-parent mkdir or
final native publication/verification/guarded undo inside it. It serializes the exact
authenticated host lifetime and settings fence, without a permissive default. Root must qualify
physical host/settings facts outside these callbacks and publish negative fences
before using changed host/settings resources. Time-only approval renewal under
the same policy seal remains allowed. A negative/unavailable guard permanently
invalidates this owner; resetting a cached guard cannot reopen it.

`Publish` attempts original participant publication once. Pending or publishing
projects no admission. Known original participant, policy and revision readback
are required before positive liveness. The adapter wraps the existing access
`Store.Admit`, `Status`, `RevokeParticipant`, `WithOwnerApproval` and
`WithSnapshot`. The Store remains the sole authority journal. Existing or revoked
participants cannot restore a new owner's liveness. Duplicate/conflicting
publication, error, lost reply or incomplete readback never authorize replay.

`ExecutionCeiling(ctx)` returns an independent deep copy of
`port.ConnectorExecutionCeiling` only after known original publication while the
owner is current. Trusted root explicitly maps its Participant/Approval to
`execution.Ceiling`, calls `execution.New(journal, owner, clock, ceiling)` once,
and retains that issuer with this exact owner. The connector app neither imports
the execution service nor constructs or retains an issuer. Exported values cannot
mutate the owner's seal and are never persisted positive liveness proof.

`Reconnect(ctx)` operates on the retained owner object, accepts no IDs and returns
an independent `TaskBinding` observation. Root verifies this exact admission and
continues using its same retained issuer. This observation does not authorize an
operation: each operation calls the issuer's `Admit` and reuses its exact returned
lease for all phases, including final disclosure and existing mutation/process
services. Do not reconstruct an owner, issuer or lease from reconnect IDs or
remint a lease after IO. Renewal changes execution time only; the original
participant, policy, restrictions and provenance stay sealed.

Lock order is access snapshot -> connector owner -> root guard. `WithCurrent`
passes an independent value exactly once on a successful inspection; unavailable
owners return a classified failure rather than absence. No owner-held path calls
the Store. Consumer callbacks cannot reenter or mutate owners. Only
`MutationRequest.WithPublication` may run one absent workspace-parent mkdir or
final native file publication/verification/guarded undo under these locks; staging and journal IO
stay outside.
The guard also releases its gate before requesting owner withdrawal.

`Withdraw` makes liveness negative first, then attempts revocation outside the
owner gate once. A failure or publication that commits after withdrawal cannot
reactivate this owner. The journal may still require Lead's exact reconciliation;
neither reconnect, status nor these APIs replay an unsettled write. This service
does not cancel native processes, settle mutation outcomes or implement drain.

Trusted root now exposes `computer.connector.open/close` only on the inherited
host pipe. Open consumes the current acknowledged Go Settings publication,
mints the execution correlations above and registers a private socket on that
same backend. Its initial surface is catalogue/bootstrap/list/read/search and connector verification,
with read-only scope. The external attachment cannot issue authority or open another
connector. A failed or uncertain start retains its slot and cannot be upgraded
to clean by a later shutdown. Root withdraws ingress before shutdown IO; shutdown
cancels liveness before waiting for the bounded effect gate.

The TypeScript host adapter retains exact original open/close replies. The socket
adapter authenticates the selected binding and then performs the canonical
handshake. It bounds pending calls, request history, frames and writes, and never
reconnects or retries automatically. Transport loss cannot become a known result.
The normal desktop now selects `computer-go-launch.json`. The MCP entrypoint
loads that protected launch once, joins the existing adapter drain lifecycle and
connects to this exact backend. It never constructs a workspace helper, shell or
second authority Store. Go failure is terminal; explicit legacy launch fixtures
remain a separate entry path. Ordinary Dev now has external
catalogue/bootstrap/read/search and guarded create/edit/conflict/readback evidence; see
[the current evidence boundary](../../../../docs/computer-parity.md#current-go-dev-evidence).
This does not qualify installed routing, shell or provider tasks.

The Darwin transport uses a new private 0700 directory, same-user peer credentials
and one random per-launch token. It does not chmod, unlink or reclaim a socket
pathname after creation. Known Close settles exact handles and retains the small
inert endpoint path; filesystem retirement is a separate unqualified boundary.

Go publishes the launch envelope once with descriptor-relative exclusive creation
in the captured private directory. It checks inode, ownership, mode, link count,
exact length and EOF around write/sync/readback. Substitution cannot redirect the
secret write. Any partial or uncertain publication remains fenced; no retry or
path cleanup restores it. The TypeScript loader only reads and validates the
protected file; it grants no authority.

Verification reserves one attempt in the current Go owner before native List. A
failed or uncertain List cannot become a new attempt. Successful proof retains
the exact execution, challenge digest, workspace, original call digest and bounded
entry count. Repeat observations return that proof without another List and still
require current authority. The host reads proof through the inherited pipe and
checks the current Settings binding before saving the attachment. A receipt file
or cached UI attachment cannot establish positive liveness. This proves neither
mutation nor shell capability.

Lead must still complete and qualify:

- The one authenticated backend root/transport, with exact profile/backend
  identity, private endpoint ownership/mode, supported peer checks and protected
  per-launch secret delivery. Request IDs are not authentication.
- Fresh root-minted lifetime correlations, one owner and injected gate per host
  lifetime, bounded scope selection, one retained execution issuer and exact
  admission observation on reconnect. Wire handlers cannot
  construct owners, select policy or reconstruct positive liveness from IDs.
- Actual host startup, settings publication/fencing, connector attachment/loss,
  shutdown and restart reconciliation. A new host cannot restore this owner from
  the persisted participant; establish a new qualified lifetime and new IDs.
- Real MCP -> selected Go execution routing, one lease across admission/effect/
  disclosure, unavailable-backend refusal without TS/Python fallback, and exact
  native process/drain/outcome settlement before replacement.
- Normal Dev identity/build/catalogue evidence, actual external ChatGPT calls,
  native cases and package/installed/update gates against the selected bytes.

## Closed MCP reconciliation provenance

The transitional TypeScript `PrivateMcpLifecycle` adapter retains one native
exclusive lifetime claim while it validates the existing stopping marker,
bounded private instance namespace, absence of shell groups and the enclosing
host's work proof. It journals and archives inactive markers through the
existing pending fence and exact operation identity. This does not confirm an
old stop, settle an effect or grant a new connector owner.

`reconcileInactive` preserves the schema 1 failed-Quit identity. The separate,
currently unselected `reconcileInactiveAfterCrash` primitive records schema 2
with `basis: "failed-run"`, exact run/config digests and the same bounded
instance list. Completed metadata remains `retired_unconfirmed`; it contains no
fabricated Quit digest, drain, ACK or terminal observation. Neither entry may
adopt the other schema's prepared plan, even when digest strings match. Changed
run, config or operation identity refuses further relocation. Both use the same
native exclusion, private-file checks, revocation, journal durability and
partial-operation fences.

The crash primitive requires trusted enclosing promotion/Computer exclusion and
canonical work proof; digest values and a free lifetime claim supply neither.
It is not selected by Desktop, MCP ingress or the closed Dev CLI. Their existing
stale-instance refusals remain intact. Actual host selection, failed-run
qualification, original child terminal custody, assembled writable restart and
installed/live-provider acceptance remain separate gates.

The [Darwin crash-reconciliation tests](../../../../tests/integration/private-mcp-crash-reconciliation.test.ts)
exercise actual private files and native lifetime claims, retaining every new
fixture root. Their run/config hashes and enclosing work proofs are synthetic;
they qualify schema separation, marker custody and native refusal fences, not
real failed-run provenance or application recovery.

The app/root/TypeScript adapter tests use offline value or stream fixtures and
synchronization. Four native Store suites cover journal publication, withdrawal
and refusal. Darwin socket suites exercise private endpoint identity, same-user
authentication, canonical handshake, route restriction, bounded close/cancel and
path substitution. The appended-byte publication regression is authored; its
execution must be recorded separately against the final bytes. The TypeScript
protected-file loader, process composition, normal Dev, external client, package
and installed journeys remain distinct qualification gates.

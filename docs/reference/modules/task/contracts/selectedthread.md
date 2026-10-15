# Exact selected Codex thread/turn read (T0 source checkpoint)

`Reader.Read` accepts only `IncludeResult`. Trusted Root supplies one immutable
`Selection`: the entire selected binding (including physical project/writer
identities, profile/host, model/effort and config digest) and an exact native
thread/turn. No request chooses a socket, root, model or reference. This first
slice requires an exact turn; it does not list threads or choose a latest turn.
DTOs use the independent Task control contract values, never domain aliases.

The producer is `codex.NewSelectedThreadReader(originalClient, selection,
recheckSelection)`. Construction is inert and rejects a binding that differs
from the original Client or a non-Codex/partial reference. The mandatory callback
must freshly check the sealed thread/turn and current read grant/route inside
the original Client gate and bounded observation context: after gate waiting,
at each history write boundary after binding checks/frame work/write-lock waiting,
and after provider I/O. It must return a classified Task error, without private
diagnostics. The callback must not reenter the Client or perform provider IO;
any owner-gate inspector performs value checks only. Client `Observe` still
performs its existing grant, selected native
boundary, connection epoch and bounded unique turn/final checks. It now verifies
exact thread/project/writer/model membership again after reading history.
The original connection/epoch witness, grant deadline and closed state are
checked after the final awaited selection callback before disclosure. A failed
history pre-write check follows the existing transport's lost-connection fence;
no reconnect is attempted. Neither check is a remote atomic snapshot or CAS.

The reader retains the original Client. Construction creates no Client or
connection; a read can trigger that original Client's one lazy selected proxy
attachment. No separate connection owner, daemon, cache, journal, admission,
task, delivery or mutation is introduced. A client without a dispatch hook
can serve reads. A blocked mutation remains blocked after a successful read;
reads never settle unknown effects or replace lost transports. Root owns the
original proxy lifetime and its exact cleanup. No native thread control follows
from read selection or configured creation policies.

## Result evidence and existing retention

`Source=stored`, `Snapshot=non_atomic`, `Retained=false` describe a provider
history read. A completed turn requires the existing unique explicit final
answer, bounded to 64 KiB. `ResultEvidence=provider_history` is independent of
Task retention; text is returned only for `IncludeResult=true`. Failed,
interrupted and running turns disclose no final result. Observe validates the
final item even when the request omits text.

For an existing Farol-owned task, the SAME Task service already observes and
persists its exact running reference through `control.Status/Result`. Read
retained results through `observation.Read` using the exact TaskID/DispatchID;
its `Retained=true` and `ResultEvidence=task_journal` are the original journal's
facts. That retained read performs no provider IO. Provider history, terminal
notifications and external native thread selection cannot mint these facts or
adopt an external turn into the journal. Result retention never implies parent
delivery ACK. The hermetic integration test covers this unchanged retention
path with the real producer/service/contracts and a labelled in-memory journal.

## Lead glue proposal and later seams

Root owns settings parsing, sealed native thread/turn selection, schema/host
qualification, original Client lifetime and current grant/route rechecks.
Instantiate the read adapter only with those already selected values, then map
`Reader.Read` through the canonical wire/MCP registry. Preserve independent
provider-history and Task-journal evidence in the response. If Root has only a
thread ID, an exact-turn selection or a separately bounded turn-list contract
is required before using this slice. The portable boot/schema/socket/MCP adapter
now carries this exact selection through an explicitly selected, admitted
connector; normal startup omits the route. Real launcher activation and native
qualification remain open. Never construct a replacement Client to recover
unknown work.

- **T1 create:** reuse the original `TaskIngress`/Task service, journal and Codex
  `Create` engine; real current Parent/intent dispatch recheck and host/schema
  qualification remain required. A sealed native read selection grants no create.
- **T2 completed-parent Continue:** reuse `ContinueExact` with exact predecessor
  DispatchID, fresh higher Task epoch/new Farol turn and independent bound
  `codex-followup-schema/v1` witness. Descending history and the existing
  pre-write/post-effect fences remain mandatory. External read selection does
  not establish a Farol-owned completed parent or authorize adoption.
- **T3 active steer:** unsupported; Codex `Message` remains unsupported. Continue
  starts a new turn after a completed parent and never means steer. A separately
  qualified active-input contract, original current admission/Parent/operation
  guards and outcome-unknown semantics are required before advertising it.

Hermetic tests qualify source behavior only. They do not qualify serving vendor
schema, a saved native selection, account, host filesystem/process, installed
Desktop visibility, native provider operation, final independent review or
accepted integration. No Claude or other-provider parity is claimed.

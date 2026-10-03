# Selected Claude invocation and observation (source candidate)

This bounded slice ships an immutable argument/stdin builder and strict bounded
NDJSON parser. It includes the concrete Task peer in `infra/peer/process` against
the published Computer Prepare/Start/Read/Cancel contract. Constructors execute
nothing. The concrete per-invocation `Host` composes those selected bytes/parser
and the existing Computer peer; it does not register or qualify a production
provider. Root binding and native confinement/cohort qualification remain
separate activation prerequisites.

## Selection and evidence

`NewSelection` captures the exact resolved Task Binding, admission correlation,
runtime, provider session, selected expected reported model and route-specific
effort declaration. It copies selected values; later configuration edits cannot
change an invocation. `Build` requires exact task/provider/physical roots/model,
config digest and admission epoch/turn. Unknown or ambiguous effort mapping and
unsupported actions fail before any process call. There is no settings/model
registry, latest-session lookup or implicit fallback.

`Invocation.Models` separates requested alias/effort from resolved runtime/model,
argument effort and config provenance. Admission correlation is explicitly
`not_observed`; neither a selected ID nor Prepare echo grants current authority.
The existing Task service and selected Computer lease recheck their real owners
before effects. Only actual matching system/init bytes produce `provider_reported`
model/session/cwd/permission evidence. Requested and resolved values are never
called observed or verified. Effort has `unknown` observation strength because
the source reference's init supplies no independently verified effort field.

The fixed source-reference print arguments use `--print --output-format
stream-json --verbose`, exact `--session-id` (or explicitly declared exact
`--resume`), explicit model, default permission mode and no permission prompts.
Prompt stdin is a copied immutable initial payload, not a steering channel.
Native version support for these arguments must be qualified independently.
Resume declaration is not proof that the installed route supports resume.
Continue/latest-session, active input, unsafe permission flags, environment/HOME,
executable and deadline overrides have no builder surface.

Omitted effort remains omitted. An explicit effort uses only the selected route's
mapping into low/medium/high/max; xhigh/legacy Ultra is unsupported unless the
selected declaration explicitly maps it. The synthetic legacy-Ultra test is a
fixture mapping, not a universal provider conversion or installed capability.

## Structured output and terminal boundaries

Feed bounded bytes incrementally, including fragmented UTF-8 and CRLF. Maximum
stream is 64 KiB, final result text 32 KiB. Exactly one matching init must precede
classified provider records, with bounded pre-init hook/plugin notices allowed.
Exactly one classified result and final newline are required at EOF. Duplicate
keys/case aliases, stale session/model/cwd/permission, NUL, invalid UTF-8, malformed
records, duplicate/trailing results and overflow fail sticky. A failed snapshot
exposes Unknown and no result. Snapshot copies do not alias retained evidence.

Useful assistant text is returned transiently as opt-in `output_delta` events;
the parser retains no transcript or hidden reasoning. Tool records/partial
arguments and heartbeat notices cannot execute a tool or complete a task. A
provider result with permission denials is needs_input, never an input ACK.
Parser Ended means protocol EOF only. ProviderResult remains a provider report,
not qualified Task terminal, durable result, cleanup proof or parent ACK.

Task terminal requires same-invocation provider evidence, root Wait, drained
output AND qualified group/descendant cleanup. The real direct producer still
reports cohort cleanup unverified; a clean root exit/zero code therefore remains
unknown. Observe/reconnect must read the retained owning handle without Prepare
or Start again. A new turn cannot replace an unknown invocation or reset its
original <=15s lease. The existing Task journal owns exact-session resume
admission after qualified prior settlement.

## Verification limits and case coverage

Strict scripted fixtures have an independent args/stdin oracle. Unexpected flags,
requests and active input fail, rather than producing generic success. They use
no vendor executable, account, credentials, socket, native child or model call.
`io.Pipe` tests useful output while final generation is held behind a barrier;
this is an in-memory source boundary, not native pipe/process or whole-tree
containment evidence. No fixture implementation is imported into shipping source.

The real Task service/owner cases cover immutable selection through a dispatch
barrier, fresh revocation before effect, and retained unknown without another
resolve/send. This is the C01/M02/M03/M09 lower-layer trace, not a browser queue
acceptance test. Invocation cases cover M01/M06/M11/M12 selection/provenance
mechanics. The byte/parser matrix covers the C06/M07/M08 lower-layer obligations;
strict Host process-port consumer streaming is now a CPU aggregate witness;
actual native process streaming remains a separate higher witness.
Resume flag construction is fixture-declared, not M05 live support. M04 browser
selector and M10 compaction/composer qualification are outside this Task slice.

C08 public-contract import/DTO mapping is concrete source. Peer tests script
only the published Computer boundary; they do not establish normal root/Go/TS
assembled-product behavior. Root composition/native capability tests remain
Lead-owned. Build verification may use a read-only Go overlay of the exact
composed Computer constructor files, with all dependency hashes reported; this
does not accept, copy or integrate another owner's implementation.

No shared Taskfile/schema/main/boot, new journal/event database, executor/daemon,
model module or private wire protocol is added. Full CI/race/native/live and
commit remain held. Production catalogue, root binding and runtime qualification
remain pending.
The concrete Host dispatch/observation assembly is source-tested only.

## Concrete per-invocation Host

`NewHost(HostOptions)` is lazy and accepts one actual `process.Client`, exact
operation/Selection, selected Root clock and mandatory `Recheck` consumer gate.
The peer's pure `Selection` accessor verifies exact correlation before any effect;
that accessor is not qualification. `Recheck` must freshly qualify the SAME native
route, physical/current admission authority, CLI/model/effort/create/exact-resume
capabilities, confinement and cohort ownership. Missing real qualification stays
unavailable. A selected boolean/Prepare echo or Task authority alone cannot fill
this gate; CPU test closures are not a production native grant.

Host implements existing ClaudeHost, Provider and ObservedProvider. It uses the
same selected immutable builder, prepares/starts once and publishes actual matching
provider init lineage before metadata/useful output. Startup observes the SAME
known-start handle for at most two seconds, shortened by caller deadline/cancel,
and 128 reads. Known empty-running ranges pause for a cancellable 25ms timer;
available progressing ranges drain without idle spinning. Unknown/refused/error,
exited root or changed authority/identity stops immediately. No Prepare/Start is
repeated and no background worker or lease renewal is added. The original Computer
lease remains independently binding. This is source-only behavior, not native
qualification or live startup acceptance.

Each Observe reads only the same retained handle with monotonic exact offsets.
Output deltas are optional transient callback data, never journal/transcript or
hidden reasoning. Compact started/qualified-terminal events use the existing Task
metadata sink. Provider result alone remains running; terminal requires complete
matching NDJSON plus SAME root Wait, fully consumed drained bytes and confirmed
group/descendant cleanup. Unknown/overflow/revocation/timeout or contradictory
success/exit facts remain sticky unknown. Callback failures and lost Start ACK
never authorize a new child. Missing init cannot become synthetic provider identity.

Resume uses a newly admitted per-operation Host/Computer peer for the exact SAME
provider session. Root retains/routes previous owning handles and existing Task
journal results; Host adds no persistent registry or recovery journal. Continue,
Message and Cancel stay unsupported in this bounded slice, even when a broad
injected host declaration claims them. Signal ACK is never fabricated as terminal.
Parent delivery remains a separate boundary from result/event retention.

CPU tests script only existing process/storage/authority ports around the shipping
Host, builder/parser, Task Service and Owner. They cover useful fragmented output,
same-session resume, exact historical retained result, unknown and refused boundaries,
callback publication failures, concurrent replay, and lost Start/journal ACK
reconnect without another Prepare/Start. Public New uses a real concrete peer for
lazy/unavailable/identity tests only; no test activates an unqualified native route.
Full CI/race/native/model calls, commit and activation remain held for Lead.

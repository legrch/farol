# Finite workflows over Task

This additive Go slice coordinates a finite plan through the existing Task
owner. It does not register a shipping capability. Run the offline witness with:

```sh
go test -race ./modules/task/domain/workflow ./modules/task/app/services/workflow
```

[example-plan.json](example-plan.json) is loaded and executed by
`TestCompositionDocumentedExample` through that same real Task composition.
The provider inputs and outputs in that witness are synthetic.

The domain validates bounded acyclic plans with stable step, task, launch,
cancellation and delivery operation IDs. A step declares capabilities,
dependencies and an output type/byte bound. Declaration order determines fair
selection among ready steps. Dependencies consume only completed outputs that
pass the declared expectation. Runtime resource budgets select concurrency;
paused or closed-parent policies start no new work. Unknown execution reserves
capacity, while needs-input and known unavailable providers do not consume an
unrelated step's slot.

The application service performs one finite round per `Tick`. It has no timers,
background goroutines, retry loop, journal, mutable execution map or provider
engine. Boot supplies the validated immutable plan, transient input composer,
consumer `Tasks` port and runtime `Admission`. The Task owner remains responsible
for immutable selection, authority, durable intent before execution, exact
lineage, retained results, control and initiating-parent delivery.

Each public operation captures a bounded validated plan before calling a port.
Tick also captures the recognized capability budget, and the composer receives
independent step slices. The caller must synchronize input access until this
synchronous capture returns. Subsequent caller/port mutations cannot change the
in-call identity or policy. This value snapshot does not replace trusted durable
plan retention. The additional [acceptance audit](audit.md) records the reproduced
mutation defects and their regression coverage.
The bounded [restart traces](traces.md) add partial-settlement/revocation and
shared controlled admission combinations through the actual Task journal.

`AdmitNew` explicitly allows new known-missing operations under runtime admission.
`Reconnect` is observation only: even a missing child stays unknown and cannot
be launched. Existing operation IDs are read before any launch. Unknown launch,
result, cancellation or delivery replies never authorize a new effect key.
A positively known running operation can be observed through Task; the result
must match its exact task, dispatch and provider reference and be retained in
that original operation before a successor runs. No network-wide exactly-once
claim is made.

Plan metadata and progress contain no prompts or answers. The composer receives
only accepted dependency outputs as transient data. The report independently
projects completion, output acceptance, cancellation requested, and parent
acknowledgement. Reading progress never delivers a message. Explicit `Deliver`
requires an atomic exact-dispatch Task guard, uses the original parent route,
and separately reads the retained delivery receipt. Known failure, interruption
and needs-input outcomes can also be delivered, without accepting their outputs
for dependencies.
The cancellation projection distinguishes not-requested, acknowledged-requested,
unknown and refused. Only a known matching receipt sets `CancelRequested`.
Cancellation requires the same exact-dispatch guard and is requested rather
than terminal until Task observation confirms
interruption. Pause/resume means changing caller-owned activation policy; it
does not restore provider authority. Explicit `Follow` uses supported exact
Continue/Resume with a separately retained operation ID and a fresh upstream
Task route, after the original result has a known correlated parent ACK.
An existing follow-up request is refused with original evidence; its new message
is never silently acknowledged against an unverified old receipt. `ReadFollowup`
is the explicit observation-only path. Follow never changes the finite plan's original output dispatch.

## Composition boundary

The application owns narrow consumer values in `ports.go`, rather than importing
Task contracts or another application service. Composition tests construct the
real selected Task service and published control DTO facade, then explicitly map
those DTOs into the consumer. Their backing journal is the existing Task Linux
filesystem adapter in disposable private directories. Provider, authority,
input composition and runtime admission are controlled. This proves application
composition and Linux journal behavior only; it does not prove live provider,
Mac execution, shipping registration or a qualified global resource arbiter.

The immutable plan must be supplied by its trusted owner and retained across
restart with the same task/operation references. Changing the plan's parent,
output policy, IDs or messages is not supported recovery. Task execution
progress is durable in the existing Task journal; this slice does not introduce
an independently persisted workflow snapshot. Production plan activation and
resource arbitration are explicit integration gates described in
[integration.md](integration.md).

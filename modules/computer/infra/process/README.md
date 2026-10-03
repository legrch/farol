# Selected process ownership

This source slice owns one process operation in Go. It is not registered in the
product route, and its tests do not qualify native execution. The active
TypeScript sandbox/watchdog and Claude peer remain in place.

## Trusted composition

Boot supplies one already admitted immutable execution lease, a prepared native
launch, a durable reservation owner, a dedicated no-IO gate and a clock to
`app/services/process.New`. The published `contracts/process.Contract` maps
independent DTOs to that service. Consumers reach Computer through this contract;
Task and Chat private implementations are never imported here.

Requests contain only operation/handle correlation and bounded output offsets.
They cannot supply executable, arguments, environment, root approval, task/turn
identity, a deadline or another lease. The captured task binding and physical-root
seal must still match current Computer permission. The selected workspace must
have current shell verification. A new turn or reconnect cannot replace the
captured execution lease or widen the prepared command.

`infra/process.New` captures and copies a trusted `Command`. It requires a native
`Qualification` producer that attests effective confinement of exactly that
command, including approved filesystem, credential, network and Git policy.
There is no permissive implementation or default qualification in this slice.
Native preflight measures root identity, canonical cwd and selected executable
bytes. Those path measurements alone do not prove descriptor continuity through
spawn or kernel confinement. The effective native policy producer and its native
qualification remain activation prerequisites owned by normal composition.

Environment is explicit, including the empty-environment case. Parent environment
is never copied. Command input and environment remain transient private process
inputs; the reservation contains correlation, digest and deadline, not command
text, input, output or credentials.

## One attempt and current authority

The existing journal owner implements `Reservation.Reserve`. Its known durable
receipt must exactly match the immutable intent before the native attempt.
Existing, missing, crossed or uncertain receipts never authorize another spawn,
including after restart. The service records an irreversible refused/unknown
start; repeating Start observes the same selected outcome or handle.

Permission is checked before reservation, after reservation, after native
preparation immediately before Start, and for final output disclosure. IO never
runs inside Computer or peer inspect callbacks. The root injects the selected
published current Chat/Task peer through the existing execution lease; there is
no process-specific authority system or latest-task lookup.

The fixed deadline remains the original lease deadline. The current ordinary
execution budget is 15 seconds; this slice does not expand it for shell or Claude.
A current-owner watch stops after its first denied/unknown observation and requests
cleanup on the already owned child. Cancellation, timeout, authority loss and
output overflow share one irreversible signal attempt. A refused/unknown signal
is not followed by escalation, a new signal, another executor or a numeric PID
probe.

## Native evidence and output

The production boundary uses `os/exec` and retains the exact `os.Process` object.
It calls Wait once on that child and signals only through that owning object.
There is no lookup or kill by numeric PID/PGID. The Darwin producer creates a
dedicated group but does not infer the group's identity or absence after reaping
its leader. Other platforms refuse native start.

Root Wait, pipe drain, group cleanup and descendant cleanup are separate facts.
The direct producer always reports group and descendant cleanup as unverified
when root Wait settles. A clean root exit, an accepted cancellation request or a
lost Wait observation cannot produce terminal-complete or a qualified Claude
result. Unknown remains sticky. No fake supervisor supplies positive proof.

Retained stdout/stderr share a 4 MiB ceiling. Each read returns at most 64 KiB from
each stream, with byte offsets and independent byte copies. The public DTO carries
base64 rather than assuming UTF-8. Root exit uses bounded pipe drain; incomplete
drain also prevents terminal-complete. Output is disclosed only under the current
selected authority. Cleanup control may still target the retained exact child
after output permission expires; it does not renew that permission.

## Required integration and qualification

Lead owns root boot/cmd/transport and journals. Product activation still needs:

- exact durable reservation/result receipts and authoritative reconnect routing;
- a qualified native confinement producer for the selected immutable command;
- an anchored supervisor with qualified group/cohort and parent-death cleanup,
  composed through the existing Go executable's root entry;
- native disposable qualification of root exit, descendants, signal refusal,
  deadline, output/backpressure and crash windows;
- normal product shell/Git and Claude journeys, then duplicate-executor retirement.

This slice does not create a second Go helper/watchdog or private wire protocol.
It does not restore a process from a PID or infer live admission from journal or
startup bytes. Root-owned integration must preserve existing unknown/refused
operations without retry or probing their children.

## Verification scope

The application tests use clock-controlled authority, reservation and native
boundary doubles. They cover fixed expiry, revoke/generation/root changes,
reservation-before-effect, restart/unknown/conflict, immutable handle selection,
current output disclosure and cancel ACK versus terminal facts.

The infrastructure tests inject the private OS boundary and manual timer. They
exercise one owning handle, Wait uncertainty, output paging/limits, deadline,
owner loss and a refused signal without invoking native spawn, shell, signal,
daemon or provider. A positive cohort observation is supplied only by a labelled
application parser double; the real direct producer never emits that proof.

Race/full CI, native tests, independent risk review, package, installed route and
live provider qualification are outside this bounded source result. Completed
source checks cannot be promoted to those evidence levels.

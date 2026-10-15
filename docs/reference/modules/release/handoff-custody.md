# Inherited handoff custody preparation

`infra/native/handoff` prepares the Go replacement for the existing installed
helper's inherited-lease and closed-predecessor observations. It is not selected
by the updater yet. Normal apply/recover/rollback still uses
`resources/native/update_helper.py`; this source foundation removes no required
Python launch and introduces no new journal, admission owner or install engine.

The verifier borrows the exact home, state and inherited lease descriptors.
It never closes, unlocks, seeks or reconfigures them. The caller retains their
lifetime and the parent's authoritative exclusive lock, including through any
duplicate descriptions. Calls on one verifier serialize with cancelable waiting;
independent verifiers still require caller custody. Successful observations are
neither durable authority nor readiness and must be repeated at effect boundaries.

Inherited verification reopens the canonical fixed home/state route with
no-follow descriptors and existing physical ancestor ownership rules. It binds
the private state and exact regular 0600 single-link lease to lossless decimal
device/inode values. An independent description must fail a nonblocking shared
flock; the inherited description must then pass the idempotent exclusive check.
Unlocked, shared, read-only, crossed, replaced or uncertain descriptions refuse.
No fresh authoritative lease is acquired and no inherited lock is released.

Closed verification additionally requires positively observed absence of the
exact PID; any live/reused PID, error or unknown observation refuses. The process
observer is injected and this package launches no process. No running marker may
exist. The private, bounded last-quit receipt is pinned by full metadata and exact
SHA-256, with strict schema integer 1, confirmed drain and an empty unconfirmed
list. Its timezone timestamp must follow the bound start and cannot be future.
The bounded timestamp parser accepts the actual producer's RFC3339Nano subset,
not every form accepted by Python's wider ISO parser. Cancellation refuses and
never renews the original caller deadline.

Namespace/process changes remain possible between observations; this is not an
atomic race-exclusion claim. The parent exclusion owner and the future helper's
existing journal/effect/unknown fences remain mandatory. This package does not
observe app trees, transfer continuation, perform exchange/rollback or relaunch.

Linux fixtures exercise actual borrowed FDs and flock descriptions, hostile
records, replacement, cancellation and unchanged caller custody. Positive route
fixtures use an unexported disposable-route seam where the Cloud physical root
has an unacceptable UID; production root checks remain strict and their refusal
is separately asserted. Darwin cross-compilation is not Darwin execution.

Retirement requires the remaining physical tree/plist, original process and
continuation, journaled mutation/recovery/rollback and authenticated launch parity,
followed by independently verified Go source selection. Darwin inheritance,
installed helper, clean-Mac launch and OTA/rollback acceptance remain NOT RUN.

## Prepared ACK and continuation transport

`infra/native/helperchannels` separately owns transferred ACK and optional
continuation byte streams. `Take` consumes exclusive ownership even on failure;
request and borrowed lease descriptors must never be passed to it. It performs
no descriptor-number discovery, JSON parsing, peer authentication or application
authorization. The eventual trusted launcher must bind those actual roles.

Pipes require ACK write-only and continuation read-only access; only stream
sockets are also accepted. Owned descriptors become nonblocking, and owned
stream socket linger is disabled. Metadata cannot establish peer trust or the
absence of separately duplicated descriptions; the caller must transfer unique
owners without borrowed aliases and stop using them. Close acts on retained
`os.File` owners through close-once state, never reconstructed descriptor numbers.

Each channel has one consumed attempt, shared across copied wrappers. ACK writes
one private snapshot of 1..4096 bytes and closes its stream to seal EOF.
Continuation returns only 1..4096 bytes followed by observed EOF; byte 4097 or
withheld/late EOF refuses without exposing an accepted frame. Original absolute
deadlines, earlier context deadlines and cancellation apply before and after
native results and before success. Close cancels and joins active nonblocking
operations. Partial or late ACK, uncertain close and active duplicates preserve
uncertainty; no failure permits replay. Successful cleanup is not ACK acceptance.

Linux disposable pipe/socket fixtures cover backpressure, partial writes,
deadline/cancellation, close races, copied wrappers, caller-frame reuse and
ownership on constructor refusal. These are transport tests. The helper's
correlation, readiness, continuation admission, terminal classification and
journaled install/recovery remain separate application integration work. This
package is unselected; Python retirement and Darwin, package, installed and OTA
qualification remain NOT RUN.

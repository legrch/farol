# Predecessor process observation preparation

The desktop selects the Go apply/recovery helpers (`run-closed-release-helper`
and `run-live-release-helper`); there is no Python fallback. The Go process
observer and wait service are called by those entries (`boot/releasehelperclosed.go`,
`boot/releasehelperlive.go`). The retained Python
[`process_start` and `wait_exit`](../../../../resources/native/update_helper.py)
are the behavioural reference and are no longer dispatched. The TypeScript
[`installed-update-helper` adapter](../../../../src/modules/release/infra/native/installed-update-helper.ts)
captures the process-start token and supervises the helper protocol. This page
records the source contract and the remaining gates; it does not claim Python
retirement or installed acceptance.

## Prepared ownership and call graph

The owning helper composes Release
[`processwait`](../../../../modules/release/app/services/processwait/service.go)
with its consumer-owned
[`ProcessProbe` and `ProcessWaitClock` ports](../../../../modules/release/app/port/processprobe.go).
The concrete Release
[`processprobe`](../../../../modules/release/infra/native/processprobe/probe.go)
binds one immutable PID. Root boot composition validates concrete dependencies
and injects the native observer and clock. No Computer internals, generic shell
port, parallel updater, new journal schema or fallback engine is introduced.

1. `processwait.Capture` accepts only a valid positively present start token.
2. `processwait.New` binds that expected token, probe and clock without observing.
3. `ConfirmIdentity` consumes one attempt and retains a private successful witness
   on that service. The caller must confirm before readiness.
4. `WaitExit` consumes one wait after that witness, polls immediately, then sleeps
   at most 100ms, clamped to the remaining budget. Only positively known absence
   within budget succeeds. A different birth refuses as `process_reused`.

Service copies share the private witness and consumption state; a caller cannot
forge it with Python's public `observed=True` shortcut. A failed
confirmation stays consumed. Repeated or concurrent calls cannot duplicate a
confirmation or wait. The witness binds the original probe/token/session, grants
no readiness, admission, lease, process-control or application-effect authority,
and makes no future exclusion guarantee about PID reuse.

Each method receives its own original absolute `until` and preserves that exact
value through every probe call. The earlier context deadline also applies.
Confirmation occurs before readiness; the wait's method budget starts after
readiness. The witness does not bind the two methods to one shared deadline.
The owning helper retains its separate admission/effect budgets and input bounds.
This is a deliberate refinement of Python's relative `wait_exit` end, which is
calculated after its optional initial identity check. Go checks cancellation and
expiry before and after every probe/sleep and before success: late absence cannot
succeed. An in-flight timeout remains unknown; `process_running` requires a
completed matching live observation followed by budget expiry.

Pure app code reads no ambient clock, filesystem or host API. Constructors reject
nil interfaces and require trusted, non-panicking ports without typed-nil
implementations. Concrete native/boot composition must reject typed-nil
dependencies before exposure; the app does not inspect runtime object identity.

## Native authority and lifecycle

Production `processprobe.New` accepts PID 2..MaxInt32 and supports Darwin only.
Unsupported platforms refuse before native observation. Its
[`native boundary`](../../../../modules/release/infra/native/processprobe/native.go)
runs only `/bin/ps -p <decimal> -o lstart=`, with cwd `/`, no stdin or shell, and
exactly `LANG=C.UTF-8` plus `PATH=/usr/bin:/bin`. It inherits no timezone or other
environment. The token preserves the exact trimmed opaque UTF-8 bytes, 1..128
bytes without controls or line separators; there is no date conversion. Token
resolution and visibility remain properties of the existing ps observation.

The observation budget is the earliest of the method's original absolute end,
context deadline and observation-entry plus three seconds. Serialization,
observation and result publication share that budget. Each stream retains at
most 4096 bytes and detects byte 4097 while draining the original pipe. Successful
classification requires the exact original child's terminal Wait, actual EOF on
both stdout and stderr, exit 0 or 1, absolutely empty stderr and valid bounded
stdout. A prefix, forced pipe closure or `ExitError` cannot substitute for EOF.
Only clean empty trimmed stdout permits a signal-zero existence check; ESRCH
alone proves absence. Success, permission errors and other errors stay unknown.
The observed target receives no nonzero signal.

Deadline, cancellation and overflow share one stop arbiter for the retained ps
child: one Start, one Wait after successful Start and at most one Kill. No numeric
PID/PGID reconstruction, lookup or retry can replace that child. Recorded reap
suppresses stale stops. Caller cleanup has a separate fixed one-second cap; late
output or cleanup cannot upgrade a frozen result. If a native primitive remains
blocked, the same private owner retains the original child/cleanup after bounded
caller return. This does not prove cleanup completed. A failure after native
observation ownership begins taints that probe permanently, including copies,
and prevents another launch. Invalid or expired preflight does not launch a child.

## Failure classification and pre-selection blockers

`processwait.Failure` exposes a closed code and `Uncertain` flag. Completed native
unknown/refusal remains `process_unknown` with `Uncertain=false`. Startup,
deadline, cleanup and unclassified failures remain uncertain. Cancellation after
observation begins is uncertain. Neither flag value authorizes retry or settles
an application effect. An absent snapshot accompanied by an error proves nothing.

Two seams were listed here as blockers before selection:

- [`handoff.verifyClosed`](../../../../modules/release/infra/native/handoff/quit.go)
  still flattens observer errors to its process-unknown code (marked uncertain).
  Preserving uncertain startup, timeout and cleanup separately from a completed
  refusal remains an open refinement of the selected route; it must not bypass
  inherited lease, marker or quit checks.
- The helper preserves Python's terminal distinction in boot composition
  (`closedHelperTerminal`): explicit `Refusal` exits 70, while startup
  exceptions, subprocess timeouts and other internal failures emit
  `phase=unknown`, `error=internal` and exit 79. The Go uncertainty flag alone
  is not a complete terminal/protocol mapping.

The TypeScript adapter still owns helper-child supervision, readiness/continuation
and terminal protocol correlation, original child exit evidence, cancellation,
Electron/IPC integration and the current token capture route. The Go helper
selection replaced backend observation through the owning Release service
while retaining the desktop adapter responsibilities and accepted public DTOs.

## Evidence and retirement criteria

[`composition_test.go`](../../../../modules/release/infra/native/processprobe/composition_test.go)
imports the real app service into the native package. Controlled private native
fixtures cover completed refusal versus startup/timeout/EOF uncertainty through
Capture, Confirm and Wait; valid birth, reused birth, late absence, sticky native
taint and shared once-state. A separate actual fixed ps test captures and confirms
this Linux test process through the app using the private native constructor.
That is portable mechanism evidence only. It does not activate production Linux
observation or qualify Darwin tokens, timing, cleanup or helper integration.

The complete Go helper is composed and selected by the single owning route.
Python can retire only after the old duplicate is removed and these gates are
closed against exact candidate bytes:

- Darwin actual ps parity with Python and TypeScript, including locale/timezone,
  opaque token bytes, process visibility/reuse, EOF, timeout and cleanup behavior.
- The uncertain-versus-refused terminal mapping above, original budget retention,
  successful pre-readiness confirmation and once-only post-readiness waiting.
- Existing input validation, inherited custody, admission/owner lease, normal Quit
  ACK/receipt, slot binding, physical tree/identity checks, journal/crash recovery,
  atomic exchange and one-shot relaunch boundaries, with no unknown-effect replay.
- Aggregate source checks and separate native, package, installation and live/OTA
  acceptance for the composed helper and its desktop adapter.

Actual Darwin locale/timezone/token parity, native lifecycle acceptance, composed
helper cutover, package, installed and live/OTA gates remain **NOT RUN** for this
source preparation. Linux fixtures and cross-compilation cannot close them. See
[the Release index](README.md), [handoff custody](handoff-custody.md) and
[installed-helper verification](app-verification.md) for the adjacent contracts.

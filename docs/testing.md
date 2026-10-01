# Farol Next GUI test policy

## Evidence hierarchy

Electron tests should not interrupt the owner's desktop merely because they exercise
a renderer. Use the least visible route that preserves the evidence:

1. Pure policy and geometry run under Vitest with no Electron process.
2. DOM, screenshot, provider-failure, stream-failure, and runtime-death scenarios run
   in a `BrowserWindow` created with `show: false` and never shown.
3. One interaction run may be visible because it proves the native
   `WebContentsView` surface and focus transfer. It is positioned before first show
   and displayed with `showInactive()`. The window is activated only for the final
   native focus-transfer assertion, then closed immediately.

The default visible selector is deterministic: non-primary internal, then any
non-primary. `--built-in-display-only` excludes external displays, including
when the built-in display is primary and an external secondary is present.
Selecting that primary display also requires `--allow-primary-display` and an
explicit current owner grant. Native focus still requires its own current grant.
The exact requested 1180x760 viewport is centered inside that display's work area.
If no secondary can preserve it, the visible lane fails closed instead of using the
primary display or shrinking the assertion. The harness records that condition as a
`BLOCKED` topology preflight before starting any visible application window, including
the exact required viewport and owner action. Equivalent hidden evidence remains valid
only for boundaries that do not require native visibility or focus. The packaged and
development reports include the actual display class, display count, work area,
bounds, and initial focus observation.

Ordinary `npm run preview` and `task run` launches retain foreground product
behavior. The explicit `task run -- --hidden` owner option maps only to hidden
presentation through the same committed-candidate/snapshot/NEW-profile admission.
It does not enable E2E overrides, debug access, another profile or primary-display
permission. A hidden owner run still requires normal Quit and cannot prove visible
interaction. It refuses a second-instance reopen; ordinary owner reopen stays
unchanged, and older primaries reject the extra request field without revealing a window.

The two accepted presentation arguments used by the E2E harness are
`--preview-window-mode=hidden` and
`--preview-window-mode=secondary-visible`; unknown or repeated values fail closed.
The E2E harness also sets `FAROL_NEXT_E2E=1` for one bounded startup-delay argument;
without that explicit harness marker the delay is ignored. This makes a second launch
during startup deterministic without changing the owner command.

When the current owner grant does not permit native focus, pass
`--skip-native-focus` after the task separator. The harness still runs the hidden and
inactive-secondary evidence, records the mandatory focus rows as
`blocked-owner-authorization`, and exits non-zero with a `BLOCKED` report. The flag is
not acceptance evidence for native focus and never turns those rows into skips or
passes.

During an explicitly authorized unattended run on the MacBook display, pass
`--built-in-display-only --allow-primary-display`; omit `--skip-native-focus`
only when that same grant permits test-owned native focus. The separate
inactive-reopen fixture activates only its own isolated window on the built-in
display and measures both applications' real active state before and after
the second launch. It is closed immediately after that proof.

The sealed and development E2E lanes also close the macOS window, prove the exact
`Farol Next Runtime` PID remains, invoke a second launch with the same isolated
identity, and prove one window reopens without a second utility process. Quit then
waits for the exact main and named utility PIDs to disappear; no generic Electron
process-name cleanup is used. A separate task-owned Electron Legacy fixture is started
before and after Next in isolated homes, and a Next utility-process failure must leave
its synthetic read endpoint available. The startup-race case additionally proves that
the reopened window already has both task views and live runtime bootstrap state.

The ordinary-product E2E fixture also implements the installed Codex App Server
contract closely enough to exercise the product's two dynamic tools on their required
threads. It proves one child workspace probe, one parent authority receipt, a bounded
nonterminal wait, same-child completion, durable delivery, and invalidation after the
Computer generation changes. Its model is synthetic; exact host selection and live
model execution remain separately classified evidence.

## Default-off Product Agent acceptance

The production Model and Farol-backed Product Agent routes remain disabled. The
complete development and sealed-package lanes require the current ChatGPT,
Computer, task, context, Setup, and native-host verification cases, plus a
real-task `task.start-agent` and `task.rejoin-agent` refusal. That refusal must
return `AGENT_NOT_READY` without a Product Agent input, assignment, host
request, or child launch. The fixture records Codex app-server starts and
agent requests around those commands; a native Agent used by Setup's separate
verification does not count as Product Agent admission.
The task-menu draft also survives the default-off refusal; it is cleared only
after a successful assignment or the owner's own menu dismissal.

The positive Product Agent cases are retained in the versioned lane contract
as `productAgentQualification.status = NOT_QUALIFIED`. They are not required
or executed in a default-off lane, and the eligibility verifier rejects a
default-off attempt that omits this classification or claims one of those
positive cases. A PASS for the default-off lane proves only its declared
active behavior. It does not qualify Product Agent, native focus when skipped,
an installed host, or a live provider. Earlier failed attempts remain failed
historical receipts; changing the contract does not rewrite them.

`task test:soak` is the separate hidden lifecycle/performance lane. It fixes the
seed, performs five warm-up cycles, then fifty measured create/close cycles in batches
of five ordinary task surfaces. Task-menu and Quick Switcher overlays alternate, and
two fixed batches restart the application on the same private state before the final
zero-task restart. The lane records provider navigation separately from local create,
overlay, and close latency, plus windows, `WebContentsView` instances, renderer
contents, the shared download listener, exact runtime process, main/runtime file
descriptors, Electron working set, and main-process active resources. Its budgets are
declared in the driver before measurement. Every batch must return to zero tasks and
provider surfaces. The result is the `report.json` of its attempt under
`_output/evidence/lifecycle-soak/`; it is
deterministic `FIXTURE_APP` evidence, not authenticated-provider performance.

`task test:persistence-fault` is a separate hidden `SIMULATED_FAULT` lane.
It admits one task durably, then rejects every later live-task store commit while
the provider URL and lifecycle continue changing. The task must become visibly
outcome-unknown, a later owner mutation must fail closed, and the retained file
must remain at the last successful snapshot. Its exact-head report is the
`report.json` of its attempt under `_output/evidence/persistence-fault/`.

`task test:two-generation-state -- --predecessor-artifact=<manifest>` is the
hidden lane for the owner's state across two sealed generations. Generation A is the
predecessor that manifest names: the lane runs the verifier of A's own source commit
in the checkout the manifest names, after proving every file of that commit's
`tooling/` and package manifests is byte-identical there, so A is never re-qualified
by this candidate's tooling. B is this package. Both run in turn on one isolated user
data directory: A completes Setup, creates, renames and pins tasks, and leaves a context
handoff offered after one completed turn; B launched while A runs must be refused as
`identity-mismatch` without touching A's state; A is killed with a provider turn
running; B's first activation is killed before any window. B must then read A's
settings, tasks and context store byte for byte, report the interrupted turn as
outcome-unknown without submitting anything, refuse A while it runs, confirm the
handoff A offered and retire its source, and keep its own change across a restart; the
rollback to A must read B's state without rewriting it, and neither bundle's tree
digest may change. The ChatGPT dispatch-intent journal, undelivered agent results and
bundle placement are outside it. The report is the `report.json` of its attempt under
`_output/evidence/two-generation-state/`.

The final owner journey is separate from automation: `task run` is launched with
the normal home and no test-only application arguments, the harmless Legacy connector
read is repeated around it, and the application is quit by its exact instance. This
live observation must be recorded as blocked when the connector is unavailable; status
JSON is not a substitute.

## Why hidden evidence is still valid

Electron documents that a `BrowserWindow` created with `show: false` paints by
default while initially hidden. Playwright's Electron API can inspect the main
process and capture a renderer screenshot without requiring OS-level visibility.
The E2E lane therefore checks every hidden window remains hidden through teardown and
also validates every recorded PNG is non-empty. It does not replace native focus
proof, packaged-byte verification, or real `WebContentsView` assertions with a DOM
mock.

Primary references:

- <https://www.electronjs.org/docs/latest/api/browser-window>
- <https://www.electronjs.org/docs/latest/api/screen>
- <https://www.electronjs.org/docs/latest/api/structures/display>
- <https://playwright.dev/docs/api/class-electron>

## Running one journey instead of the whole lane

The ordinary lane launches every instance it declares and drives every case it
owns. `--only=<selector>[,<selector>…]` runs just the segments a selector
names, so a single journey can be re-driven against the real application while
a defect is being fixed. A selector is a segment name or a case-id prefix a
segment owns, and `tooling/e2e-selection.mjs` holds the map; a selector that
matches nothing fails the run before anything launches.

A selected run is reported as `SELECTED`. That status is terminal, so the
attempt still closes honestly, but it is never `PASS`: `evidence-eligibility`
rejects every non-PASS outcome, so a selected attempt can never be bound, and
the lane's required cases are not evaluated against it. It cannot be combined
with `--lifecycle-soak`, `--persistence-fault` or `--two-generation-state`,
each of which names one whole declared workload. Selection is for
reproduction; a qualifying run is always the full lane.

The gate sits at each segment's `try`, so a skipped segment still launches and
closes its instance before breaking out. Skipping everything therefore costs
the launch/close cycles, not zero.

## When a late harness failure is not a product failure

The runner accumulates its case list as it runs. It hands the live lists to the
evidence attempt with `trackRecords`, so a run interrupted by a late exception
records the journeys it actually executed instead of a terminal receipt reading
`cases: []`.

`close()` reads the application three times — window presentation, utility
metrics, and the close itself. An application that has already exited cannot
answer any of them, and Playwright reports that by message alone. Those reads
go through a guard that recognises exactly the "target is gone" shapes and
rethrows everything else. When it fires, the run records a
`closed-before-inspection` observation naming the case that owned the instance,
keeps the run classified as a failure, and does not count a quit it could not
prove. That keeps "the product exited early" distinguishable from "the harness
raced its own close", instead of one opaque exception thrown out of a `finally`
that replaces the real first failure.

## Tests that need the Bash sandbox disabled

`tests/integration/evidence-observe.test.mjs` observes real operating-system
processes. Under the Bash sandbox it fails 3 of 5 — two time out after 30 s
with `condition never reached`, and one reports an extra `PRODUCT_NOT_OBSERVED`
reason — and passes all 5 in under four seconds without it. The same applies to
any Electron or end-to-end run. The failures are an artifact of the sandbox,
not of the code under test.

## A new case is declared in the same commit that records it

`tooling/evidence-cases.mjs` is the independent declaration of what each lane must run, so a case
the runner records but the contract does not declare makes the lane's completeness check
meaningless. Add the declaration beside its siblings in the same commit that adds the
`cases.push`, and run `tests/integration/evidence-cases-contract.test.mjs` — that test is what
catches the omission, and it is cheap enough that there is no reason to discover it from a lane.

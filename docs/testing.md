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

The visible selector is deterministic: non-primary internal, then any non-primary.
The exact requested 1180x760 viewport is centered inside that display's work area.
If no secondary can preserve it, the visible lane fails closed instead of using the
primary display or shrinking the assertion. The harness records that condition as a
`BLOCKED` topology preflight before starting any visible application window, including
the exact required viewport and owner action. Equivalent hidden evidence remains valid
only for boundaries that do not require native visibility or focus. The packaged and
development reports include the actual display class, display count, work area,
bounds, and initial focus observation.

Ordinary `npm --prefix vnext run preview` launches do not carry a test window mode and
retain foreground product behavior. The two accepted test-only arguments are
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

`task next:test:soak` is the separate hidden lifecycle/performance lane. It fixes the
seed, performs five warm-up cycles, then fifty measured create/close cycles in batches
of five ordinary task surfaces. Task-menu and Quick Switcher overlays alternate, and
two fixed batches restart the application on the same private state before the final
zero-task restart. The lane records provider navigation separately from local create,
overlay, and close latency, plus windows, `WebContentsView` instances, renderer
contents, the shared download listener, exact runtime process, main/runtime file
descriptors, Electron working set, and main-process active resources. Its budgets are
declared in the driver before measurement. Every batch must return to zero tasks and
provider surfaces. The result is the `report.json` of its attempt under
`artifacts/lifecycle-soak/`; it is
deterministic `FIXTURE_APP` evidence, not authenticated-provider performance.

`task next:test:persistence-fault` is a separate hidden `SIMULATED_FAULT` lane.
It admits one task durably, then rejects every later live-task store commit while
the provider URL and lifecycle continue changing. The task must become visibly
outcome-unknown, a later owner mutation must fail closed, and the retained file
must remain at the last successful snapshot. Its exact-head report is the
`report.json` of its attempt under `artifacts/persistence-fault/`.

`task next:test:two-generation-state -- --predecessor-artifact=<manifest>` is the
hidden lane for the owner's state across two sealed generations. Generation A is the
predecessor that manifest names: the lane runs the verifier of A's own source commit
in the checkout the manifest names, after proving every file of that commit's
`tooling/` and package manifests is byte-identical there, so A is never re-qualified
by this candidate's tooling. B is this package. Both run in turn on one isolated user
data directory: A completes Setup and creates, renames and pins tasks; B launched
while A runs must be refused as `identity-mismatch` without touching A's state; A is
killed with a provider turn running; B's first activation is killed before any window;
B must then read A's settings byte for byte and its tasks, report the interrupted turn
as outcome-unknown without submitting anything, refuse A while it runs, and keep its
own change across a restart; the rollback to A must read B's state without rewriting
it, and neither bundle's tree digest may change. Context checkpoints and bundle
placement are outside it. The report is the `report.json` of its attempt under
`artifacts/two-generation-state/`.

The final owner journey is separate from automation: `task next:run` is launched with
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

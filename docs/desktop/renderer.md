# Desktop renderer contract

F0 is an in-process window facade (`src/ui/renderer/contract.ts`), not a second
wire protocol. One WindowController owns named preload subscriptions and bootstrap.
React observes immutable snapshots through useSyncExternalStore. React teardown
removes observation only; it does not cancel tasks, acknowledge results, destroy
WebContentsView, or dispose the controller. The entrypoint owns window teardown.

Commands are explicit user intentions. A synchronous per-window latch coalesces
concurrent controls for one intention, and retains uncertain outcomes. This does
not provide durable exactly-once execution. The authoritative backend still owns
operation binding. Distinct intentions have distinct IDs. A conflicting payload
for a pending/unknown ID is refused; a lost reply is unknown, never safe to replay.

The legacy adapter has no authenticated runtime incarnation, per-stream sequence,
or general retained operation query. F0 reports those capabilities as unavailable,
with only the existing workspace-edit observation supported. Task revisions,
configuration request order, and native layout are separate clocks. A mirrored
host overlay cannot close a renderer-owned overlay. Transcript deltas never enter
renderer Activity. Activity is bounded, window-local metadata, not durable history.

Core's host-only generated bridge is `apps/desktop/bridge/{wire,client}.ts`.
A future capability adapter consumes it in the trusted host, maps safe projections
into the same facade, verifies handshake/build/profile/generation, rejects old
incarnations, and resnapshots gaps. The composed host includes selected Go Computer and Chat seams; this does not
qualify the renderer adapter or native journeys. No renderer imports
raw transport, bearer secrets, native execution, or backend internals. No switch
of executors is allowed after a refused or potentially effective operation.

## Evidence map

R01: deliberately invalid TSX fails the actual strict compiler configuration;
valid counterpart passes, and real .test.tsx tests execute.
R03: executable negative controls reject host React, direct/indirect Node imports,
backend internals and dynamic imports; valid JSX/contract imports pass.
R05-R08, R10-R11, R13-R18, R20-R26, R30, R38, R41: controller/component fixtures
exercise applicable ordering, privacy, StrictMode, intent, async failure,
observation-only teardown, native action provenance and error-boundary behavior.
R09/R12: legacy limitations are explicit. Fixture overflow resnapshots state;
no authenticated-incarnation or Go event acceptance is claimed.

Source/component tests do not prove native focus, compositor occlusion, browser
session lifetime, installed reload, live providers, or an installed update.
R19 and final integration/installed portions require the exact integrated
candidate. The built hidden harness exercises applicable R04, R25-R26,
R29 and R32-R34 plus compact/resize portions of R37; a PASS must be read from
its actual execution receipt, not inferred from the existence of the harness. Existing permission/reverification/edit-delivery policy
helpers remain authoritative. D5 retirement waits for replacement coverage.

Shared prerequisite changes (package/lock, TSX configuration, build JSX mode,
dependency attestation/notices, renderer test environment/coverage and lint) are
included in this source composition. Exact integrated checks and native acceptance
remain Lead-owned.

## Approved shell implementation

The production build entry is `src/ui/renderer/entry.tsx`, with one React root,
one controller and exclusive ownership of its descendants. The old `shell.ts`
entry and old HTML/CSS are not loaded by this build. Approved tokens use a 58px
single toolbar, 62px icon rail and 232px contextual sidebar, with native bounds
computed by the host from those logical states. Theme changes preserve geometry.
Home, settings pages, work slots, Activity inspection, search, task assignment,
update review and toolbar task options use the same facade. Native browser pages
remain WebContentsView instances owned by the host.

Settings drafts remain mounted when switching settings pages. Task drafts retain
the existing selected-task reset rule and composed-under authority, which changing
appearance or reopening a menu cannot refresh. Native folder selections remain
opaque; typed paths cannot create approval. Read, write, exclusions and full-Git
approval remain independent existing commands. Explicit shortcuts save through
one latch; valid stored shortcuts activate in the window lifecycle outside React.
New profiles start Home. Configured profiles preserve the existing launch choices.

Only an exact, schema-valid observed edit result matching both the pending
operation and workspace enables Record result delivery. The owner confirms after
viewing the outcome. Unknown acknowledgement retains the same latch and pending
record. Render/unmount never sends an acknowledgement or repeats an edit.

Release phases are presentation of existing authoritative eligibility. Later,
restart, recover and rollback are distinct commands sharing one update latch.
Unavailable/refused/unknown states never imply successful application. Automatic checks already belong to the host: initialization starts a check and
`UPDATE_RECHECK_MS` schedules later checks. The facade exposes explicit check
and current state but no scheduling preference. Automatic installation and
explicit interruption remain separate unavailable controls. K0 status alone
cannot supply these capabilities.

The approved Signal Color master supplies fixed-color Dock/ICNS bytes for both
themes. Native template pixels are embedded in the host to preserve the existing
schema-6 entry closure. Historical predecessor/rollback packages and installed
icon acceptance still require Lead's exact release qualification.

## Native harness and retirement gate

`tests/e2e/react-shell.e2e.mjs` requires an explicitly selected, hash-verified
Electron root; it never installs dependencies. It owns a guarded disposable
profile, hidden window and loopback GET-only synthetic document. Native bounds,
overlay occlusion and view identity are inspected in the owned child. Evidence
is local `_output/evidence/react-shell`, and is not an installed/provider receipt.
Fixture startup refusals are retained as failed tests, not native UI acceptance.

Do not count inactive legacy presentation source assertions as React coverage.
`tests/renderer` is the replacement coverage scope. Old presentation source/tests
remain pending their explicit consumer inventory and native replacement gates;
policy helpers remain applicable. Existing `preview.e2e.mjs` and guided-setup
harnesses target retired selectors and are not qualified for the new shell.
D5 removal and R19/R40/R44/R45 require their missing native/backend/integration
witnesses. Source acceptance does not mark this migration product done.

## Legacy consumer inventory and pending exits

| Inactive presentation consumer                                                                                                    | Replacement                                                                        | Remaining deletion witness                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/ui/shell.ts`, `shell.html`, `shell.css`                                                                                      | One `renderer/entry.tsx` build and renderer-only assets                            | No old entry in input ledger; full CI and packaged new-profile/configured-profile setup flow               |
| `guided-onboarding-view.ts` modal/required IDs                                                                                    | Mounted settings pages, Home readiness and configuration forms                     | Native real folder selection and successful first-run/recheck failure/retention paths                      |
| `installed-update-view.ts` DOM writers                                                                                            | Passive React update sheet with distinct backend commands                          | Exact package check/apply/recover/rollback eligibility and retained unknown outcome                        |
| `agent-draft-contract`, `task-menu-note-contract`, `watch-rail-product-contract` source assertions                                | `tests/renderer/{controller,shell,settings}.test.*` and existing pure policy tests | Task note/result UI inventory and native acknowledgement correlation before deleting historical assertions |
| `preview.e2e.mjs`, `guided-setup-selection.e2e.mjs`, `dev-onboarding-startup.e2e.mjs`, `setup-config-error.e2e.mjs` old selectors | `react-shell.e2e.mjs` covers shell/native geometry/composition subset              | Port the remaining operational cases; selector retirement alone is not replacement coverage                |

These inactive files are not imported by the production renderer. Their tests
remain tracked and do not substantiate the new UI. Pure draft, setup, permission,
reverification and exact edit-delivery policies remain shared and applicable.
D5 is pending, not complete. The original K0 foundation alone did not qualify a
feature operation adapter. Later Settings delivery and controlled Chat milestones
are recorded in [Desktop Core](../desktop-core.md); they do not close every R09,
durable R19 or dual-adapter R40 case for the remaining product flows.

The window preserves newer runtime/update notifications while a read is pending.
A conflicting same-revision task response leaves controls stale. Settings can
accept a deliberate new user action after a known refusal and a corrected cause;
unknown outcomes remain fenced. Browser controls use one canonical intention on
all pages. An explicit native Updates command received during bootstrap is
retained until readiness, deduplicated by its event ID, and never dispatched from
a render Effect. Closing the owned window stops new facade dispatches; it does
not cancel already admitted work.

The initial renderer writer lacked a reviewed Electron distribution. The later
integration line packaged and qualified the exact controlled normal-entrypoint
candidate recorded in [Desktop Core](../desktop-core.md#controlled-normal-desktop-chat).
That Dev witness proves its hidden React/Go journey and clean same-build restart;
it does not prove native focus, installation, live provider Send or production
connector compatibility. Every later candidate still needs its own declared
dependencies, source identity and applicable native/package evidence.

Settings retain the last ready presentation solely to keep draft-owning forms
mounted through a temporary configuration failure. Actual configuration status
still fences every command; cached settings never restore permission or evidence.
A ready recovery refresh preserves draft identity and value without saving it.

The legacy configuration ordering policy may retain an older ready snapshot when
a latest read reports a configuration error. Such a refresh marks the facade
stale even when local runtime status is ready, so cached permissions cannot enable
commands. The component unavailable-projection regression and controller failed-
read regression exercise these two distinct boundaries.

Pending/unknown intentions retain a SHA-256 payload digest rather than serialized
commands, including credential-entry values. The latch is installed before
hashing or transport; hashing failure refuses before admission, and eligibility
is checked again after hashing. Production uses Chromium Web Crypto; component
fixtures use a synchronous Node SHA implementation behind its async contract.
Native sidebar menu/shortcut publishers send a provenance-stamped action to the
same window controller as toolbar clicks. Host layout mirrors cannot overwrite
its sidebar or close current overlays. Superseded reads are discarded before
parsing, so an older malformed bootstrap cannot invalidate newer current state.

Window teardown fences late bootstrap/refresh reads, layout and preference writes.
Already admitted commands still settle from their original reply; disposal never
cancels or repeats them. React root remounts using the same live controller retain
pending/unknown intentions and return observation counts to baseline. These
component regressions cover R11/R15/R17/R22 only. They do not satisfy R19: a full
renderer reload creates a new controller, and the legacy adapter has no general
authoritative pending-operation projection. Lead must supply that module contract
before durable reload conformance or a Go feature adapter can be accepted.

The native menu bar reads current host status before each explicit left/right-click
opening, instead of attaching a startup context menu. Its disposer removes both
listeners and fences a queued opening before destroying the owned tray once.
The menu policy fixture mocks Electron and proves status refresh, passive opening,
existing command routing and cleanup; it is not visible macOS menu acceptance.

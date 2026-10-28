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

## Current shell implementation

The production build entry is `src/ui/renderer/entry.tsx`, with one React root,
one controller and exclusive ownership of its descendants. The old `shell.ts`
entry and old HTML/CSS are not loaded by this build. The shared geometry in
`src/pkg/shell-layout/geometry.ts` supplies a 58px toolbar, a 62px desktop icon
rail and a 232px default contextual sidebar (resizable from 152px to 288px).
At widths of 850px or less, the rail is 58px and the contextual sidebar uses
an overlay when opened. React, native browser bounds and native sidebar actions share
the same compact-width predicate. The page-list resizer draws its single
boundary; it does not add another sidebar border. Theme changes preserve geometry.
Home, settings pages, work slots, Activity inspection, search, task assignment,
update review and toolbar task options use the same facade. Native browser pages
remain WebContentsView instances owned by the host.

Settings drafts remain mounted when switching settings pages. Task drafts retain
the existing selected-task reset rule and composed-under authority, which changing
appearance or reopening a menu cannot refresh. Native folder selections remain
opaque; typed paths cannot create approval. Read, write, exclusions and full-Git
approval remain independent existing commands. Explicit shortcuts save through
one latch; valid stored shortcuts activate in the window lifecycle outside React.
The default page shortcuts follow the sidebar order: Home (⌘1), ChatGPT (⌘2),
Activity (⌘3) and Setup (⌘4). Settings always uses ⌘,. Previously saved defaults
migrate to this order; supported custom page assignments remain assigned, with
the former This Mac assignment opening Setup. These commands also work while
Setup is open and keep the native action provenance and update admission fence.
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

Sunrise is the current icon direction. Runtime PNG and bundle ICNS resources
use the same artwork in both themes; the current export does not yet distinguish
Dev with a separate badge. The earlier Signal / Color approval remains historical.
In-app SVG emblems and the native menu-bar template mark are separate resources.
Source mapping and asset checks do not establish Dock, Finder or installed icon
acceptance, which remain exact-build qualification steps.

## Setup and Home

Setup is a separate top-level destination: Connection, Folders & access, Add to
ChatGPT, then Finish. It presents the same configuration, evidence and commands
as Settings. Reviewing Setup does not reset a profile, clear credentials, add a
grant, verify access or repeat a command. Embedded ChatGPT sign-in and Model
configuration are optional for external Computer readiness. A partial profile
retains its configured state and offers a continuation path after reopening.

Home implements the current sidebar proposal, still under owner review rather
than owner accepted. Its five local views are Overview, Current work, Needs
attention, Recent activity and Connection & access. Task/event/attention selection
opens an inspector inside Home; Back and Forward retain that local destination.
Only explicit destination actions leave Home. Projections reuse existing task,
Activity and configuration evidence, with no extra task, issue or history store.
Task targets use exact identity, so reusing a numbered browser window cannot make
an old record open another task. The global rail has no New-chat plus.

Command eligibility follows the owning operation and its dependencies. Independent
optional Model/browser uncertainty does not invalidate current Computer evidence.
Computer, connector, shared configuration writer and unclassified uncertainty
still block conflicting effects. Safe navigation and supported observation do not
settle an unknown outcome; stale generations and late replies remain fenced.

| Behavior                                                                     | Executable coverage                                                       | Evidence boundary                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Home-local navigation, exact task targets and missing evidence               | `tests/renderer/home.test.tsx` and `controller.test.ts`                   | Renderer fixtures; no provider or native focus claim                                                       |
| Separate Setup, retained credential drafts and non-destructive review        | `tests/renderer/settings.test.tsx` and `controller.test.ts`               | DOM/command projection; normal native dialog and external attachment are separate                          |
| Optional versus shared/Computer uncertainty and freshness                    | `tests/renderer/computer-setup.test.ts`, `settings.test.tsx`              | Pure/renderer contracts; unknown is never settled by remount                                               |
| Fresh and partial Setup, Appearance, Quit/reopen, retained live idle browser | `tests/e2e/dev-onboarding-startup.e2e.mjs`                                | Built current React + real Go + local provider fixture; four hidden disposable lifetimes, zero Sends       |
| Normal/compact bounds, Light/Graphite, bounded resizer and overlay detach    | The same restored idle-browser phase in `dev-onboarding-startup.e2e.mjs`  | Real Electron child bounds and React rectangles; renderer-directed input, not visible focus or OS AX       |
| Cleared/destroyed browser contents and safe native detach                    | `tests/unit/native-view-visibility.test.ts` plus the native journey above | Callback regression and real child attachment; visible keyboard focus and OS AX inspection remain separate |

The four-lifetime native journey passed at source `5c702016`, build
`a3bea6c3d99de91bc3fd5b348f037add4d6f465c1b7193fe7e96d7ac18b0204a`,
attempt `7dd3cc15-f8bf-411a-9353-b18c33ef584e`. All lifetimes recorded clean
closure. It does not prove clean-profile external attachment, installation,
provider Send or an update. Actual ordinary Dev also retained a completed file
edit across the same-source rebuild/reopen and exposed the original result through
`computer_mutation_read`; that external receipt is separate from this fixture.

The extended journey passed at source `5376fac6`, build
`7387e945193394eb45189e785f5a3ee9f478b492bbade8d28336dc54244afba3`,
attempt `c7f91524-fc2a-4205-b007-ce9313b726a9`. It compared actual native and
React bounds at 1160px and 800px in Light and Graphite, checked both resizer
limits and the single divider, and detached the same live browser during
resize, search and compact-sidebar overlays. Renderer-directed overlay input
produced no fixture-provider input or Send. Original window/sidebar/theme values
were restored; all four app lifetimes closed cleanly. Sampled windows stayed
hidden and unfocused. This does not qualify visible compositor routing, OS AX,
IME, a real provider or installation.

Separate ordinary Dev evidence on source `5c702016` observed the actual provider
AX subtree disappear on Home and under search, then return on dismissal. The
search field initially lost focus to Close; `fdd51fa5` fixed that modal ordering
and an owning renderer regression proved the failure before the correction.
Visible ordinary Dev at `67d8af51` then accepted immediate typing after Command-K.
Its one timed-out Open ChatGPT action remains unconfirmed and was not repeated;
the newer hidden fixture cannot settle it. Ordinary Dev at `5376fac6` separately
passed fresh external attachment after normal Quit/reopen and retained Home-local
Back/Forward navigation. These are distinct receipts, not a single full native
or installed acceptance claim.

## Native harness and retirement gate

`tests/e2e/react-shell.e2e.mjs` requires an explicitly selected, hash-verified
Electron root; it never installs dependencies. It owns a guarded disposable
profile, hidden window and loopback GET-only synthetic document. Native bounds,
overlay occlusion and view identity are inspected in the owned child. Evidence
is local `_output/evidence/react-shell`, and is not an installed/provider receipt.
Fixture startup refusals are retained as failed tests, not native UI acceptance.
That legacy harness still requires build schema 3; it was not used to qualify
the current Go schema-4 build. The current Setup harness above owns the new
normal/compact geometry witness.

Do not count inactive legacy presentation source assertions as React coverage.
`tests/renderer` is the replacement coverage scope. Old presentation source/tests
remain pending their explicit consumer inventory and native replacement gates;
policy helpers remain applicable. Existing `preview.e2e.mjs` and
`guided-setup-selection.e2e.mjs` target retired selectors and are not qualified
for the new shell. `dev-onboarding-startup.e2e.mjs` has been ported to the
current React Setup with the bounded evidence described above.
D5 removal and R19/R40/R44/R45 require their missing native/backend/integration
witnesses. Source acceptance does not mark this migration product done.

## Legacy consumer inventory and pending exits

| Inactive presentation consumer                                                                     | Replacement                                                                                            | Remaining deletion witness                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `src/ui/shell.ts`, `shell.html`, `shell.css`                                                       | One `renderer/entry.tsx` build and renderer-only assets                                                | No old entry in input ledger; full CI and packaged new-profile/configured-profile setup flow               |
| `guided-onboarding-view.ts` modal/required IDs                                                     | Separate React Setup sharing mounted Settings forms and readiness evidence                             | Native real folder selection and external first-run/recheck failure paths                                  |
| `installed-update-view.ts` DOM writers                                                             | Passive React update sheet with distinct backend commands                                              | Exact package check/apply/recover/rollback eligibility and retained unknown outcome                        |
| `agent-draft-contract`, `task-menu-note-contract`, `watch-rail-product-contract` source assertions | `tests/renderer/{controller,shell,settings}.test.*` and existing pure policy tests                     | Task note/result UI inventory and native acknowledgement correlation before deleting historical assertions |
| `preview.e2e.mjs`, `guided-setup-selection.e2e.mjs`, `setup-config-error.e2e.mjs` old selectors    | `react-shell.e2e.mjs` and current-React `dev-onboarding-startup.e2e.mjs` cover distinct native subsets | Port remaining operational cases; hidden fixture coverage is not external or installed acceptance          |

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

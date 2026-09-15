# Farol Next design-lab specification

Status: `OWNER_REVIEW_PENDING`

Four preserved directions, one owner decision. `Keeper's Slate` is the graphite-first candidate
added by the second design session after the owner's first-look feedback; it is this session's
provisional recommendation, not an owner-approved design, and it is not integrated into the
product UI. Studio Rail, Operator Grid, and Beacon Field are the unchanged first-lab baseline.

## Evidence levels

| Level                       | Meaning                                         | Current result                                                                                           |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Proposed                    | A visual/product decision for review            | Four directions; Keeper's Slate as the graphite-first comparison candidate                               |
| Implemented in lab          | Working local DOM behavior with synthetic data  | All four directions share Browser, Computer, Activity, Setup, Settings, states, compact, keyboard, focus |
| Integrated product behavior | Real Electron composition and production source | Not attempted; runtime-owned `vnext/src/ui` remains untouched                                            |

This directory is a **tracked, nonshipping design lab**. Production source does not import it;
the lab has no preload or IPC bridge; its Content Security Policy blocks connections; and its
runner uses `contextIsolation`, renderer sandboxing, disabled Node integration, web security, and
an exact two-page local allowlist. `tests/design-lab.e2e.mjs` verifies that boundary with blocked
sibling-file and external navigation probes.

## Owner feedback that shaped the fourth direction

Recorded on 2026-09-15 after the first lab:

- Beacon Field is interesting as a composition, but its green/teal identity did not land.
- Studio Rail's graphite character feels closer, but it is too ordinary and lacks a memorable,
  ownable signature.
- No direction is approved.

The brief for the fourth direction therefore was: graphite and neutral materials as the dominant
field; green or teal never as identity or broad surface; one coherent Farol signature from
composition, hierarchy, a task-state device, material, or interaction; a composition that is
materially different from all three baselines rather than a palette swap.

## Fair comparison

All four directions render the same `Atlantic workspace check` fixture in two matched scenes:
`Browser / Running` and `Computer / Waiting`, at `1180 x 760` and `760 x 640`, captured @2x. The
gallery changes composition, tokens, and density, not content, state, or information
architecture.

| Direction          | Intent                                                                                | Strength                                             | Trade-off                                                     |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| **Studio Rail**    | Native Mac restraint: graphite chrome, light work document, system blue               | Calm, familiar, lowest learning cost                 | Farol identity recedes; no memorable signature                |
| **Operator Grid**  | Dense expert tool: compact rail, sharper boundaries, cyan signal                      | Fast scanning and more working area                  | Higher visual and cognitive pressure                          |
| **Beacon Field**   | Distinctive Farol: horizontal command shelf, deep teal field, warm beacon             | Ownable composition with clear task state            | Green/teal identity did not pass the owner's first look       |
| **Keeper's Slate** | Graphite-first: the selected task fuses into one plate; shape-coded lamps carry state | Ownership made physical; Browser gets the full width | Plate fusion and lamp glyphs still need native tab-view proof |

### Provisional candidate: Keeper's Slate

Keeper's Slate answers the feedback without borrowing the earlier conclusions: its field is
graphite, its only chroma is six small lifecycle lamps and one lamplight action, and its
composition differs from every baseline. Studio Rail remains the conventional sidebar fallback;
Beacon Field remains the shelf composition the owner found interesting; Operator Grid remains the
density reference. The owner's decision is one choice among four.

## Graphite hypotheses considered

Two graphite compositions were sketched before implementation; one was built.

| Hypothesis                   | Composition                                                                                                                                | Verdict                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keeper's Slate** (built)   | Sections in the unified title bar; task tabs in a dark well; the selected tab fuses into a graphite plate holding dossier bar plus Browser | Chosen: makes "this Browser belongs to this task" physical, keeps the documented tabs-on-top mental model, gives the page the full width, and stays native (tab-view and unified-toolbar idioms) without a sidebar   |
| **Ledger Column** (rejected) | Vertical task ledger at the left with lamps and the selected-task dossier; sections in a toolbar; Browser full height                      | Rejected: drifts toward a chat-list app and the familiar three-pane Mac pattern the owner called faceless; costs Browser width on wide windows; needs a DOM restructure to fold the inspector into the ledger column |
| Machined graphite (rejected) | Studio Rail skeleton with recessed selection and bevelled edges                                                                            | Rejected as a polish pass of Studio Rail, not a new direction                                                                                                                                                        |

## Keeper's Slate

### The one Farol idea: the task plate

Farol is a lighthouse keeper's tool: one task at a time is lit, and its state is always legible.
In Keeper's Slate the selected task tab does not sit above the work; it _becomes_ the top edge of
a graphite plate. That plate holds everything task-bound in one continuous object: the dossier
bar (lifecycle lamp and state word, task label, model and mode facts, the Computer fact, one
forward action, the task menu), the task-bound Browser page, and the lab disclosure. Unselected
tasks rest in the dark well above the plate with their own lamps, so every task's state stays
visible while only one owns the plate. Fusion is reserved for the task-bound views: on Browser
and Computer the selected tab and the plate share one surface with no seam. On the app-wide
views (Activity, Settings) the plate is closed: the selected tab stays lit, but the plate edge
runs beneath it, so the audit and the application settings are never read as belonging to one
task.

The device is deliberately physical rather than decorative: no accent underline, no glow, no
texture. The plate's edge line, the tab's shoulders, and the page inside it are the identity.

### Lamps: lifecycle by shape

Every surface that names a state uses the same glyph family, so `Outcome unknown` can never be
mistaken for `Failed` at a glance, and no state depends on color alone.

| State             | Lamp                             | Colour token         |
| ----------------- | -------------------------------- | -------------------- |
| `Running`         | Filled disc with a beam          | `--lamp-running`     |
| `Waiting`         | Open ring with a centre dot      | `--lamp-waiting`     |
| `Complete`        | Filled disc with a cut-out check | `--lamp-complete`    |
| `Failed`          | Filled disc with a cut-out cross | `--lamp-failed`      |
| `Unavailable`     | Dashed ring                      | `--lamp-unavailable` |
| `Outcome unknown` | Thin ring with a question mark   | `--lamp-unknown`     |

Lamps appear in task tabs, the dossier state, the Computer status pill, the fixture control, and
Activity rows; the live Activity row carries the exact state so `Outcome unknown` and
`Unavailable` show their own lamp rather than a generic attention mark. Only the selected task's
running lamp breathes, slowly, and only when motion is allowed; reduced motion freezes it. The
lamps stay legible at standard density (see the `@1x` evidence).

### Visual grammar

| Role          | Lab token                                                 | Use                                                              |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Type          | `-apple-system`, BlinkMacSystemFont, SF Pro Text fallback | All UI and document labels; compact scale, no display typography |
| Window ground | `#121315`                                                 | The well behind the tabs and around the plate                    |
| Title bar     | `#1b1c1f`                                                 | Unified title bar with identity, lab controls, sections, runtime |
| Plate         | `#202226` with `#4d5057` edge                             | The selected task's surface; the selected tab shares both        |
| Document      | `#f2f0eb` / `#1f2124`                                     | The task-bound Browser page inside the plate                     |
| Lamplight     | `#efe7d6` on `#1b1c1e` ink                                | The one forward action, the brand mark, text selection           |
| Lamps         | warm white, amber, green, red, grey, warm white           | Six small lifecycle glyphs; the only chroma besides lamplight    |
| Focus         | `#79b3ff`, 2 px outline                                   | Keyboard location, independent of any state colour               |
| Geometry      | 6 px controls, 8 px tab shoulders, 10 px plate corners    | One silhouette: square top edge under the tabs, rounded bottom   |

Green appears only on the `Complete` lamp and the runtime-ready dot; teal does not appear.
Measured contrast on the plate: body text 13.1:1, muted 6.6:1, quiet 4.9:1, lamps 4.9:1 to
12.1:1, lamplight action ink 13.9:1.

### Composition

- **Unified title bar.** Traffic lights, the brand lamp, `Farol Next`, the permanent
  `Interactive lab · synthetic data` disclosure, the quick switcher, and the lab-only fixture
  control (labelled `Fixture ·`) on the left; the section segmented control and the runtime
  readiness on the right. The whole row is a window drag region with the controls excluded. The
  model readout moves into the dossier facts. DOM order equals visual order, in the title row and
  in the dossier: the task menu sits left of the primary action, which is the rightmost control.
  Between 1000 px and the compact breakpoint the section labels collapse to icons instead of
  ellipsizing.
- **The well.** Task tabs with lamps, and the visibly disabled `New task` boundary. Unselected
  tabs are quiet text; hover reveals a ghost shoulder.
- **The plate.** Dossier bar, then the Browser page with its synthetic toolbar; Computer renders
  on the fused plate, Activity and Settings on the closed plate, all with a compact heading scale.
  The keyboard focus ring of a task tab is inset so the strip never clips it.
- **Popovers.** The task menu anchors to its `⋯` button and the fixture menu to its control
  through CSS anchor positioning, so both open beside their triggers in every layout.

### Compact behaviour (`760 x 640`)

The plate stays. Section labels collapse to icons with stable accessible names and tooltips; the
runtime label stays readable; the dossier keeps the lamp, state word, title, primary action, and
menu on one row and hides the secondary facts row; the page keeps its toolbar and document; long
task labels truncate inside their tab. Computer, Activity, and Settings stack and scroll inside
the plate with a visible scrollbar.

### What is deliberately absent

No right inspector column, no sidebar, no accent underline, no glow or texture, no display-size
headlines on global views, no green or teal field, and no second `Open Activity` text link in the
dossier (the primary action and the task menu already carry it).

## Surface inventory

### Shared shell

- Window identity and permanent `Interactive lab · synthetic data` disclosure.
- Browser, Computer, Activity, and Settings routes. Studio Rail uses a conventional sidebar,
  Operator Grid a compact icon rail, Beacon Field a horizontal command shelf, and Keeper's Slate a
  segmented control in the unified title bar; labels collapse to icons in compact mode.
- Horizontally scrollable task tabs with selected task, label, and lifecycle state.
- Model/readiness disclosure, quick switcher, fixture state control, and a visibly disabled New
  task boundary.
- The Settings `Direction` row now reports the rendered direction instead of a fixed name.

### Browser

- Synthetic Browser toolbar and local-address disclosure.
- Selected task label, run identity, summary, progress, lifecycle panel, and network truth.
- Studio Rail, Operator Grid, and Beacon Field keep a right inspector with facts and action, and
  move a reduced inspector below the document in compact mode. Keeper's Slate replaces the
  inspector with the dossier bar above the page in both sizes.
- The selected-task menu opens Activity, the waiting Computer request, or Setup; unavailable
  Computer action is disabled outside `Waiting`.

### Computer

- Exact capability request, target, return, duration, persistence, and authority.
- `Allow once` and `Decline`; both disable when no waiting request exists.
- Available fixture status contrasted with unavailable files, commands, and screen access.

### Activity

- Human-readable lifecycle event with task label, time, state, and recovery language.
- All / Needs attention / Complete filters.
- Explicit retention and never-shown content boundaries.

### Setup and Settings

- Five-step Setup: ChatGPT, Computer, Connect, Hosts, Verify.
- General, Appearance, Keyboard, and Privacy categories.
- Preview identity and unavailable live capabilities remain visible rather than inferred ready.

## Interaction contract

| Input                                         | Result                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Click section or `⌘1` to `⌘4`                 | Move among Browser, Computer, Activity, Settings                        |
| Click task, arrow within task tabs, or `⌃Tab` | Select a task without mixing its lifecycle state                        |
| `⌘K`                                          | Open searchable sections/tasks; focus returns to its trigger            |
| Selected-task menu                            | Open Activity, waiting Computer request, or Setup                       |
| Review Computer request                       | Open the exact bounded request                                          |
| Allow once                                    | Record one fixture approval, return to Browser, move to Running         |
| Decline                                       | Record no Computer action and open Activity with Failed                 |
| Fixture control                               | Render Running, Waiting, Complete, Failed, Unavailable, Outcome unknown |
| Review setup                                  | Open a modal five-step journey; Escape/close returns focus              |

Dialogs use native `<dialog>` semantics and visible focus. `prefers-reduced-motion: reduce`
collapses transitions and animations to `0.001ms`. Compact mode preserves routes and makes
scrolling explicit for longer content.

## Open and verify

From the `vnext` directory with the exact lockfile installed:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show --query="direction=slate&section=browser&task=atlantic&state=waiting"
```

Without `--query` the lab opens Beacon Field, the first-lab default. Open the four-direction
comparison gallery instead:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show --gallery
```

Run the interaction, boundary, reduced-motion, wide/compact, and Retina evidence suite:

```sh
node design-lab/tests/design-lab.e2e.mjs
```

The generated result is `gallery/report.json`; it includes the visible launch display selection
and any primary-display fallback. `gallery/directions-overview@2x.png` is the single comparison
view with all four directions in rows. Each direction has separate `Browser / Running` and
`Computer / Waiting` PNGs at both `1180 x 760` and `760 x 640`, all at @2x. Beacon Field keeps
its Activity unknown-outcome, compact Settings, and Setup evidence; Keeper's Slate adds
`slate-browser-waiting-wide`, `slate-browser-unknown-compact`, `slate-activity-unknown-wide`,
`slate-settings-unavailable-compact`, `slate-setup-wide`, `slate-task-menu-open-wide` for the
anchored popover, `slate-focus-visible-wide` for the inset keyboard ring, and
`slate-browser-waiting-wide@1x` for standard density (macOS ignores the device-scale switch, so
the suite rasterises that frame again through a CDP device-metrics override).

The suite parks the pointer and drops keyboard focus before every capture so interaction residue
never leaks into evidence, and it proves the fourth direction with dedicated cases: fused task
plate on Browser and Computer and the closed plate on Activity and Settings, shape-coded lamps
that stay absent from the baseline directions, bounded Computer approval, anchored task and
fixture menus with focus return, keyboard paths, the compact plate, the title-bar drag region,
the labelled fixture control, dossier Tab order, the 1180 to 870 px title-row resize band, the
inset focus ring, and the running lamp under reduced motion. The suite file is part of the
evidence digest, so a changed suite changes `prototypeSha256`.

## Independent review

An independent macOS UI review (2026-09-15, DOM-lab scope, read-only) judged the platform fit
good and raised one P1, four P2, and five P3 findings. All were addressed in this lab: the
unified title bar is now a drag region (P1); the dossier Tab order follows the visual order, the
plate closes on app-wide views, section labels collapse instead of ellipsizing in the resize
band, and the tab focus ring is inset and captured (P2); standard-density evidence, a direct
reduced-motion proof for the lamp, the `Fixture ·` label, an unfiltered Activity capture, and the
suite-in-digest rule close the P3 items. The review also listed shared-shell observations that
belong to the baseline owner and were left unchanged here: popover menus are button lists
without `role="menu"` or arrow-key traversal, the task strip hides its scrollbar, the document
progress rail is colour-only, task tabs have no context menu, and arrow-key task selection also
switches to the Browser section.

## Baseline preservation

The three first-lab directions are untouched by design: their tokens, compositions, and DOM
remain as committed at `35d83de6`, and the shared-shell changes are limited to registering the
fourth direction, the truthful Settings `Direction` row, and an exact-state attribute on the live
Activity row that only Keeper's Slate styles. Regenerating the evidence in this worktree
reproduced all fifteen baseline PNGs byte-for-byte in the final run; one earlier run showed a
28-pixel anti-aliasing jitter in a 14 x 2 px region of one compact Operator Grid capture, which
is rasterisation noise rather than a design change.

## Production integration map

No production files are changed by this branch. A later coordinated D6 pass would:

1. map the chosen direction's tokens and components into the then-current `vnext/src/ui`
   ownership boundary;
2. preserve the real task-bound WebContentsView instead of copying the synthetic DOM page;
3. reproduce toolbar/menu commands and shortcuts through production Electron menus;
4. test selected/unselected native view visibility, resize, focus, hit testing, drag regions,
   and overlays in both target sizes; for Keeper's Slate this includes proving the fused tab and
   plate around a native view and the anchored popovers over it;
5. retain existing sandbox, task-correlation, network, Activity-redaction, and coexistence gates;
6. run the required review and package/E2E lifecycle before any integration claim.

The lab runner follows the existing GUI policy: non-primary internal display, then any non-primary
display, then an explicit internal-primary or primary fallback; visible launch is shown inactive.

That pass waits for explicit path ownership coordination and the owner's visual decision. The
next owner action is one question: **Which of Studio Rail, Operator Grid, Beacon Field, or
Keeper's Slate becomes the production design target?**

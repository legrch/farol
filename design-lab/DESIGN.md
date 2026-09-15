# Farol Next design-lab specification

Status: `OWNER_REVIEW_PENDING`

Five preserved directions, one owner decision. `Watch Rail` is the third design session's
provisional candidate: Studio Rail's sidebar, finished with a rail that keeps watch, graphite
materials, one accent light, and a typeface study. Its accent and typeface stay open for the
owner. `Keeper's Slate` is the second session's candidate; Studio Rail, Operator Grid, and Beacon
Field are the unchanged first-lab baseline. No direction is owner-approved, and none is
integrated into the product UI.

## Evidence levels

| Level                       | Meaning                                         | Current result                                                                                           |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Proposed                    | A visual/product decision for review            | Five directions; Watch Rail as the session-3 candidate with an open accent and typeface choice           |
| Implemented in lab          | Working local DOM behavior with synthetic data  | All five directions share Browser, Computer, Activity, Setup, Settings, states, compact, keyboard, focus |
| Integrated product behavior | Real Electron composition and production source | Not attempted; runtime-owned `vnext/src/ui` remains untouched                                            |

This directory is a **tracked, nonshipping design lab**. Production source does not import it;
the lab has no preload or IPC bridge; its Content Security Policy blocks connections; and its
runner uses `contextIsolation`, renderer sandboxing, disabled Node integration, web security, and
an exact two-page local allowlist. `tests/design-lab.e2e.mjs` verifies that boundary with blocked
sibling-file and external navigation probes.

## Owner feedback

### First look, after the first lab (2026-09-15)

- Beacon Field is interesting as a composition, but its green/teal identity did not land.
- Studio Rail's graphite character feels closer, but it is too ordinary and lacks a memorable,
  ownable signature.
- No direction is approved.

### Second look, after Keeper's Slate (same day)

The warm, yellowish cast of the lab is not wanted; darker and cooler designs are preferred. Keeper's Slate was
therefore retuned to a cool graphite palette with a dark task page; its composition, plate, and
lamps did not change.

The brief for the fourth direction therefore was: graphite and neutral materials as the dominant
field; green or teal never as identity or broad surface; one coherent Farol signature from
composition, hierarchy, a task-state device, material, or interaction; a composition that is
materially different from all three baselines rather than a palette swap.

### Third look, across the four directions (same evening)

- The graphite field is right.
- Tabs on top are original, but a sidebar is clearer: task tabs will already live on top, and a
  sidebar that collapses into a compact rail is appealing.
- Operator Grid is interesting but too bright; Beacon Field reads yellowish and uninteresting.
- Keeper's Slate resembles Studio Rail and is hard to grow, because sections and tasks both sit on
  top and it is unclear what happens there.
- The owner wants a genuinely striking colour and asked whether Studio Rail should be the base.
- The current typefaces do not appeal; they feel rounded and not sharp enough.

The brief for the fifth direction therefore was: keep Studio Rail's places-and-tasks structure,
make the sidebar collapse to a rail, stay graphite, choose one confident cool accent that is not
green, teal, yellow, or neon, and study stronger typography without dropping the native option.

## Fair comparison

All five directions render the same `Atlantic workspace check` fixture in two matched scenes:
`Browser / Running` and `Computer / Waiting`, at `1180 x 760` and `760 x 640`, captured @2x. The
gallery changes composition, tokens, and density, not content, state, or information
architecture.

| Direction          | Intent                                                                                   | Strength                                             | Trade-off                                               |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| **Studio Rail**    | Native Mac restraint: graphite chrome, light work document, system blue                  | Clearest structure: places left, tasks on top        | Farol identity recedes; no memorable signature          |
| **Operator Grid**  | Dense expert tool: compact rail, sharper boundaries, cyan signal                         | Fast scanning and more working area                  | Cyan signal reads as too bright                         |
| **Beacon Field**   | Distinctive Farol: horizontal command shelf, deep teal field, warm beacon                | Ownable composition with clear task state            | Warm and teal identity did not land                     |
| **Keeper's Slate** | Graphite-first: the selected task fuses into one plate; shape-coded lamps carry state    | Ownership made physical; Browser gets the full width | Sections and tasks both on top; harder to extend        |
| **Watch Rail**     | Studio Rail's sidebar, finished: a rail that keeps watch, one accent light, a type study | Clear structure with its own light and a live rail   | Accent and typeface still open; rail needs native proof |

### Provisional candidate: Watch Rail

Watch Rail takes the owner's answer seriously: the most understandable structure is Studio Rail's,
so it keeps that structure and fixes what made Studio Rail forgettable. The sidebar collapses to a
rail that still reports every task; the work page turns dark with the tool; one accent carries
selection and the next action; and typography gets a sharper voice. Keeper's Slate stays the
top-oriented alternative, Beacon Field the shelf composition, Operator Grid the density reference.

## Hypotheses considered

### Session 2: two graphite compositions, one built

| Hypothesis                   | Composition                                                                                                                                | Verdict                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keeper's Slate** (built)   | Sections in the unified title bar; task tabs in a dark well; the selected tab fuses into a graphite plate holding dossier bar plus Browser | Chosen: makes "this Browser belongs to this task" physical, keeps the documented tabs-on-top mental model, gives the page the full width, and stays native (tab-view and unified-toolbar idioms) without a sidebar   |
| **Ledger Column** (rejected) | Vertical task ledger at the left with lamps and the selected-task dossier; sections in a toolbar; Browser full height                      | Rejected: drifts toward a chat-list app and the familiar three-pane Mac pattern the owner called faceless; costs Browser width on wide windows; needs a DOM restructure to fold the inspector into the ledger column |
| Machined graphite (rejected) | Studio Rail skeleton with recessed selection and bevelled edges                                                                            | Rejected as a polish pass of Studio Rail, not a new direction                                                                                                                                                        |

### Session 3: sidebar-first compositions, one built

| Hypothesis                    | Composition                                                                                                | Verdict                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Watch Rail** (built)        | Full-height sidebar that collapses to a watching rail; task tabs on top; one dossier bar above the Browser | Chosen: keeps the structure the owner finds clearest, gives the rail a product job, and leaves the Browser the full content width |
| Split inspector (rejected)    | Studio Rail with a collapsible left rail and a collapsible right inspector, as in Mac pro apps             | Rejected: two side panes squeeze the Browser at `1180 x 760` and double the layout states before the owner has chosen a direction |
| Vertical task list (rejected) | Rail for sections plus a second column listing tasks instead of top tabs                                   | Rejected: the owner expects task tabs on top; a task column would duplicate them and turn the app toward a chat list              |

Accent candidates were limited to cool hues that no lifecycle state already owns: amber means
Waiting, green Complete, red Failed. Iris violet is the default because it reads as a light rather
than a status and matches macOS's own Purple accent; Cobalt is the most Mac-familiar blue; Orchid is
the boldest. Typefaces were limited to rights-clear families that work offline.

## Watch Rail

### The one Farol idea: the rail keeps watch

Farol is a lighthouse keeper's tool, and a keeper watches every light at once. In Watch Rail the
sidebar is not only navigation: each section carries a live signal. Browser counts running tasks,
Computer counts requests waiting for approval, Activity counts tasks that need attention (the same
set its own filter shows), and Settings shows when the local runtime is offline. Collapse the
sidebar to its 72 px rail and the signals stay, as small badges that keep the lamp shape and the
count, so a task waiting for Computer authority is visible from anywhere without giving the rail
back its width. Each signal carries its sentence twice: in the item's tooltip and as a spoken
description, such as "1 request waiting for approval". Opening Computer from that signal shows the
task that owns the request, even when another task is selected, with its approval actions enabled.
The accent never encodes a state: Running has its own cool-white lamp in every accent.

### Composition

- **Sidebar.** Full height, with the traffic lights and the sidebar toggle in its title area, the
  four sections with live signals, and runtime readiness at the bottom. A faint accent light falls
  from the top of the sidebar; it is the shell's only ambient colour.
- **Rail.** `⌃⌘S` or the toggle collapses the sidebar to 72 px: icons, badges, tooltips, and
  unchanged accessible names. Below 980 px the rail is the default, and the toggle opens the full
  sidebar above the content instead of pushing it; Escape, choosing a section, or clicking outside
  closes it, and Escape returns focus to the toggle.
- **Toolbar.** The brand mark, `Farol Next`, the `Interactive lab · synthetic data` disclosure,
  the quick switcher, and the lab-only `Fixture ·` state control. The whole row and the sidebar
  title area are window drag regions with every control excluded.
- **Task tabs.** On top of the content. The selected tab is lit: a raised surface tinted by the
  accent, with an accent line along its top edge. Every tab shows its lamp and state word.
- **Dossier bar.** The selected task above the full-width Browser: an action row with the lamp and
  state word, the task title, the task menu and the primary action as the rightmost pair at a fixed
  gap, and a facts line beneath it with Model, Mode, and Computer. Tab order follows that visual
  order. The task menu and fixture menu open anchored to their buttons.
- **Browser page.** Dark with the tool, framed, with its synthetic toolbar and address.
- **Global views.** Computer, Activity, and Settings use the same compact heading scale, an accent
  context line, and lamps in every status.

### Accent study

| Accent     | Fill (white label)    | Light     | Character                                        |
| ---------- | --------------------- | --------- | ------------------------------------------------ |
| **Iris**   | `#705def` → `#5945de` | `#b4a8ff` | Default. Blue-violet; reads as light, not status |
| **Cobalt** | `#2e6ee5` → `#215cca` | `#8fb6ff` | Most familiar on a Mac                           |
| **Orchid** | `#ad45d3` → `#9832bd` | `#e9adff` | Boldest; closest to a consumer identity          |

Each accent retints the graphite neutrals toward its own hue at 7 to 12 percent saturation, so
the field stays graphite rather than coloured. The suite checks, for all three accents, that
white on both ends of the primary gradient, the accent light, body text, muted and quiet text,
the document text, and the Waiting, Failed, and Unavailable lamps all reach at least 4.5:1.

### Typeface study

| Typeface     | Families                                     | Why it is in the study                                                                |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Geist**    | Geist and Geist Mono, variable (SIL OFL 1.1) | Default. A crisp grotesk with squarer shapes than SF at display sizes; a mono sibling |
| **IBM Plex** | Plex Sans and Plex Mono, Latin (SIL OFL 1.1) | The most engineered and least rounded; the most distinctive voice                     |
| **SF Pro**   | System font and SF Mono                      | The native option, with a lighter display weight than the earlier directions          |

Display headings use weight 600 with tight tracking instead of the heavier, rounder 700-plus
settings of the first lab. Monospace is reserved for identifiers, times, keys, the address, and
the dossier state word. The bundled fonts are unmodified copies from npm packages, recorded with
integrity hashes and licences in `fonts/PROVENANCE.md`; they load locally under the lab's
connection-blocking policy. Choosing a bundled face for the product needs the owner's decision
and the licence notice in the shipped app.

### Visual grammar (Iris)

| Role     | Lab token                                                 | Use                                                              |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Content  | `#131316`                                                 | Toolbar, tabs, dossier, and global views                         |
| Sidebar  | `#19181d`                                                 | Sidebar and rail, with a faint accent light from the top         |
| Page     | `#0e0d10`                                                 | The task-bound Browser page                                      |
| Text     | `#edecf3`, `#abaab6`, `#8e8c9b`                           | Primary, muted, and quiet text                                   |
| Accent   | `#7f6bff`, light `#b4a8ff`                                | Selection, the selected tab, progress, the running lamp          |
| Primary  | gradient `#705def` → `#5945de`                            | The one forward action, with a white label                       |
| Lamps    | cool white, amber, green, red, grey, pale grey            | Running, Waiting, Complete, Failed, Unavailable, Outcome unknown |
| Focus    | `#9e8fff`, 2 px outline                                   | Keyboard location                                                |
| Geometry | 7 px controls, 8 to 9 px items and tabs, 10 px page frame | One quiet radius family                                          |

### What is deliberately absent

No right inspector column, no light paper page, no neon or glow on content, no decoration on the
Browser page (in production that page is the real provider surface), and no green, teal, or
yellow surface.

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

| Role          | Lab token                                                 | Use                                                               |
| ------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Type          | `-apple-system`, BlinkMacSystemFont, SF Pro Text fallback | All UI and document labels; compact scale, no display typography  |
| Window ground | `#0e1013`                                                 | The well behind the tabs and around the plate                     |
| Title bar     | `#15181c`                                                 | Unified title bar with identity, lab controls, sections, runtime  |
| Plate         | `#1b1f24` with `#4a535e` edge                             | The selected task's surface; the selected tab shares both         |
| Document      | `#14171b` / `#e6eaef`                                     | The task-bound Browser page inside the plate, as dark as the tool |
| Moonlight     | `#e7edf4` on `#12161b` ink                                | The one forward action, the brand mark, text selection            |
| Lamps         | cool white, amber, green, red, grey, cool white           | Six small lifecycle glyphs; the only chroma besides moonlight     |
| Focus         | `#79b3ff`, 2 px outline                                   | Keyboard location, independent of any state colour                |
| Geometry      | 6 px controls, 8 px tab shoulders, 10 px plate corners    | One silhouette: square top edge under the tabs, rounded bottom    |

Green appears only on the `Complete` lamp and the runtime-ready dot; teal does not appear, and
nothing warm-tinted covers a large surface. Measured contrast on the plate: body text 13.7:1,
muted 6.5:1, quiet 4.8:1, lamps 5.3:1 to 13.4:1, moonlight action ink 15.4:1.

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
  Operator Grid a compact icon rail, Beacon Field a horizontal command shelf, Keeper's Slate a
  segmented control in the unified title bar, and Watch Rail a collapsible sidebar with live
  signals; labels collapse to icons in compact mode.
- Horizontally scrollable task tabs with selected task, label, and lifecycle state.
- Model/readiness disclosure, quick switcher, fixture state control, and a visibly disabled New
  task boundary.
- The Settings `Direction` row now reports the rendered direction instead of a fixed name.

### Browser

- Synthetic Browser toolbar and local-address disclosure.
- Selected task label, run identity, summary, progress, lifecycle panel, and network truth.
- Studio Rail, Operator Grid, and Beacon Field keep a right inspector with facts and action, and
  move a reduced inspector below the document in compact mode. Keeper's Slate and Watch Rail
  replace the inspector with a dossier bar above the page in both sizes.
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
- Watch Rail adds lab-only Accent and Typeface radio groups under Appearance and a sidebar
  shortcut row under Keyboard; the other directions do not show them.

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
| Sidebar toggle or `⌃⌘S` (Watch Rail)          | Collapse to the rail; below 980 px open the sidebar above the content   |
| Escape, a section, or a click outside         | Close the overlaid sidebar; Escape returns focus to the toggle          |
| Accent or Typeface radio (Watch Rail)         | Switch the study live; arrow keys move the choice                       |

Dialogs use native `<dialog>` semantics and visible focus. `prefers-reduced-motion: reduce`
collapses transitions and animations to `0.001ms`. Compact mode preserves routes and makes
scrolling explicit for longer content.

## Open and verify

From the `vnext` directory with the exact lockfile installed, open Watch Rail:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show --query="direction=watch&section=browser&task=atlantic&state=waiting"
```

Add `&accent=cobalt` or `&accent=orchid`, and `&type=plex` or `&type=system`, to open another
study variant; both also switch live in Settings, Appearance. Replace `direction=watch` with
`slate`, `native`, `dense`, or `beacon` for the other directions; without `--query` the lab opens
Beacon Field, the first-lab default. Open the five-direction comparison gallery instead:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show --gallery
```

Run the interaction, boundary, reduced-motion, wide/compact, and Retina evidence suite:

```sh
node design-lab/tests/design-lab.e2e.mjs
```

The generated result is `gallery/report.json`; it includes the visible launch display selection
and any primary-display fallback. `gallery/directions-overview@2x.png` is the single comparison
view: five directions in rows, then the Watch Rail accent and typeface study. Each direction has
separate `Browser / Running` and `Computer / Waiting` PNGs at both `1180 x 760` and `760 x 640`,
all at @2x. Beacon Field keeps its Activity unknown-outcome, compact Settings, and Setup evidence;
Keeper's Slate keeps `slate-browser-waiting-wide`, `slate-browser-unknown-compact`,
`slate-activity-unknown-wide`, `slate-settings-unavailable-compact`, `slate-setup-wide`,
`slate-task-menu-open-wide`, `slate-focus-visible-wide`, and `slate-browser-waiting-wide@1x` (macOS
ignores the device-scale switch, so the suite rasterises that frame again through a CDP
device-metrics override). Watch Rail adds `watch-browser-waiting-wide`,
`watch-rail-browser-waiting-wide`, `watch-compact-sidebar-overlay`, `watch-activity-unknown-wide`,
`watch-settings-unavailable-compact`, `watch-settings-appearance-wide`, `watch-setup-wide`,
`watch-accent-cobalt-wide`, `watch-accent-orchid-wide`, `watch-type-plex-wide`, and
`watch-type-system-wide`.

The suite parks the pointer and drops keyboard focus before every capture so interaction residue
never leaks into evidence. Keeper's Slate cases prove the fused plate, shape-coded lamps absent
from the first-lab directions, bounded approval, anchored menus, keyboard paths, the compact plate,
the drag region, the labelled fixture control, dossier Tab order, the resize band, the inset focus
ring, and the lamp under reduced motion. Watch Rail cases prove the bundled fonts load and apply,
the sidebar collapses to the rail by click and `⌃⌘S` with an instant change under reduced motion,
the rail signals and their descriptions for every state, the badges staying on the rail icons,
the absence of all Watch Rail chrome in other directions, drag regions, dossier Tab order and the
anchored menu, bounded approval and keyboard paths, the keyboard-operable accent and typeface
radios, 4.5:1 contrast for all three accents, the compact dossier, and the compact overlay that
does not move the content and closes by Escape, a section, or a click outside. The suite file is
part of the evidence digest, so a changed suite changes `prototypeSha256`.

## Independent review

### Watch Rail

A second independent macOS UI review (2026-09-15/16, DOM-lab scope, read-only) judged the platform
fit good with the sidebar open or collapsed and raised one P1, six P2, and seven P3 findings.

Fixed in the lab:

- Computer now names and acts on the task that owns the waiting request, instead of showing the
  selected task with disabled buttons (P2, and a defect the other directions shared).
- Rail badges keep their lamp shape, the attention signal counts the same set the Activity filter
  shows, every signal repeats its sentence in the item's tooltip, and the runtime dot has a shape
  plus a label that stays in the accessibility tree when the rail hides it (P2).
- The compact overlay takes the content out of the tab order with `inert`, dims it, and moves focus
  into the sidebar when it opens; Escape still returns focus to the toggle (P2).
- Status text is at least 10 px everywhere, and the state word left monospace for the interface
  font (P2).
- The Activity recovery sentence wraps instead of truncating, so "inspect Activity before any
  retry" stays readable (P2).
- The accent no longer doubles as the Running lamp, and it left the non-interactive context and
  synthetic labels (P3).
- The task menu and the primary action sit at a fixed gap; the facts moved to their own line (P3).
- The title bar keeps one height and one traffic-light position at every width (P3).
- The sidebar toggle has its own icon, and it is named Collapse or Expand at wide widths and Show
  or Hide in the compact overlay (P3).
- The lab marker stays on the fixture control in compact, and the study rows are labelled
  `lab study` (P3).
- New evidence: focus ring, the open task menu, rail attention badges, an in-between 940 px width,
  compact Activity with an unknown outcome, and a standard-density frame (P3).

Not fixed here, and why:

- **P1, and the top integration risk.** In production the Browser page is a native
  `WebContentsView` that draws above the app's own HTML, so the compact overlay, the task menu, the
  quick switcher, and Setup would appear beneath it, and clicks or Escape inside the page would not
  reach them. This is a property of every direction's overlays, not of Watch Rail's composition. The
  integration map below names the three implementations that can resolve it; the DOM lab cannot.
- Shared-shell items that belong to the baseline and would change the preserved directions: the
  Settings sun icon and the `Open …` route names, the `Review result` action that only raises a
  toast in the Complete state, popover menus without menu semantics, the hidden task-strip
  scrollbar, the colour-only progress rail, no context menu on tabs, and arrow-key task selection
  also switching section.
- Production-only questions: the inactive-window appearance, the declared minimum window size, and
  VoiceOver output for the badges.

### Keeper's Slate

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

## Type and script coverage

Geist and IBM Plex are bundled for the study, and the lab's interface is English. The IBM Plex
files are the Latin subset; Geist's coverage beyond Latin is not verified here. Any label outside
the bundled coverage, such as a Cyrillic task name, falls back to the system font, which is safe in
the lab but must be decided before a bundled face ships: either keep the system font, or add the
scripts the product needs and the licence notice.

## Baseline preservation

The first-lab directions and Keeper's Slate are untouched by the fifth direction. The shared-shell
additions are hidden by the `hidden` attribute outside Watch Rail (the sidebar toggle, the rail
signal badges, the Appearance radios, and the Keyboard shortcut row), the lamp glyph shapes moved to
`:root` unchanged, and the lamp rules now name both directions through `:is()`, which keeps their
specificity and order. Regenerating the evidence reproduced all 27 earlier PNGs byte-for-byte.
Only `directions-overview@2x.png` and `report.json` changed among the earlier files, because the
gallery gained a row and the study.

## Production integration map

No production files are changed by this branch. A later coordinated D6 pass would:

1. map the chosen direction's tokens and components into the then-current `vnext/src/ui`
   ownership boundary;
2. preserve the real task-bound WebContentsView instead of copying the synthetic DOM page, and
   decide first how overlays sit above it: a transparent overlay view with input routed from the
   main process, a push layout that narrows the page while the sidebar is open, or hiding the page
   while an overlay is up. The same decision covers the task menu, the quick switcher, and Setup,
   and it is the first thing a D6 pass must prove;
3. reproduce toolbar/menu commands and shortcuts through production Electron menus;
4. test selected/unselected native view visibility, resize, focus, hit testing, drag regions,
   and overlays in both target sizes; for Keeper's Slate this includes proving the fused tab and
   plate around a native view and the anchored popovers over it; for Watch Rail it includes the
   collapsing sidebar with real traffic-light placement, a View menu item for Show or Hide Sidebar
   on `⌃⌘S`, the overlaid sidebar above a native view, and rail signals fed by the real task
   registry;
5. retain existing sandbox, task-correlation, network, Activity-redaction, and coexistence gates,
   and ship the licence notice for any bundled typeface the owner chooses;
6. run the required review and package/E2E lifecycle before any integration claim.

The lab runner follows the existing GUI policy: non-primary internal display, then any non-primary
display, then an explicit internal-primary or primary fallback; visible launch is shown inactive.

That pass waits for explicit path ownership coordination and the owner's visual decision. The
next owner action is one question: **Which of Studio Rail, Operator Grid, Beacon Field, Keeper's
Slate, or Watch Rail becomes the production design target, and if it is Watch Rail, with which
accent and typeface?**

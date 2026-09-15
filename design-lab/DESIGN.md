# Farol Next design-lab specification

Status: `OWNER_REVIEW_PENDING`

`Beacon Field` is the provisional recommendation and the implemented interactive lab target. It
is not owner-approved and is not integrated into the product UI.

## Evidence levels

| Level                       | Meaning                                         | Current result                                                                      |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Proposed                    | A visual/product decision for review            | Three directions and the Beacon recommendation                                      |
| Implemented in lab          | Working local DOM behavior with synthetic data  | Browser, Computer, Activity, Setup, Settings, states, compact mode, keyboard, focus |
| Integrated product behavior | Real Electron composition and production source | Not attempted; runtime-owned `vnext/src/ui` remains untouched                       |

This directory is a **tracked, nonshipping design lab**. Production source does not import it;
the lab has no preload or IPC bridge; its Content Security Policy blocks connections; and its
runner uses `contextIsolation`, renderer sandboxing, disabled Node integration, web security, and
an exact two-page local allowlist. `tests/design-lab.e2e.mjs` verifies that boundary with blocked
sibling-file and external navigation probes.

## Fair comparison

All three directions render the same `Atlantic workspace check` fixture in two matched scenes:
`Browser / Running` and `Computer / Waiting`. The gallery changes tokens and density, not
content, state, or information architecture.

| Direction         | Intent                                                                    | Strength                                           | Trade-off                                     |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **Studio Rail**   | Native Mac restraint: graphite chrome, light work document, system blue   | Calm, familiar, lowest learning cost               | Farol identity recedes                        |
| **Operator Grid** | Dense expert tool: compact rail, sharper boundaries, cyan signal          | Fast scanning and more working area                | Higher visual and cognitive pressure          |
| **Beacon Field**  | Distinctive Farol: horizontal command shelf, deep teal field, warm beacon | Ownable identity and clear task-state relationship | Accent discipline must survive implementation |

### Provisional recommendation: Beacon Field

Beacon Field best fits the product because its horizontal command shelf gives the task-bound
Browser the full window width, makes waiting/unknown states hard to miss, and preserves a
recognizable Farol signal in both wide and compact layouts. It borrows Mac interaction conventions
rather than imitating every default Mac surface. Studio Rail remains the conventional sidebar
fallback if owner review favors familiarity; Operator Grid remains the icon-rail density reference,
not the default.

## Beacon visual grammar

| Role          | Lab token                                                 | Use                                               |
| ------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Type          | `-apple-system`, BlinkMacSystemFont, SF Pro Text fallback | All UI and document labels                        |
| Chrome        | `#0d181e`                                                 | Window bar and task strip                         |
| Command shelf | `#0b151a`                                                 | Horizontal Beacon navigation above task tabs      |
| Work surface  | `#0f1d24`                                                 | Computer, Activity, Setup, Settings               |
| Document      | `#f0eee7` / `#172428`                                     | High-contrast task-bound Browser fixture          |
| Beacon        | `#efb04b`                                                 | Selection, waiting, one primary action at a time  |
| Success       | `#62c6b3`                                                 | Running, complete, locally available              |
| Danger        | `#ef7c72`                                                 | Recorded failure only                             |
| Focus         | `#70d7c4`, 2 px outline                                   | Keyboard location independent of status color     |
| Geometry      | 8 px controls, 12 px panels, 16 px large surfaces         | Restrained grouping without card grids everywhere |

The warm accent is a beacon, not decoration. It marks current selection, attention, or the one
forward action. Success and failure use separate color plus explicit text and symbols.

## Surface inventory

### Shared shell

- Window identity and permanent `Interactive lab · synthetic data` disclosure.
- Browser, Computer, Activity, and Settings routes. Studio Rail uses a conventional sidebar,
  Operator Grid uses a compact icon rail, and Beacon Field uses a horizontal command shelf;
  labels collapse to icons in compact mode.
- Horizontally scrollable task tabs with selected task, label, and lifecycle state.
- Model/readiness disclosure, quick switcher, fixture state control, and a visibly disabled New
  task boundary.

### Browser

- Synthetic Browser toolbar and local-address disclosure.
- Selected task label, run identity, summary, progress, lifecycle panel, and network truth.
- Wide inspector holds facts and action. Compact mode moves a reduced inspector/action below the
  document while keeping it in the first viewport.
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
scrolling explicit for longer Settings content.

## Open and verify

From the `vnext` directory with the exact lockfile installed:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show
```

Open the comparison gallery instead:

```sh
./node_modules/.bin/electron design-lab/tooling/lab-main.cjs --show --gallery
```

Run the interaction, boundary, reduced-motion, wide/compact, and Retina evidence suite:

```sh
node design-lab/tests/design-lab.e2e.mjs
```

The generated result is `gallery/report.json`; it includes the visible launch display selection
and any primary-display fallback. `gallery/directions-overview@2x.png` is the single comparison
view. Each direction has separate `Browser / Running` and `Computer / Waiting` PNGs at both
`1180 x 760` and `760 x 640`, all at @2x. The recommended direction adds Activity unknown-outcome,
compact Settings, and Setup evidence.

## Production integration map

No production files are changed by this branch. A later coordinated D6 pass would:

1. map shell tokens and components into the then-current `vnext/src/ui` ownership boundary;
2. preserve the real task-bound WebContentsView instead of copying the synthetic DOM page;
3. reproduce toolbar/menu commands and shortcuts through production Electron menus;
4. test selected/unselected native view visibility, resize, focus, hit testing, drag regions,
   and overlays in both target sizes;
5. retain existing sandbox, task-correlation, network, Activity-redaction, and coexistence gates;
6. run the required review and package/E2E lifecycle before any integration claim.

The lab runner follows the existing GUI policy: non-primary internal display, then any non-primary
display, then an explicit internal-primary or primary fallback; visible launch is shown inactive.

That pass waits for explicit path ownership coordination and the owner's visual decision. The
next owner action is one question: **Should Beacon Field become the production design target, or
should the target switch to Studio Rail or Operator Grid?**

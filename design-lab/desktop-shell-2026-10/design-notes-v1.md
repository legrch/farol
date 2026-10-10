# Farol design room

Created: 2026-10-02, Europe/Lisbon. Status: proposal for owner review.

This is an independent HTML design artifact. Production source and the installed application were not modified. All task, folder, account, version and readiness data are synthetic. No live calls or system actions are available. The self-contained UI has a restrictive CSP, including `connect-src 'none'`.

## Product job and Home

Farol connects the owner's ChatGPT work to approved local computer capabilities. It lets the owner observe ongoing work, inspect recorded outcomes and manage the connection and access scope. Home should answer: Is Farol ready? What is working now? What requires attention? What is the next useful action?

Home is an overview, ChatGPT is the observation surface, Activity is recorded evidence, Setup is guided connection, and Settings is ongoing configuration. Home does not start a model request or verification on launch. Its status must eventually come from independent current facts, not one blanket green readiness flag. No token estimates, fictional productivity metrics or unrecorded performance charts.

Proposed navigation: a permanent 62 px primary rail (58 px in compact windows), with Home, ChatGPT, Activity, Setup and bottom Settings. Contextual navigation carries useful content for each selected section. Home needs no empty secondary column. ChatGPT uses stable numbered views and no duplicated top tabs. This mockup illustrates three views; five-slot admission, queueing and reuse remain separate engineering work.

## Three directions

All variants share content, fixtures, navigation and controls. Direction controls do not constitute approval.

- **A / Mac Quiet:** system font, light gray rail, light inset control groups; Home puts the readiness band above the work list. Folders uses a horizontal folder selector above its details. Comfortable onboarding and settings; greater vertical space use.
- **B / Graphite Focus:** graphite materials, restrained Iris selection, system font by default and optional Geist comparison. Home places work alongside a compact readiness column. Folders uses a vertical list and an inline inspector. Recommended starting point, subject to owner feedback. The dark shell / light ChatGPT transition requires actual native verification later.
- **C / Studio Compact:** dark primary rail, light content and slate secondary navigation, tighter form/table rhythm. More rows visible at once, smaller selection treatments. Frequent-use efficiency; denser for new users.

Palette A: background #FAFAFA, surface #FFFFFF, navigation #F0F0F3, text #29292F, secondary #676771, Iris #6750B8. Palette B: background #202124, surface #26272B, rail #191A1D, text #EDEDF0, secondary #B1B2BA, Iris #B0A2FB. Palette C: background #F7F8FA, surface #FFFFFF, rail #252B36, text #282F3D, secondary #636D7E, cobalt #355BB2.

Typography: system sans serif (-apple-system first), 28/16/14/13/12 px desktop hierarchy; smaller headings and denser rows in C. Monospace is reserved for paths and technical identifiers. Optional bundled Geist is a comparison tool, not a decision to retain it.

## Settings information architecture

| Page               | Purpose                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| General            | Launch destination, secondary menu behavior and activity detail                            |
| Folders            | Folder list, selected access mode, exclusions, independent Git permission                  |
| This Mac           | Computer name, command environment, local capabilities and their state                     |
| Connection         | ChatGPT sign-in, local connection and external verification as separate facts              |
| Model              | The existing `provider=farol`, `model=chatgpt` route, with no fabricated model entitlement |
| Keyboard shortcuts | Discoverable navigation; proposed mapping clearly identified                               |
| Updates            | Current version, check status and previous accepted version review                         |
| Diagnostics        | Available service and event evidence, with deeper technical disclosure                     |

Setup and Settings may reach the same underlying configuration, but must not own duplicate data. The prototype labels are proposed product vocabulary, not a change to module ownership or IPC contracts. Diagnostics has no new export or collection capability.

## Activity truth

The current `src/ui/activity-log.ts` projection retains task/turn/generation linkage, event kind, phase, sequence when present, Computer call identifiers, operation for a request, terminal code and timestamp. The rolling event log is bounded (256 records) and stream noise can be folded. Setup checks have a separate retained history. Prompt/answer text, file contents and full tool payloads are excluded. The detail screen uses sample records from those field families; it does not promise durable full transcripts or a new history archive. The first sample's operation is explicitly attributed to a separate request event, not a terminal event.

## Interaction boundary

Implemented locally: section and page selection, chat view selection, folder selection and sample addition, filters, unknown-outcome detail, progressive disclosure, form controls, save feedback, update-state preview, review dialogs, searchable page navigation, keyboard shortcuts, focus return after dialogs, compact secondary-menu overlay, reduced motion and non-color status words/symbols.

Proposed only: Home in the installed app, revised two-column navigation, five-slot lifecycle, native view bounds, actual OS folder picker, live permission changes, auth, checks, update readiness and restart. No production API, persistent settings, live ChatGPT session or installed runtime is used.

Compact width collapses the secondary navigation into an explicitly opened panel; it does not squeeze three columns. Escape and the close control return to the content. Home is a useful empty-state guide on first launch and an observation surface once configured. The new keyboard map requires reconciliation with existing app/menu shortcuts during engineering.

## Grounding

- Current owner request and supplied screenshots (2026-10-02).
- `/Users/ac/brain/Work/Farol/Backlog/2026-10-01-Desktop-UX-And-Managed-Chat-Slots.md`, especially the two-level sidebar and stable view selector decisions. Its phased rollout priority is historical context; this request authorizes a separate design exploration now.
- `/Users/ac/brain/Work/Farol/In-Progress/VNext/15-Watch-Rail-Integration-Handoff.md` and current `/Users/ac/code/farol/docs/design.md`: the earlier Watch Rail / Iris / Geist selection. The current request reopens presentation and information architecture; old top-tab assumptions are superseded for this proposal.
- `/Users/ac/code/farol/src/ui/shell.html`, `shell.ts` and `activity-log.ts`: current controls and retained evidence boundary, inspected on 2026-10-02 at HEAD `1eb30bd` with unrelated working-tree changes present.
- [Linear's March 2026 interface refresh](https://linear.app/now/behind-the-latest-design-refresh): receding navigation, clearer hierarchy, reduced visual noise. This informs our proposal; it is not a copied UI or an asserted Farol requirement.
- [Apple sidebar guidance](https://developer.apple.com/design/human-interface-guidelines/sidebars): platform reference for section navigation. Dimensions here are Farol proposals, not Apple mandates.

Assets: original existing Farol lamp copied from `resources/brand/farol-mark.png`; Geist copied from the repository's pinned `design-lab/fonts/geist/Geist-Variable.woff2` with its OFL license in `assets/OFL.txt`. No new icon pack, framework, font dependency, provider, hook or background agent was installed. Icons are simple inline SVG strokes authored for this prototype. Reference screenshots and private transcripts were not copied into the artifact.

## Follow-up decision

Choose composition first, then typography, density and accent. A useful owner response names an element, for example: “B shell, A settings spacing, system font, more compact secondary menu.” The next revision stays in this artifact. Production integration and native acceptance belong to the main implementation task after a concrete visual direction is approved.

## Verification

Headless Chromium inspection passed 22 named scene/interaction checks with a disposable browser context and external requests blocked. Main comparisons use 1180 x 760 at 2x; compact menu uses 760 x 640; narrower layouts use 500 x 720. Screenshots were opened for visual inspection. Navigation, filter/detail matching, local folder selection/addition, search dismissal and dialog Escape/focus return were checked. This is local DOM evidence only. Production CI and native Electron/provider acceptance were not run because this artifact changes no repository source.

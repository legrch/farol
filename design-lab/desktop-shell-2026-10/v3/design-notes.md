# Farol design room — revision 3

Updated: 2026-10-02, Europe/Lisbon. Status: interactive proposal with synthetic data. This revision incorporates the owner's toolbar, navigation, abstract-brand, update-dialog and menu-bar feedback. Iris is the selected starting accent; the mark and native integration remain proposals.

Production source, installed runtime, application icons and native browser identities were not modified. All design files live outside the repository. Revision 2 is retained in `v2/`; revision 1 remains in `v1.html`, `gallery-v1.html`, `design-notes-v1.md` and `screenshots/`.

The main review surfaces are `index.html`, `gallery.html`, `brand.html` and `menu-bar.html`. Query examples:

- `index.html?revision=3&theme=dark&page=settings&sub=appearance`
- `index.html?state=ready&update=available&dialog=update`
- `index.html?theme=dark&state=working&update=ready&dialog=update`
- `index.html?state=attention&update=ready&dialog=update`
- `index.html?state=ready&gate=draft&update=ready&dialog=update`

Controls affect the prototype only. There are no external service requests, real downloads, native menus, real restarts or changes to product preferences.

## Home and navigation

Farol connects ChatGPT work to approved local computer capabilities. Home answers four everyday questions: What is working now? Is the connection ready? Does anything require attention? What happened recently? It shows current work, a compact connection/access column, and recent Activity. It does not manufacture productivity scores or start a model/check call on launch. Readiness checks stay independent; an unknown outcome is named explicitly.

Home is the first item in the permanent rail. ChatGPT, Activity and Setup follow it. Settings uses a gear at the bottom. The decorative Dock-style logo has been removed from the rail. There is no orphan green status control. Home owns readiness and named remedies. A Home attention badge leads to Home; a known update has its own labeled download entry above Settings.

One upper bar replaces the previous title bar plus inner toolbar. Its left area contains the window-control placeholders, Back, Forward and the contextual-list toggle. A divider aligns with the contextual sidebar's right edge when expanded. The active leaf title starts to the right, above the content. Page search sits at the far right. At smaller widths, the parent breadcrumb can be hidden and search becomes an icon.

The selected event uses `Folder inventory` as its sole page title, without a repeated Activity prefix. ChatGPT uses the selected task label. Settings keeps the useful `Settings / Appearance` breadcrumb. A duplicate content heading has been removed; section headings and the meaningful Home status headline remain. The browser document title follows the same active leaf.

Back and Forward restore Farol page, selected window/event/folder, filter and content scroll position. Opening a new destination after Back discards the forward branch. Theme, accent and sidebar visibility changes do not create history entries. Empty history disables the corresponding control. Shortcuts are proposed as ⌘[ and ⌘]. This is Farol app history; it does not operate the embedded ChatGPT website's browser history. A task link must be validated again if its native task has retired or the slot has been reused.

This combined composition is consistent with Apple's macOS toolbar guidance: a toolbar can integrate with the title bar and contain title, navigation and search. Native integration must still reconcile traffic-light geometry, drag regions, no-drag controls, window resizing, menu parity and keyboard behavior. Reference: [Apple Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars?changes=_2).

## Theme, typography and settings

Light and Graphite are interchangeable themes of one composition. Appearance offers System, Light and Dark, plus Iris, Cobalt and Amber accents. Iris is the owner's selected starting direction. Theme and accent are independent. State colors retain their semantic meanings and always have words or symbols beside them.

Geist remains the proposed default; System is available for comparison. The local OFL-licensed font gives Farol one type system. It does not change the embedded ChatGPT page's typography. The prototype applies preferences immediately for the page session. Product persistence and applying the saved appearance before the first frame remain implementation work.

| Page               | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| General            | Launch and navigation behavior                       |
| Appearance         | Theme, accent and typeface                           |
| Folders            | Allowed folders, access, exclusions and verification |
| This Mac           | Computer capabilities and readiness                  |
| Connection         | Sign-in, connection and independent verification     |
| Model              | The model route used by connected tools              |
| Keyboard shortcuts | Navigation commands                                  |
| Updates            | Version, update preferences and restore              |
| Diagnostics        | Evidence for investigating a problem                 |

Updates and This Mac remain separate destinations. Model replaces Farol Model as the page label. Folder access, Git access, exclusions and verification stay in the selected folder inspector. Setup guides connection; Settings manages it afterward, using the same configuration and evidence.

## ChatGPT windows and recent work

The owner-facing section remains ChatGPT. Inside, five stable numbers identify the work windows. Each row shows its safe task label and state; an unassigned slot says Available. Worker is an implementation concept and does not need to become a navigation label.

The content area is a labeled placeholder for the actual native ChatGPT page. Farol does not recreate its messages, composer or website navigation. The contextual list replaces Farol's duplicate top-level window selector. Native WebContentsView bounds and visibility must be adjusted to the new composition while preserving existing surfaces.

Recent work below the current windows opens Activity. View chat appears only while the exact task/conversation is still inspectable. A retained event must link through task, turn and generation identity, never merely a slot number. After reuse or retirement, the event remains inspectable and explains why the chat link is absent. Meaningful task names require an explicit safe label; do not retain whole prompts to derive them.

## What current Activity can support

Source inspected on 2026-10-02 at `6f7cbf4`; the relevant Activity and updater contracts remain unchanged at current HEAD `d5ba8a7`. The intervening shell change concerns setup journey completion, not Activity retention:

- `src/ui/activity-log.ts` projects task ID, turn ID, generation, timestamp, event kind, phase, sequence where available, computer-call ID, request operation and terminal code. Prompt/answer text, file contents and full tool payloads are excluded.
- `ActivityLog` retains at most 256 records in renderer memory. It folds stream noise and counts omitted records. It is not a persistent conversation archive.
- `SetupCheckHistory` separately retains at most 64 validated setup-check records in localStorage. Its source describes retention across restarts of the Dev profile. This is not proof that all task history survives restart.
- `src/ui/shell.ts` renders the rolling log and resolves a task label from the current live registry. A retired task can therefore currently become Unknown task. A safe task-label snapshot and a bounded completed-task summary are additional implementation work.
- The live-task registry supports a capacity up to five and enforces admission. It does not by itself establish an automatic FIFO queue or general slot recycling policy. The lifecycle has same-thread surface reuse for later turns and explicit retirement. A managed pool of five reusable slots needs its own reviewed lifecycle contract.

A first useful slice can present the existing event metadata in a detail view, add a short Home activity projection, and retain a bounded safe label/summary when a task retires. It need not collect transcripts or redesign native ChatGPT. Durable history across app restarts, reopening retired conversations, automatic scheduling/slot reuse and full conversation storage are separate features. The mock illustrates the desired UX; it does not prove those features exist.

The event detail cannot claim to reconstruct every state of a task or its browser. It shows only retained events. A request operation shown beside a terminal result must be attributed to its linked request, not fabricated as a field of the terminal event. Missing data remains Not recorded.

## Updates: notice, dialog and safe restart

A background availability result produces a quiet, dismissible notice and a labeled rail entry. It does not force an update dialog over ongoing work. Clicking either opens a dialog over the current screen. Check for Updates from the application or menu-bar menu should use this same dialog without routing the owner to Preferences.

The dialog distinguishes a candidate available to download from a downloaded candidate ready to install. It shows the installed and candidate versions, expandable release notes, the automatic-update preference, Skip This Version, Remind Me Later and the appropriate primary action. The mock versions 0.1.8 and 0.1.9 are examples, not a release announcement. A synthetic download completes after a short demo timer.

The proposed reminder policy is deliberately quiet:

- Show a notice once for a newly available candidate; keep a persistent update entry while it is actionable.
- Closing the notice hides the current notice while preserving the entry.
- Remind Me Later snoozes notices for 24 hours. After that, show a notice when the application is visible and able to receive it; do not repeatedly force modal dialogs. The prototype demonstrates dismissal and the persistent entry, but contains no real 24-hour timer.
- Skip This Version suppresses reminders and the rail badge for that candidate version. The next distinct candidate is eligible again. An explicit manual check can review the candidate despite the skip.
- Automatic download and installation are opt-in in the proposal. The checkbox is off in a new demo session. Checking it changes the demo preference only; no background scheduler or download policy is connected.
- Automatic installation must respect all current restart gates and a safe restart policy. It must never terminate active work merely because the checkbox is enabled. Unchecking automatic updates restores the manual download/install workflow.

The restart action first presents a confirmation. When work is active, a browser draft exists, or an outcome is unconfirmed, it is disabled with a named reason and a relevant destination. Readiness must be checked again immediately before the real apply command. The synthetic idle example only demonstrates presentation; a real open ChatGPT window can still block installation under the current contract.

Current source at `d5ba8a7` already provides installed-update phases and commands. `src/modules/release/domain/installed-update.ts` owns unavailable, idle, recovery, checking, downloading, ready, applying and failed states. `src/ui/installed-update-view.ts` projects the existing `check`, `later`, `restart`, `recover` and `rollback` actions. The `ready` state contains candidate version, deferral and blocker information. A separate available-before-download state in this design is a proposed presentation/policy extension, not an existing source state.

Preserve these current blockers and their remedies:

| Source code                   | UI implication                                    |
| ----------------------------- | ------------------------------------------------- |
| UPDATE_CONNECTOR_ACTIVE       | Disconnect the active connector before restarting |
| UPDATE_TASK_ROUTE_NEEDS_DRAIN | Wait for the task route to finish                 |
| UPDATE_BROWSER_OPEN           | Close the open ChatGPT windows                    |
| UPDATE_BROWSER_BUSY           | Wait for response, check or voice work to finish  |
| UPDATE_BROWSER_DRAFT          | Send or clear the draft and attachments           |
| UPDATE_BROWSER_STATE_UNKNOWN  | Browser idle state cannot be confirmed            |
| UPDATE_WORK_PENDING           | Finish or cancel pending work                     |
| UPDATE_WORK_DRAIN_UNCONFIRMED | Completion cannot be confirmed                    |
| UPDATE_STATE_UNREADABLE       | Required state cannot be read safely              |

The current desktop application-menu Check for Updates handler opens Settings and then issues the check. The first implementation slice can change this presentation to a dialog and reuse the existing command/state source. Preserve the updater's verification, attestation, recovery and rollback behavior. Version skipping, saved automatic preferences, scheduled background checks and timed reminders are additional behavior requiring explicit design and tests. A failed update opens Diagnostics in the prototype; it does not automatically retry an unknown or refused operation. Real recovery actions must follow the classified source state.

## Abstract mark family

The current warm lamp remains the approved production asset until a new brand is accepted. The revised study removes the yellow core and the literal lighthouse. It compares three one-color abstract emblems:

1. Signal lens: two open arcs around one center; closest to the abstract concept the owner liked.
2. Open aperture: an interrupted ring around one center.
3. Relay: opposing curved paths around one center.

Each study shows 16, 20, 32 and 64 pixel sizes, with Accent and Monochrome treatments. The same geometry has three distinct assets: a transparent emblem, a Dock icon with its own colored tile, and a monochrome menu-bar template. A Dock tile is not reused as an interface logo. There is no mark in the main navigation; Home comes first. Accent choices on this comparison page explore brand color and do not imply that each user's interface accent should replace the installed Dock identity.

These are original hand-authored SVG studies in `mark-library.js`. No production ICNS, bundle resource or installed icon has been replaced. A final choice still needs optical adjustment and native 1x/2x template inspection at actual menu-bar sizes.

## A minimal macOS menu-bar item

`menu-bar.html` illustrates a small monochrome symbol in the system menu bar. Ready uses the plain emblem. Running modifies the center; attention uses an exclamation, disconnected uses a cross, and a ready update uses a download arrow. Tooltip and open-menu text explain the state. Color alone does not carry meaning, and the symbol does not flash.

The menu contains brief status, Open Farol, Check for Updates and Quit Farol. Running work can add one count and View running work. An attention or connection problem adds one relevant destination. It does not contain folder permissions, model configuration or a second task history. All detailed management lives in the main window.

Opening the menu moves keyboard focus to its first action. Up/Down, Home/End, Escape and outside click behave as a menu. Check for Updates opens the dialog over the destination application screen. Quit is a bounded preview and closes no real application. The main application's quit and restart policies must remain authoritative. A future General preference can control whether the menu-bar item is shown; it is not currently wired in the demo.

A native menu-bar item is technically conventional in Electron through Tray and its context menu. No existing Farol Tray implementation was established in the inspected source. This is a proposed native surface, requiring implementation and macOS verification. Reuse one command router and one state projection; do not build an independent settings controller. References: [Electron Tray](https://www.electronjs.org/docs/latest/tutorial/tray), [Apple MenuBarExtra](https://developer.apple.com/documentation/swiftui/menubarextra?changes=_8).

## Interaction and native integration contract

- Compact windows show the contextual list as an overlay. The content pane is inert while it is open. The close control, backdrop and Escape dismiss it and restore focus.
- Page search uses ⌘K. Outside click, Escape, result selection and Close dismiss it. Cancellation returns focus to the invoker. ⌘Q remains the application Quit command.
- The sidebar collapse control and page search belong to the unified upper bar. Long leaf titles truncate without pushing out the navigation controls.
- Theme/accent changes preserve focus and do not add app-history entries. Reduced-motion preferences are respected.
- Native overlays must coordinate with WebContentsView visibility and bounds. A DOM dialog cannot prove native stacking, focus, drag geometry, app menus or resizing.
- Reconcile all keyboard shortcuts with the current Electron/macOS menu before integration. This HTML does not register native commands.
- Use existing updater commands and current classified outcomes. New preferences and reminder storage must be bounded and version-specific.
- Do not expand this design task into installing a candidate, activating a runtime or replacing approved brand assets.

## Verification and remaining boundary

The main revision passed 33 named scenes and interaction checks in headless Chromium with a disposable context and external requests blocked. `inspection-v3.json` records the result. Coverage includes both themes, one active title, no rail logo, five numbered windows, app history and scroll restoration, sidebar collapse, update notice/dialog/download simulation, confirmation, active-work/unknown/draft blockers, failure and skip behavior, manual-check context, compact overlays and focus, 500 pixel layouts, configuration/setup titles, abstract variants and the menu-bar interactions.

All 26 generated scene images and the updated gallery were opened for visual inspection. A visual pass found inline SVG styles blocked by the menu study's CSP; a focused confirmation verifies the corrected monochrome drawing in both menu-bar appearances. Five focused checks also passed for SVG template ink, all accents and focus, System appearance, the System typeface, and gallery images and links. Additional evidence is recorded in `inspection-v3-focused.json`.

This evidence applies to a local DOM/SVG design prototype. Repository CI, native Electron toolbar/Tray, live ChatGPT, durable task history, update scheduling, installation, restart and owner acceptance remain separate. This design task made no repository changes. Independent in-progress edits observed in `chatgpt-update-idle.ts` and its unit test were left untouched. The next implementation should take the approved visual composition and these contracts into the main task, retaining existing task/browser/update behavior.

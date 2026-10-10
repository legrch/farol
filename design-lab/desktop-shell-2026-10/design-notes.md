# Farol design room — revision 4

Owner decision: **UI approved; Dock icon pending**. Read [DECISIONS.md](DECISIONS.md) and [HANDOFF.md](HANDOFF.md) before implementation.

Updated: 2026-10-02, Europe/Lisbon. Interactive design proposal with synthetic data. Source was inspected read-only at `2aedd93`; it may advance independently. The saved design package is a nonshipping reference under `design-lab/desktop-shell-2026-10/`; it does not change production source. No installed app, updater, provider session, native icon or runtime setting was changed.

The owner selected a single composition with Light, Graphite and System appearance, Iris as the initial user-changeable accent, a unified upper toolbar, Home first and Settings at the bottom of the icon rail. Signal Lens is the preferred abstract mark direction; no replacement Dock icon is approved. Revision 3 is retained in `v3/`, revision 2 in `v2/`, and revision 1 in `v1.html` and related files. Earlier revisions are historical proposals, not the current contract.

## Review surfaces

- `index.html?revision=4&theme=light&page=settings&sub=appearance` — matching theme composition.
- `index.html?theme=dark&page=settings&sub=general` — plain settings terminology.
- `index.html?theme=light&page=settings&sub=folders` — permissions and folder chooser.
- `index.html?theme=light&state=ready` — connection ready with a separate folder check.
- `index.html?theme=light&state=attention` — connection check and task outcome unconfirmed.
- `index.html?state=ready&update=available&dialog=update&auto=off` — manual update review.
- `index.html?theme=dark&state=working&update=ready&dialog=update&auto=on` — downloaded update, automatic policy enabled, work still running.
- `index.html?state=ready&gate=draft&update=ready&dialog=update` — unsent draft warning.
- `index.html?state=attention&gate=unknown&update=ready&dialog=update` — unconfirmed result warning.
- `index.html?state=ready&gate=integrity&update=ready&dialog=update` — package verification prevents installation.
- `index.html?state=ready&update=failed` — example download failure and acknowledgement.
- `brand.html` — three color Signal Lens Dock concepts and an interactive Dock backdrop.
- `menu-bar.html?mark=lens` — a minimal menu-bar study.
- `gallery.html` — visual review links.

Theme and page query parameters are review controls. Update preferences and acknowledgements persist only in browser storage under `farol-design-v4.update-preferences`, separate from product settings. `auto=on/off` deliberately overrides the saved automatic preference for a review link. The browser file origin and loopback origin have different storage. Other prototype preferences are session examples, not production persistence.

## One composition, two appearances

Themes change color tokens. They do not change sidebar width, content padding, card borders, corner radii, setting-row composition or font scale. Revision 4 fixes the previous four-pixel sidebar width difference and gives both themes the same Appearance card. Standard controls have the same shape and placement. System follows the Mac's color-scheme preference. Iris, Cobalt and Amber affect interface emphasis; status retains its own semantic colors.

Thin themed scrollbars use a quiet transparent track and a stable gutter so a scrolling pane does not shift content horizontally. Hover strengthens the thumb. The browser/native scrollbar may follow platform rendering; native integration must verify the actual shipped Chromium/macOS combination and system scrollbar preference.

The upper toolbar owns Back, Forward, sidebar visibility, the active page/event title and page search. Settings and Setup can include a parent breadcrumb. Activity and ChatGPT use the selected event/task as the leaf title. There is one active title, no redundant second title bar and no Dock tile in app navigation. The page list can collapse. Compact windows use a dismissible sidebar overlay and make the content pane inert while it is open.

## Settings with clear jobs

General contains Start page and Sidebar. “Sidebar” means the contextual list beside the narrow icon rail. The upper toolbar button shows/hides this list. “Show page list” starts with it visible; “Remember my choice” preserves the owner's last choice in the proposed product. Real persistence is an implementation slice; the preview demonstrates the region and toggle.

The global Activity detail control was removed from the proposal. Activity should show concise, meaningful events by default, with additional recorded identifiers available inside an event. Existing `general.activityDetail` compatibility/migration must be handled when implementing this presentation; the HTML does not edit that product field.

This Mac is one consistently named page for local service status and command access. A separate editable Computer name is omitted from the basic UI. “Run commands” is advanced and collapsed: Off or Approved folders only, with no implied network access. Folders owns file access. Connection owns sign-in, local connectivity and the end-to-end check. Their green states are independent.

Home's connection summary explicitly says Ready, Setup needed, Disconnected or Connection check needed. An available local service alone cannot produce Ready. An unconfirmed check cannot produce success. Folder access has its own count and attention label when one folder needs checking. A verified connection can still be usable with an optional unverified folder; this does not grant access to that folder or make all work results successful. In production, Ready requires current evidence from the connection projection, not a UI-derived boolean or an old successful check.

## Folder access and selection

The owner-facing labels are Read-only and Read & write. The latter is a plain-language label for the existing guarded-change mode: ChatGPT can propose changes, and approval still applies. It must not silently become unrestricted writing. Git history, old versions, hooks and user settings require their separate existing permission. Exclusions and expanded Git access are behind More access options. Changing access invalidates its prior verification.

Add folder opens a folder chooser, rather than asking the owner to type a path or invent a label. The native app already uses Electron `dialog.showOpenDialog` with `openDirectory` in `src/apps/desktop/main.ts` near line 3664. Preserve its directory validation and read-only starting mode. The chosen directory basename is the initial label.

The HTML uses `webkitdirectory` to illustrate this selection. It reads only the selected files' path metadata to obtain the root label; it does not read file contents or upload files. Absolute paths are intentionally unavailable to the browser preview. Empty-folder selection has a browser limitation because no File metadata is returned; the native `openDirectory` flow handles a real directory directly. This preview grants no access and cannot verify a folder; its Check access action explains that limitation rather than showing invented success.

## Activity names and retention: current source versus proposal

Current desktop task creation generates ordinal registry labels such as `ChatGPT task 1` in `src/apps/desktop/main.ts` near lines 3005–3010. `taskLabel` in `src/ui/shell.ts` reads this label. The friendly mock names Atlas workspace check, Design review and Folder inventory are examples, not proof of automatic naming.

Proposed deterministic naming: prefer an explicit task label supplied by the calling tool/user; otherwise map a recorded operation to a concise label such as Folder listing or File search, optionally with an already-approved folder label; otherwise fall back to Task 1. Do not generate a title from private prompt/answer contents or add a model call just to name a row. A caller label path and safe operation mapping need a separate implementation contract. Snapshot the label with a durable history item so reuse of Window 1 does not rename old work.

Current Activity projects metadata: time, task/turn/generation linkage, event kind, phase, sequence, operation and terminal code. `src/ui/activity-log.ts` has a bounded 256-record in-memory task log with stream coalescing. Setup checks have a separate validated 64-record storage history, documented for the Dev profile. The chat infrastructure ActivityLog is also bounded and in memory. This is not a durable archive of task conversations.

The inspector can show only fields actually recorded. For a terminal record, operation may come from its linked request event and should be labeled as such. Absence of a sequence/result is “Not recorded,” not an invented number or success. View chat is available only while the slot still belongs to the same task identity; reuse of a numbered window leaves event inspection available but cannot open the old conversation through that slot. Persistent recent-work history is a proposed bounded metadata feature, with retention, deletion and task-label snapshots still to be specified.

## Update policy

The automatic preference means: check according to the proposed schedule, download an eligible verified update in the background, then install during a normal confirmed app quit. It never quits the app just because the download completed. The preference is remembered, and the next update does not ask the owner to enable it again. Manual review of a downloaded update reports the current policy instead of repeating an unchecked consent control.

The proposal follows Sparkle's separation of automatic checking/downloads and quit-time installation, and its support for quiet acknowledged reminders. This is a behavior reference, not a claim that Farol already uses Sparkle. Apple recommends reserving alerts for consequential situations. Therefore routine availability uses one compact notice and a persistent update entry; potential loss of active work uses a confirmation. Idle installation already has an explicit Restart & Update action in the review sheet, so it does not add a second alert. References: [Sparkle customization](https://sparkle-project.org/documentation/customization/), [Sparkle gentle reminders](https://sparkle-project.org/documentation/gentle-reminders/), [Apple alerts](https://developer.apple.com/design/human-interface-guidelines/alerts).

| Situation                                   | Owner-facing behavior                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| New eligible version                        | One quiet corner notice and an update button. No automatic modal.                                                                                  |
| Manual updates, package not downloaded      | Click opens version comparison, notes, optional automatic switch, Skip This Version, Remind Me Later and Download Update.                          |
| Automatic updates enabled                   | Download happens in the background. The next version uses the saved preference.                                                                    |
| Package downloaded                          | Click opens details; it never immediately restarts. Restart & Update is the explicit command; with no open work, no second confirmation is needed. |
| Active work / open draft / unconfirmed work | Restart & Update opens a warning with Cancel and Interrupt & Update. Cancel receives initial focus.                                                |
| Unverified or invalid package               | Installation stays unavailable. Confirmation cannot override package verification.                                                                 |
| Ordinary download failure                   | Review once; acknowledgement clears the warning/dot, and a neutral update-status entry remains. No automatic retry is simulated.                   |
| Skip This Version                           | Suppress that candidate. The next candidate remains eligible.                                                                                      |
| Remind Me Later / dismiss                   | Acknowledge this version and leave manual access available. This does not turn off automatic installation on a later normal quit.                  |
| Update notices off                          | No corner notice; manual update status remains available. Automatic behavior is a separate preference.                                             |

Scheduled checks and reminders are not implemented in this HTML. Proposed product policy: check at an appropriate startup moment and roughly daily while online; after Later, do not nag again in the same session, and optionally show one quiet reminder after at least a day at an idle moment. Never queue multiple notices, reopen a modal on a timer, or steal focus during work. A new candidate or a materially new failure can require new attention. Failure acknowledgement in the prototype is version-based; production should key it to candidate plus failure/attempt identity and avoid hiding a new error behind an old acknowledgement.

Download and review dialogs close by their corner Close, Escape or outside click. The pre-install confirmation also cancels safely on these gestures. Clicking inside the dialog does not dismiss it. This is the selected interaction contract for an in-window sheet; Apple does not require all native update windows to close on outside click. An actual apply phase must not dismiss halfway through an irreversible operation. Native WebContentsView visibility/focus must be coordinated with the sheet.

The example failure is a failed download while the old app remains usable. A real `recoveryRequired` state must still be explained and resolved through existing Recover/Rollback behavior. Acknowledgement reduces notification intensity; it does not clear failure state or declare the app healthy. No retry, restart or recovery of unknown/refused work is authorized by a badge click.

## Explicit interruption needs a controlled shutdown path

The mock allows Interrupt & Update after a warning for active work, a draft or an unknown result. The simulation marks running sample work Interrupted and preserves Outcome unknown; neither becomes Completed. It does not close a session or install anything.

Current `InstalledUpdateCommandSchema` contains status, check, later, restart, recover and rollback. There is no explicit interruption command. Current restart admission checks work, connector and browser state. Enabling a DOM button does not implement the requested behavior.

The implementation proposal must provide a deliberate interruption protocol: freeze new admission, record the owner's decision and any affected task identity, stop/close owned sessions through supported paths, persist interrupted/unconfirmed state, perform the required local drain and package/integrity rechecks, and promote only after those safety obligations are confirmed. Do not infer provider cancellation or success from closing a window. Do not automatically resend work after restart. A package verification failure, unreadable update state or unconfirmed local drain remains a technical stop; the owner can consent to losing work, not to installing invalid bytes or bypassing transactional integrity. Reuse the existing updater's signature, attestation, promotion, recovery and rollback paths.

## Signal Lens and the Dock — rejected material studies

**Latest owner decision:** the interface is approved, but Iris Glass, Prism and Aurora Enamel are rejected as too glossy/glamorous and plastic or glass-like. Do not ship them. They remain below as historical studies. A simpler, interesting colored Signal Lens icon will be explored separately; retain the existing production icon meanwhile.

The active brand study now focuses on Signal Lens. Beacon and the literal lamp are not candidates in revision 4. Three raster material studies share two open arcs and a pearl center, with no yellow core:

1. Iris Glass — Iris and Cobalt glass over a deep indigo tile.
2. Prism — pearl glass with cyan, Cobalt and Iris reflections.
3. Aurora Enamel — Cobalt and Iris enamel over pale porcelain.

`brand.html` compares 24, 32 and 64 pixel sizes and each selection in an illustrated Dock on light/dark desktop backgrounds. The interface accent remains user-changeable while the Dock identity is stable. A transparent emblem and a monochrome menu-bar template are separate assets. The main app sidebar starts with Home and does not contain the Dock tile.

These are generated raster design studies, not ready-to-ship ICNS assets. They retain the original generated files and copied local PNGs in `assets/dock-v4/`. A final selected direction needs optical simplification/cleanup, controlled corner/inset geometry, small-size assets, proper app-icon packaging and an actual macOS Dock/menu-bar review. There is no claim that the existing production icon was replaced.

The menu-bar concept remains brief: status, Open Farol, a relevant running/attention destination when present, Check for Updates and Quit. Detailed permissions and task inspection stay in the main app. A monochrome template and shape changes communicate state; flashing and color-only status are omitted. One shared command router/state projection should serve both main UI and native menu.

## Verification

`inspection-v4.json` records 19 named checks and 22 screenshots in headless Chromium with a disposable context and external requests blocked. Coverage includes identical light/dark geometry, plain settings controls, directory chooser interaction using an explicitly created synthetic folder, readiness distinctions, dismissal/focus, persisted automatic preference across candidates, interruption/cancellation/unknown state, package integrity block, acknowledged failure, version-specific skipping, notice preference, 500px layouts, title/history/search behavior, scrollbar styling, Dock variants and the menu-bar concept. All 22 screenshots were opened for visual inspection. A compact Dock screenshot initially captured an unsettled composited layer; a focused inspection confirmed the Dock's visible bounds and drawing, and capture now waits for image decode and settled frames.

Final gallery/link and source-preservation verification is recorded separately in `inspection-v4-final.json`. This evidence is for a local DOM/raster design prototype. Native Electron menus and sheets, real ChatGPT, update scheduling/download/install/quit, durable history and installed-app owner acceptance remain separate. The subsequent owner acceptance covers the revision-4 visual UI, with the Dock icon explicitly excluded. No production code or Git changes were made by this design task. Independent native releasearchive changes appeared in the repository at the final status readback and were left untouched. No repository build, CI, package or installed-app test is claimed.

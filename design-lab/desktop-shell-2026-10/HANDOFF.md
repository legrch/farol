# Development handoff — Farol desktop shell

Read [README.md](README.md) and [DECISIONS.md](DECISIONS.md) first. The current
revision-4 UI is approved. The Dock icon is pending and must not delay shell work.
Use [design-notes.md](design-notes.md) as the detailed interaction contract and
`index.html`/`styles.css` as the visual reference. All user-facing product text
in this package is English, consistent with repository policy.

## Start the implementation with current evidence

Read the target checkout's `AGENTS.md`, accepted architecture contracts and current
source before editing. Create an isolated writer using the governing worktree
workflow. This package's source observations were read-only at `2aedd93` earlier
on 2026-10-02; they are navigation hints, not current implementation guarantees.
Source may have advanced independently. Do not transplant the prototype's fixture
state or its whole `app.js` into production.

Import this complete directory under `design-lab/desktop-shell-2026-10/` if it is
not already present in the implementation branch. Keep it nonshipping. Preserve
older `design-lab` directions as history. The October decision is the current
visual target; the September Watch Rail documents describe the earlier baseline.

## Implement in reviewable slices

1. **Shell and navigation.** Rail, contextual sidebar, one toolbar, leaf title,
   Back/Forward, page search, dismissal, compact overlay, keyboard and focus.
   Bind navigation to current product routes and retain embedded-page identity.
2. **Appearance and settings.** Shared geometry with color tokens, theme/accent/font
   choices, clear section names and grouped settings. Use native directory selection
   and preserve the current read-only, guarded-write and verification contracts.
3. **Home and current work.** Project real current task state and independently
   evidenced connection/folder readiness. Use numbered slots. Show only facts the
   product can support; a local service alone must not mean Ready.
4. **Activity.** Bind recorded metadata and reliable task identities first. Derive
   safe deterministic labels from available caller labels or operation metadata,
   with an ordinal fallback. Define separate persistence/retention work if a durable
   history is required. Do not store prompts or answers just to match a mock row.
5. **Update presentation.** Add the quiet availability state and dismissible review
   over the current view. Bind each supported action to the existing release module;
   treat missing backend capabilities as a separate contract and implementation task.
6. **Menu bar.** Reuse the same command routing and state projection as the main app.
   Start with status, Open Farol, a relevant current destination, Check for Updates
   and Quit. Keep detailed settings inside the app. Verify native template rendering.

Use the existing production brand resources throughout these slices. The rejected
Dock PNGs are design history and must not become bundled application resources.

## Important source gaps

| Surface            | Existing evidence from the earlier source inspection                                                              | Implementation obligation                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Task labels        | Ordinal labels such as `ChatGPT task 1` and a registry label projection                                           | Add a safe caller/operation naming contract if available; fixture titles are not an existing naming service                 |
| Activity           | Bounded in-memory metadata projection (256 entries); setup-check evidence has separate bounds                     | Define honest retention and persistence; do not claim a stored conversation                                                 |
| View Chat          | A current numbered slot can be reused                                                                             | Navigate only when the recorded identity still matches; otherwise show event details                                        |
| Folders            | Native `dialog.showOpenDialog` supports `openDirectory`                                                           | Preserve validation and permission defaults; the HTML `webkitdirectory` flow is illustrative only                           |
| Automatic updates  | Mock preference is browser localStorage                                                                           | Use the product's persisted update policy; no automatic interruption; normal-quit semantics need a real contract            |
| Interrupt & Update | The observed command schema had status/check/later/restart/recover/rollback, with no explicit interruption action | Implement controlled stop/drain, persistence and integrity rechecks; never bypass admission by merely enabling a DOM button |
| Readiness          | Connection and folder evidence are separate                                                                       | Bind fresh projections; failed, missing and unknown evidence do not become success                                          |
| Menu bar           | Local HTML study only                                                                                             | Native ownership, routing, template icon and focus behavior remain to be implemented                                        |

Recheck these rows against the live implementation branch. They deliberately
separate desired UX from what the mock can prove.

## Acceptance checklist

- [ ] Light/Graphite/System use the same layout and control geometry; resizing,
      long labels and scrolling do not cause clipping or horizontal jumps.
- [ ] Home is first; Settings uses a gear at the bottom; active content is identified
      once in the toolbar; Back/Forward restores the selected page/task.
- [ ] Sidebar and page-search overlays close on outside click and Escape, restore
      focus, and preserve keyboard access. Compact overlays make covered content inert.
- [ ] Native `WebContentsView` placement, visibility and focus follow shell bounds.
      Sheets/overlays cannot sit behind the embedded page. No conversation is redrawn.
- [ ] Settings labels explain their actual scope; selecting a directory uses the
      native picker; guarded changes, exclusions and separate Git access stay intact.
- [ ] Home's Ready requires current evidence; connection readiness, folder access,
      running work, unknown outcome and update health remain separate.
- [ ] Activity labels have a deterministic data source; slot reuse cannot relabel
      history or open another task under View Chat. Unknown outcomes remain unknown.
- [ ] Routine update availability has one quiet notice and persistent manual access.
      Clicking the update entry always reviews. Close/Escape/backdrop safely dismiss
      review; an irreversible apply phase is not dismissible halfway through.
- [ ] Automatic preference survives to the next version, downloads quietly and never
      interrupts current work automatically. Idle Restart & Update needs no redundant
      second alert. Active work/draft/unknown state warns with Cancel initially focused
      and an explicit Interrupt & Update option where the backend supports safe shutdown.
- [ ] Acknowledgement reduces the same failure's notification intensity without
      hiding a new failure or clearing underlying error state. Integrity failures remain
      hard blocks. Recovery/Rollback use their existing verified paths.
- [ ] Native window drag regions, inactive-window appearance, system theme changes,
      keyboard navigation, reduced motion and platform scrollbar settings are verified
      against built bytes using non-interfering disposable state.
- [ ] Current Dock studies stay excluded from shipped resources. A new icon requires
      a separate owner selection and native small-size/Dock review.
- [ ] Source tests, repository CI, built/native checks and installed owner acceptance
      are reported separately. No provider retry, release, installation or activation
      is inferred from this design handoff.

## Suggested kickoff message

> Implement the owner-approved Farol desktop shell from this package. Start with
> README.md, DECISIONS.md and HANDOFF.md, then read the detailed interaction contract.
> Use the current revision-4 prototype and gallery as visual references. Preserve
> native embedded ChatGPT pages and existing permission/update integrity contracts.
> Dock icon redesign is a separate task: do not ship the rejected studies. Begin
> with shell/navigation and appearance; verify each slice against current source.

# Farol design room — revision 2

Updated: 2026-10-02, Europe/Lisbon. Status: interactive proposal for owner review, with synthetic data.

Production source, installed runtime, application icons and native browser identities were not modified. The artifact uses local files and a restrictive CSP with `connect-src 'none'`. UI controls change the prototype only. The first exploration remains in `v1.html`, `gallery-v1.html`, `design-notes-v1.md` and `screenshots/`.

## Product purpose and Home

Farol connects the owner's ChatGPT work to approved local computer capabilities. Its everyday starting point should answer: What is working now? Is the connection ready? Does anything require attention? What happened recently?

Home shows Current work beside a compact readiness column, with a short Recent activity list below the work. It does not manufacture productivity scores or start model/check calls on launch. Readiness uses independent checks, with explicit words for an unknown result. Quiet, working, attention, disconnected and first-launch examples are available in the design board.

The primary rail contains Home, ChatGPT, Activity and Setup. Settings uses a gear at the bottom. There is no orphan green status control. Home owns readiness and its remedies. An attention badge beside Home routes to Home; every detailed status action there has a named destination. The brand mark at the top is decorative identity, not a status lamp or an unlabeled button.

## One composition, two themes

Light and Graphite are themes of the same layout, with the same content hierarchy and contextual navigation. Studio Compact is retained only in the first exploration. Settings → Appearance contains System, Light and Dark; System follows the operating system's appearance. In the prototype, changes apply immediately for this page session; persistent product settings remain an implementation task.

Accent choices are independent of theme: Iris, Cobalt and Amber. Iris is the restrained incumbent direction. Cobalt offers a clearer instrument-like character and a cool contrast to the warm brand core. Amber unifies mark and selection but must be distinguished carefully from attention states. Semantic state colors are not derived from the selected accent, and states always have text labels.

Geist is the proposed default, using the repository's local OFL-licensed font. System remains a comparison option. Geist provides a consistent Farol type system across Home, Settings and operational surfaces; System gives a more native platform voice. Neither changes the typography of the embedded ChatGPT page.

The window title tracks the selected screen and, in ChatGPT, the selected numbered window and task label. Product integration should use the application shell's active page/title source rather than a constant application name or an unrelated file name. Native title/menu/window behavior needs reconciliation during integration.

## ChatGPT windows and recent work

Keep **ChatGPT** as the owner-facing section name. Inside, show five stable numbers, the current task's safe label, and its state. Use Window in explanatory copy. Worker is an implementation concept; Task refers to the assigned work, not the reusable window. Empty slots say Available. Completed work can remain inspectable until its page is retired or replaced.

The content surface is a labeled placeholder for the **actual native ChatGPT page**. No message list, composer or ChatGPT navigation is reimplemented. The proposed rail replaces Farol's duplicate top-level window selector. The ChatGPT page may retain its own native website navigation.

Recent work below the five windows routes to Activity. A retained event must link to a task identity, not merely to window number 1–5. View chat appears only while that exact task/conversation remains inspectable. When a window has been reused, the old event remains visible but the link is absent, with a plain explanation. The Window reused fixture demonstrates old Atlas metadata while window 1 contains Release notes review. The main implementation should preserve task/turn/generation identity and validate the live target before navigation; a slot number is never sufficient.

Meaningful task names must come from an explicit safe task-label input. The currently inspected native source still creates ordinal labels such as ChatGPT task N. Do not silently derive labels by retaining whole private prompts.

## Settings structure

| Page               | Owner question                                                    |
| ------------------ | ----------------------------------------------------------------- |
| General            | What opens at launch, and how does navigation behave?             |
| Appearance         | Which theme, accent and typeface do I use?                        |
| Folders            | Which folders are allowed, with what access and exclusions?       |
| This Mac           | What can this computer do, and which capabilities are ready?      |
| Connection         | Is ChatGPT signed in, connected and independently verified?       |
| Model              | Which model route do connected tools use?                         |
| Keyboard shortcuts | How do I navigate quickly?                                        |
| Updates            | Which version is installed, and what update/restore is available? |
| Diagnostics        | What evidence can help investigate a problem?                     |

Updates and This Mac are separate destinations. Model replaces Farol Model as the page label. Folder access, Git access, exclusions and verification stay in the selected folder's inspector rather than repeating full warning/control blocks in a long Preferences page. Setup guides connection; Settings manages it afterward. Both must use one underlying configuration and evidence source.

## What current Activity can support

Source rechecked on 2026-10-02 at HEAD `6f7cbf4`:

- `src/ui/activity-log.ts` projects task ID, turn ID, generation, timestamp, event kind, phase, sequence where available, computer-call ID, request operation and terminal code. Prompt/answer text, file contents and full tool payloads are excluded.
- `ActivityLog` retains at most 256 records in renderer memory. It folds stream noise and counts omitted records. It is not a persistent conversation archive.
- `SetupCheckHistory` separately retains at most 64 validated setup-check records in localStorage. Its source describes retention across restarts of the Dev profile. This is not proof that all task history survives restart.
- `src/ui/shell.ts` renders the rolling log and resolves a task label from the current live registry. A retired task can therefore currently become Unknown task. A safe task-label snapshot and a bounded completed-task summary are additional implementation work.
- The live-task registry supports a capacity up to five and enforces admission. It does not by itself establish an automatic FIFO queue or general slot recycling policy. The lifecycle has same-thread surface reuse for later turns and explicit retirement. A managed pool of five reusable slots needs its own reviewed lifecycle contract.

A first useful slice can present the existing event metadata in a detail view, add a short Home activity projection, and retain a bounded safe label/summary when a task retires. It need not collect transcripts or redesign native ChatGPT. Durable history across app restarts, reopening retired conversations, automatic scheduling/slot reuse and full conversation storage are separate features. The mock illustrates the desired UX; it does not prove those features exist.

The event detail cannot claim to reconstruct every state of a task or its browser. It shows only retained events. A request operation shown beside a terminal result must be attributed to its linked request, not fabricated as a field of the terminal event. Missing data remains Not recorded.

## Brand exploration

`brand.html` compares three concepts under all three accents:

1. Original lamp: copied unchanged from the current approved brand asset. Its existing production monochrome master remains authoritative if selected.
2. Signal lens: a warm core and open side arcs, using the interface accent in the larger color mark. Includes a simple monochrome template study.
3. Beacon: a more literal lighthouse silhouette with a warm light. Includes a monochrome template study.

The new concepts are hand-authored SVG studies. App tile, small interface mark and monochrome menu-bar symbol are shown separately at useful sizes. Brand color is identity; it does not mean running/ready/error. Warm amber branding can coexist with a cool selection accent. No brand choice in the design board approves replacement of production ICNS, bundle resources or menu-bar assets.

Assets: `assets/farol-mark.png` from `resources/brand/farol-mark.png`; `assets/Geist-Variable.woff2` from the pinned design-lab font, with `assets/OFL.txt`. No icon/font/framework package, provider, hook or background agent was installed.

## Interaction contract for implementation

- The permanent rail and contextual list replace duplicate Farol tab selectors. Home does not reserve an empty secondary column.
- Compact windows collapse the contextual list into an explicit overlay. The work pane is inert while it is open. Close, backdrop and Escape dismiss it; focus returns to the menu control.
- Page search uses ⌘K. Outside click, Escape, a result selection and Close dismiss the search. Focus returns to the invoker on cancellation. ⌘Q remains normal macOS Quit; it is not repurposed.
- Theme/accent changes keep keyboard focus on the selected control. All selected and attention states have visible labels, with reduced-motion support.
- View chat targets exact live task identity. The UI explains absent links after retirement/reuse.
- Any native implementation must retain existing browser surfaces and coordinate their visibility and bounds with overlays. DOM mockup evidence cannot prove native WebContentsView stacking, focus or resize behavior.
- Prototype shortcuts are a proposal; reconcile them with existing Electron/macOS menus before integration. Do not infer native shortcut registration from the HTML demo.

## Verification and next boundary

The revision passed 35 named scene/interaction checks in headless Chromium with a disposable context and external requests blocked. It covers six theme/accent combinations, both Appearance pages, System following, five numbered windows, active title, exact task links, retired task/reused window behavior, Home attention routing, first launch, compact menu inertness/Escape, search outside dismissal/focus return and selection, all configuration/setup destinations, and 500 px narrow layouts. Evidence is recorded in `inspection-v2.json` and `screenshots-v2/`.

Focused confirmation passes also verified theme/typeface focus behavior, the quiet Activity filter, search Escape, the comparison gallery, matching titles on empty Activity screens and distinct explanations for available windows. Every generated screenshot was opened for visual inspection; the comparison gallery was also reviewed. This is local DOM/SVG evidence only. No repository CI, native Electron, live ChatGPT, scheduler, durable-history or installed-app acceptance is claimed.

Next owner decision: choose the accent and mark direction, then refine content/density in this same artifact. Approved design and these contracts can be handed to the main implementation task. Production integration is outside this separate design request.

# Farol Next preview design

## Product intent

The preview is a focused desktop bridge for one owner supervising a small number of
task-bound conversations. Its primary surface is Browser, not a project dashboard.
Computer explains the exact capability waiting for consent, Activity shows a quiet
sanitized evidence trail, and Settings reports isolation and unavailable live
integrations without pretending they are configured.

The first launch opens a required five-step Setup journey for ChatGPT, Computer,
Connect, Hosts, and Verify. Visiting a step changes no readiness claim. Owner actions
open the isolated ChatGPT sign-in surface, persist Computer approval, attest a selected
Codex host, and run bounded host/Agent checks without reading or storing credentials.
Unavailable connector work remains explicit. Settings can reopen the same journey so
the boundary and current evidence remain inspectable after dismissal.

## Owner-selected visual direction: Watch Rail

The five reversible design-lab directions and their 49 reference screenshots remain
unchanged under `design-lab/`. The owner selected Watch Rail with the Iris accent and
Geist typeface. Production uses the same graphite hierarchy:

- a 216 px full-height sidebar that collapses to a 72 px watching rail;
- automatic rail mode below 980 px, with the full sidebar available as an overlay;
- task tabs above a 72 px dossier row, followed by the task-bound Browser page;
- shape-and-text lifecycle lamps for running, Computer wait, complete, failed,
  outcome unknown, and unavailable states;
- Iris only for selection, keyboard focus, and the next action. Iris never encodes a
  lifecycle state.

Geist 1.7.2 and Geist Mono are shipped from the design-lab's pinned SIL OFL sources.
Their SHA-256 values stay in `design-lab/fonts/PROVENANCE.md`, the OFL text is a
digest-bound packaged resource, and the packaged third-party notice names the version,
license, and hashes. Coverage outside the verified Latin set falls back to SF Pro or
the system sans-serif; no broader script coverage is claimed.

### Native Browser overlay decision

The task page is a native `WebContentsView`, which is composited above renderer HTML.
Farol therefore hides the selected native page while a shell-owned overlay is open:
compact sidebar, task menu, quick switcher, or Setup. The page is shown again only
after the overlay closes and focus is explicitly returned. This keeps the Browser
viewport full width in ordinary use, avoids an additional transparent native view,
and makes click/Escape routing deterministic. Main derives all bounds from closed
layout enums; renderer-supplied pixels are never trusted.

## Interaction contract

- `Command+1…4` selects Browser, Computer, Activity, or Settings.
- `Control+Command+S`, the View menu item, and the button beside the macOS traffic
  lights show or hide the sidebar. At compact widths the same control opens the full
  sidebar over the rail.
- `Command+K` opens the quick switcher from either shell HTML or the native task page.
- `Control+Tab` and `Control+Shift+Tab` move between task tabs without cancelling the
  hidden task. Keyboard focus moves to the newly visible task surface.
- Visible controls have a two-pixel Iris focus ring and an appropriate Mac target.
- Switching views does not recreate WebContentsView instances. The selected browser
  view alone is visible; hidden views keep running with background throttling off.
- Reduced-motion preference removes transforms and transition duration.
- Status changes update text and color together; color is never the only signal.
- Test-only window presentation is closed and explicit: hidden for ordinary fault and
  recovery evidence, or inactive on a non-primary display for the one visual/focus
  run. Normal owner launches retain the product's ordinary foreground behavior.
- Demo Computer approval names its synthetic operation and target. Ordinary Computer
  controls name the selected workspace and operation, show read evidence only on
  demand, and require an explicit access change plus review before a guarded edit.
- The terminal demo action is labelled `Finish demo response`; it cannot be mistaken
  for publishing, installing, or completing a product release.
- Activity is an allowlisted projection: task label, phase, event kind, synthetic
  capability name, monotonic sequence, and timestamps only. Prompt text, answer
  text, tool arguments/results, bearer values, paths, cookies, and provider payloads
  never enter it.

## Review checklist

The direction was checked against the programme before UI code: Browser remains the
home surface; tabs and status are calm; the active beacon is specific to Farol; the
layout avoids generic dashboard patterns; compact behavior, focus, reduced motion,
failure/offline states, and honest unavailable capabilities are part of acceptance.
The owner choice is recorded by the design-lab report. Production acceptance still
requires built-app interaction, focus, inactive-window, fullscreen, compact overlay,
and visual evidence rather than inheriting proof from synthetic lab screenshots.

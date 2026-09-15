# Farol Next preview design

## Product intent

The preview is a focused desktop bridge for one owner supervising a small number of
task-bound conversations. Its primary surface is Browser, not a project dashboard.
Computer explains the exact capability waiting for consent, Activity shows a quiet
sanitized evidence trail, and Settings reports isolation and unavailable live
integrations without pretending they are configured.

The first launch opens a required five-step Setup journey for ChatGPT, Computer,
Connect, Hosts, and Verify. It records no credentials and makes no live connection;
each step states the exact preview boundary. Settings can reopen the same journey so
the boundary remains inspectable after dismissal.

## Visual direction: Atlantic lighthouse

- Atlantic Midnight `#0d1821` and Harbor Slate `#172733` form the calm shell.
- Fog `#dde8e6` is the high-contrast text/surface neutral.
- Sea Glass `#54b5a5` marks healthy streaming and focus.
- Beacon Amber `#e9b45d` marks an active task or owner decision.
- Fault Coral `#e37369` is reserved for terminal failures.
- Avenir Next is the UI face on macOS; system sans-serif is the portable fallback.
  SF Mono is used only for technical identities.

The one emphatic element is a narrow beacon beside the active task. The rest stays
flat and restrained: no decorative gradients, generic card grid, all-caps eyebrow
labels, or neon-on-black developer dashboard. Wide mode uses a 176 px navigation
rail; compact mode reduces it to 64 px while retaining labels for assistive
technology. Content geometry is stable across running, tool-wait, complete, failure,
and offline states.

## Interaction contract

- `Command+1…4` selects Browser, Computer, Activity, or Settings.
- `Control+Tab` and `Control+Shift+Tab` move between task tabs without cancelling the
  hidden task. Keyboard focus moves to the newly visible task surface.
- Visible controls have a two-pixel Sea Glass focus ring and a minimum 40 px target.
- Switching views does not recreate WebContentsView instances. The selected browser
  view alone is visible; hidden views keep running with background throttling off.
- Reduced-motion preference removes transforms and transition duration.
- Status changes update text and color together; color is never the only signal.
- Test-only window presentation is closed and explicit: hidden for ordinary fault and
  recovery evidence, or inactive on a non-primary display for the one visual/focus
  run. Normal owner launches retain the product's ordinary foreground behavior.
- The Computer action names the synthetic operation and target before approval.
  Unsupported native access is explicitly disabled.
- The terminal demo action is labelled `Finish demo response`; it cannot be mistaken
  for publishing, installing, or completing a product release.
- Activity is an allowlisted projection: task label, phase, event kind, synthetic
  capability name, monotonic sequence, and timestamps only. Prompt text, answer
  text, tool arguments/results, bearer values, paths, cookies, and provider payloads
  never enter it.

## Review checklist before implementation

The direction was checked against the programme before UI code: Browser remains the
home surface; tabs and status are calm; the active beacon is specific to Farol; the
layout avoids generic dashboard patterns; compact behavior, focus, reduced motion,
failure/offline states, and honest unavailable capabilities are part of acceptance.
Owner visual sign-off is not implied by this internal review.

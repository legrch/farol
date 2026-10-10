# Owner acceptance — 2026-10-02

Status: **APPROVED_UI / DOCK_ICON_PENDING**.

The latest owner decision approves the current revision-4 interface and asks for
a durable development handoff. The Dock icon remains a separate design task.
Earlier comparison pages are preserved for history and do not override this file.

## Approved implementation target

- One composition across Light, Graphite and System; theme changes color tokens,
  not spacing, layout, control geometry or hierarchy.
- Home first in the icon rail, Settings gear at the bottom, a collapsible
  contextual sidebar and a single toolbar with Back/Forward and the selected
  page or task title. Do not duplicate the active title in another bar.
- Iris as the initial accent; the user can choose Cobalt or Amber. Geist and the
  system font remain supported choices. Thin themed scrolling with stable space.
- Home conveys current work, connection readiness, folder access and recent
  recorded activity. Independent checks stay independent.
- Five numbered current ChatGPT slots, with a current task label when available.
  Existing ChatGPT pages stay embedded; Farol does not create their messages or
  composer. History opens recorded event details and uses View Chat only while
  the same task/conversation identity remains available.
- Separate settings pages for General, Appearance, Folders, This Mac, Connection,
  Model, Shortcuts, Updates and Diagnostics. Plain labels, short explanations,
  progressive disclosure for technical options and native folder selection.
- Quiet update availability, a dismissible review sheet and a persisted automatic
  preference. An update click opens details. Explicit interruption remains
  possible after a warning; unknown work never becomes completed. Invalid update
  bytes remain blocked regardless of the user's willingness to lose active work.
- Minimal menu-bar status and quick access to the main app. Most controls remain
  in the app. Final native template rendering requires implementation verification.

## Not approved

- Iris Glass, Prism and Aurora Enamel Dock images: rejected as too glamorous,
  glossy, plastic or glass-like. These retained raster files are historical only.
- Beacon: abandoned direction; do not revive it as the replacement identity.
- An installed icon replacement, native updater/backend changes, a new provider
  call, broader file permissions or transcription storage are not authorized by
  visual acceptance of this prototype.

## Next icon brief

Signal Lens remains a preferred abstract direction, not a final icon master.
Explore a simpler and more believable colored Dock icon in a separate session.
Avoid the current glass/plastic material. Keep the existing production icon until
one new candidate is selected and verified at native sizes. Interface work can
proceed independently of that choice.

## Evidence boundary

The mock demonstrates the desired interaction. Native implementation, source
checks, built Electron verification and owner acceptance on the installed app
are distinct steps. The saved screenshots and fixture titles do not prove that
production already provides durable history, semantic naming, update scheduling,
forced interruption or any real ChatGPT result.

# Desktop design

**State:** the published TypeScript/Electron desktop uses the Watch Rail direction.
The React migration is an [accepted target](migration.md#accepted-migration-target).
Design-lab images and fixtures do not certify the installed app's interactions.

## Product intent

Browser is the primary conversation surface. Computer explains the local capability
and approval it needs. Activity is a quiet content-free lifecycle trail. Settings
shows the separate connection and host readiness checks, including unavailable states.

First-run Setup lives in the sidebar for both product and Dev. Embedded sign-in and
folder sharing are optional; each actual capability has its own admission. The old
qualification modal and dossier are retained only for explicit demo/legacy fixtures.
[Getting started](../start/first-connection.md) owns the ordinary setup instructions.

## Watch Rail

The current shell uses a graphite hierarchy, Iris accents, and packaged Geist:

- A 216 px sidebar collapses to a 72 px watching rail.
- Below 980 px, the full sidebar opens as an overlay.
- A 52 px toolbar holds compact conversation tabs; a 25 px bottom strip holds status.
- Lifecycle signals use shape and text as well as color.
- Iris marks selection, keyboard focus, and the next action. It does not encode a
  lifecycle result.

Geist/Geist Mono 1.7.2 resources, hashes, and SIL OFL text are retained in
[font provenance](../../design-lab/fonts/PROVENANCE.md). Coverage outside the verified
Latin set falls back to system fonts; broader script coverage is not claimed.

Current implementation: [shell CSS](../../src/ui/shell.css),
[shell renderer](../../src/ui/shell.ts), and
[main-owned surface layout](../../src/apps/desktop/surface-layout.ts).

## Native Browser overlays

A Browser task uses native `WebContentsView`, composited above renderer HTML.
Main hides that selected view while Setup or a shell overlay is open: compact
sidebar, task menu, or quick switcher. It restores the page after the overlay closes
and explicitly returns focus.

This preserves the full normal Browser viewport while keeping clicks, Escape, and
keyboard controls reachable. Main derives bounds from closed layout states; the
renderer cannot supply arbitrary native-view pixels. No extra transparent native
view or weaker navigation/preload/permission boundary is introduced.

## Interaction contract

[Getting started](../reference/shortcuts.md) lists shortcuts. Both shell
and native page support quick switching. Switching tabs hides the inactive page
without recreating its view or cancelling its task; hidden views keep running with
background throttling disabled.

Visible controls have Iris focus indicators. Reduced-motion preference removes
transforms and transition duration. Status changes include readable text, and
failure, unavailable, and unknown states retain distinct meanings.

Activity is an allowlisted projection of labels, phases, event kinds, sequences,
and timestamps. Prompts, answers, tool payloads, paths, cookies, and bearer values
do not enter it. Support export has its own similarly bounded projection.

## Verification

Visual direction, font provenance, and pure geometry can be checked without native
focus. Built-app acceptance separately covers compact overlays, fullscreen,
inactive windows, focus transfer, and actual native views.

[Test policy](../development/testing.md) requires hidden runs where equivalent and explicit display
and focus authority for native-visible cases. Each test-owned window follows that
policy. A synthetic lab screenshot cannot replace those checks.

---

[Architecture](README.md) · [Documentation](../README.md)

# Farol Next GUI test policy

## Evidence hierarchy

Electron tests should not interrupt the owner's desktop merely because they exercise
a renderer. Use the least visible route that preserves the evidence:

1. Pure policy and geometry run under Vitest with no Electron process.
2. DOM, screenshot, provider-failure, stream-failure, and runtime-death scenarios run
   in a `BrowserWindow` created with `show: false` and never shown.
3. One interaction run may be visible because it proves the native
   `WebContentsView` surface and focus transfer. It is positioned before first show
   and displayed with `showInactive()`. The window is activated only for the final
   native focus-transfer assertion, then closed immediately.

The visible selector is deterministic: non-primary internal, any non-primary,
internal, then primary. The chosen 1180x760 bounds are clamped and centered inside
the display work area. A primary-display result is a recorded fallback, not an
implicit default. The packaged and development reports include the actual display
class, display count, work area, bounds, and initial focus observation.

Ordinary `npm --prefix vnext run preview` launches do not carry a test window mode and
retain foreground product behavior. The two accepted test-only arguments are
`--preview-window-mode=hidden` and
`--preview-window-mode=secondary-visible`; unknown or repeated values fail closed.

## Why hidden evidence is still valid

Electron documents that a `BrowserWindow` created with `show: false` paints by
default while initially hidden. Playwright's Electron API can inspect the main
process and capture a renderer screenshot without requiring OS-level visibility.
The E2E lane therefore checks every hidden window remains hidden through teardown and
also validates every recorded PNG is non-empty. It does not replace native focus
proof, packaged-byte verification, or real `WebContentsView` assertions with a DOM
mock.

Primary references:

- <https://www.electronjs.org/docs/latest/api/browser-window>
- <https://www.electronjs.org/docs/latest/api/screen>
- <https://www.electronjs.org/docs/latest/api/structures/display>
- <https://playwright.dev/docs/api/class-electron>

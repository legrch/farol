# Sunrise Dock delivery pair

Asset filenames in this record refer to [resources/brand/sunrise-dock/](../../../resources/brand/sunrise-dock/). The original asset and license files remain there; this move changes only the documentation location.

Exact native Dock assets copied from the designer handoff
`/Users/ac/code/farol-design/sunrise-dock-2026-10-06/`.

- `farol-sunrise.png`: standard runtime Dock icon.
- `farol-sunrise-dev.png`: Dev runtime Dock icon with the in-artwork DEV badge.
- `farol-sunrise.icns`: standard packaged `Farol.app` bundle icon.
- `farol-sunrise-dev.icns`: retained exact Dev bundle source for any future real Dev `.app` packaging path; raw `task dev` uses the runtime PNG instead of mutating Electron's vendor bundle.

Do not replace these with the older opaque palette study. `tooling/brand-contract.mjs`
pins exact source bytes; `src/apps/desktop/main.ts` selects the Dev PNG only for the
existing `environment === "dev"` identity.

# Profiles and isolation

Use the exact environment identity when comparing builds, configuration, browser
state, and connection evidence. Visible names and machine identities have different
compatibility roles.

## Product and Dev identities

| Identity                    | Farol                        | Farol Dev                   |
| --------------------------- | ---------------------------- | --------------------------- |
| Visible app name            | `Farol`                      | `Farol Dev`                 |
| App ID                      | `local.farol.next.preview`   | `local.farol.dev`           |
| Ordinary app-data directory | `Farol Next Preview`         | `Farol Dev`                 |
| Runtime partition           | `persist:farol-next-preview` | `persist:farol-dev-runtime` |
| ChatGPT partition           | `persist:farol-next-chatgpt` | `persist:farol-dev-chatgpt` |
| Runtime service             | `Farol Next Runtime`         | `Farol Dev Runtime`         |

These machine identities come from
[desktop-environment.ts](../../src/apps/desktop/desktop-environment.ts). The visible
Farol brand does not rename compatibility state/receipt roots. Dev and product keep
separate connector, configuration, browser, and instance state. Neither copies
cookies, keys, personal Codex configuration, or the older product's state.

Acceptance Dev profiles use an additional `Farol Dev Acceptance` parent. A retained
legacy `Farol DEV` directory can be reused only by the metadata-based resolver.
Two distinct profiles fail with `DEV_PROFILE_DIRECTORY_AMBIGUOUS`; they are never
merged. A same-inode case alias does not cause a profile move.

A ChatGPT app's exact saved display name remains independent of build environment.
A renamed app needs explicit reselection for the same tunnel/generation. Creating a
duplicate tunnel or copying credentials is not a display-name migration.

## Quit and state retention

Closing the last window leaves the app and its utility runtime running. The Dock or
same-build second launch reopens one window. `Command+Q` requests bounded normal
shutdown; an unresolved operation or unconfirmed child is recorded as such.

Product configuration, task/conversation correlation, and effect receipts have their
own durable stores. Demo state is not promised across Quit. A retained conversation
or summary does not prove provider completion or renew Computer authority.

---

[Reference](README.md) · [Documentation](../README.md)

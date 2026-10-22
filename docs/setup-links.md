# Setup links

Follow the [Farol connection guide](setup-connection.md) for the current
Sign in / Workspaces / Connect this Mac / Add to ChatGPT flow. The guided
flow requires its sign-in check; external Computer verification is independent. Navigation alone does not change
access or repeat an operation.

The setup instructions retain these owner-facing external links. A source split
does not change account, workspace, key, or connector permissions.

- [Organization tunnels](https://platform.openai.com/settings/organization/tunnels)
- [ChatGPT connectors](https://chatgpt.com/plugins)

The reusable external-setup illustrations and their text live in
`resources/setup-media.json` and `src/ui/setup-media.ts`. Their contract tests
require exact agreement and permit only the documented URLs above. They do not
define the five-section React wizard. No cookies or credentials are bundled.

## Internal navigation surfaces

`apps/desktop/renderer/navigation-destinations.ts` owns the closed renderer
navigation sets. The controller rejects an invalid destination without changing
the current page; retired destinations are never rewritten to General. Setup
uses `setupStep`, independently of the Settings `page` field.

| Set        | Before the unresolved-actions fix                                                                 | Current rendered destinations                               |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Main areas | Home, ChatGPT, Activity, Setup, Settings                                                          | Unchanged                                                   |
| Settings   | `general`, `appearance`, `folders`, `computer`, `connection`, `model`, `shortcuts`, `diagnostics` | `general`, `appearance`, `shortcuts`                        |
| Setup      | `overview`, `signin`, `folders`, `connection`, `attachment`, `finish`                             | `overview`, `signin`, `folders`, `connection`, `attachment` |
| Home views | `overview`, `work`, `attention`, `activity`, `access`                                             | Unchanged                                                   |
| Sheets     | `search`, `task`, `update`, `update-recovery`, `activity`                                         | Same set plus `unresolved-actions`, `chat-conversations`    |

Connect this Mac and Workspaces are Setup step labels, not Settings destinations. Start page
was already absent from the Settings navigation and destination type at this
fix's baseline. The removed Model page has no remaining navigation caller.

| Former caller                                                          | Current surface                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shell “Review unresolved actions”                                      | Unresolved actions sheet                                                                                        |
| ChatGPT placeholder for an unknown or pending open                     | Unresolved actions sheet                                                                                        |
| Update sheet action-details link                                       | Unresolved actions sheet, only while unresolved actions exist                                                   |
| Home attention action/workspace-edit row                               | Unresolved actions sheet                                                                                        |
| Home action inspector “Inspect action details”                         | Unresolved actions sheet                                                                                        |
| Chat options “Inspect action details”                                  | Unresolved actions sheet, only for pending or unknown actions                                                   |
| Home connection footer and failed ChatGPT placeholder                  | Setup → Connect this Mac                                                                                        |
| Home access “Manage connection”                                        | Setup → Connect this Mac                                                                                        |
| Home readiness connection row                                          | Setup → Connect this Mac, or Add to ChatGPT when a local connection is current but external access is unchecked |
| Home workspace readiness, issue row, inspector and “Manage workspaces” | Setup → Workspaces, preserving a selected workspace                                                             |
| This Mac startup preference and native section shortcut                | Setup → Workspaces                                                                                              |
| Native Settings/sign-in return action                                  | Setup → Connect this Mac                                                                                        |
| General “Open Setup”, Home “Open Setup”, shell Setup rail              | Setup → Overview (or the current Setup step when already in Setup)                                              |

The on-demand sheet lists current pending/unknown receipts, saved setup or
connection outcomes, and workspace edits awaiting observation or result delivery. Saved update recovery
and unknown update preferences are also inspectable, with a link to the existing
recovery sheet.
It reuses the existing Settings refresh/readback flow and workspace-edit
observation and delivery controls. Refreshing never proves an unknown operation
did not run. No general operation query or automatic retry is added. Support
export uses the existing native export command; its own pending/unknown result
still prevents another export. The sheet can be dismissed while work remains
pending and restores focus to its connected trigger.

`tests/renderer/navigation-surfaces.test.tsx` enumerates every closed destination
and clicks the formerly linked controls against their actual rendered surfaces.
These are scripted DOM and controller contracts, not native UI, filesystem,
provider, packaging or installed-app evidence.

## Chat capabilities and deleted-component inventory

Open **ChatGPT → Chat conversations** in the sidebar for account-confirmed
conversation start, workspace-backed read-only conversations, saved answers and
stored reply copies. This sheet uses the existing overlay presentation to keep
its controls above the native ChatGPT browser. Settings remains General,
Appearance and Keyboard shortcuts. Opening or closing the sheet does not inspect
an account, prepare a file, read saved content or send a message. An active
conversation retains its controller-owned state across sheet remounts; unknown
outcomes remain fenced against resubmission.

The inventory below covers every deleted component file reported by
`git diff --diff-filter=D --name-only 6ca65fec 642d4543 -- src/ui/renderer apps/desktop/renderer`.
All four components and their original component tests are restored from
`6ca65fec`; the same inventory against the corrected HEAD is empty.

| Deleted component at `642d4543`                          | Disposition                                                                       | Current surface                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/ui/renderer/chat-direct.tsx` (`ChatDirect`)         | Restored, including account confirmation and unknown-send fences                  | ChatGPT → Chat conversations: new conversation                     |
| `src/ui/renderer/chat-readonly.tsx` (`ChatReadonly`)     | Restored, including verified read-only workspace scope and exact-operation fences | ChatGPT → Chat conversations: file preview and active conversation |
| `src/ui/renderer/chat-history.tsx` (`ChatHistory`)       | Restored, including explicit local reads and context/epoch checks                 | ChatGPT → Chat conversations: Saved Chat answers                   |
| `src/ui/renderer/retired-replies.tsx` (`RetiredReplies`) | Restored with its tests to preserve the related recovery reader                   | ChatGPT → Chat conversations: Stored replies                       |

The intentionally removed inline Settings surfaces are outside that deleted-file
list: Setup duplicates now live in Setup, diagnostic action readback lives in
Unresolved actions, and the former startup preference lives in Setup → Workspaces.
None of those removals authorizes dropping Chat capabilities.

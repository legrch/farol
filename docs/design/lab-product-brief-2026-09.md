# Farol design-lab product brief

This historical September 2026 lab record retains its original status and scope. Relative prototype paths refer to [design-lab/](../../design-lab/); use the [current renderer contract](../desktop/renderer.md) for present source behavior and acceptance limits.

Status: `OWNER_DIRECTION_CHOSEN` · Watch Rail, Iris, Geist; production integration not started

This brief scopes the reversible visual prototype. It does not redefine Farol, change
Legacy, or establish live provider or native-host readiness.

## Product truth

Farol is a separate macOS desktop preview for task-bound work. Its shell makes five things
understandable without pretending that configuration is capability:

1. **Browser is the primary work surface.** Each task owns a selected Browser surface and keeps
   its own label, lifecycle state, and result.
2. **Computer is explicit authority.** A person sees the exact target, return value, duration,
   persistence, and unavailable scopes before allowing one bounded request.
3. **Activity is a human audit.** It retains lifecycle facts and recovery guidance, not prompts,
   answers, raw tool payloads, or telemetry-shaped noise.
4. **Setup explains boundaries.** ChatGPT, Computer, local connection, native hosts, and
   verification are separate steps with truthful unavailable states.
5. **Settings exposes identity and behavior.** Preview identity, runtime boundaries, appearance,
   keyboard paths, and privacy remain inspectable.

The app surrounds a real task-bound Browser surface in production. This DOM lab intentionally
uses a visibly labelled synthetic local page; it does not redraw an external provider as a fake
Farol conversation.

## Primary user outcomes

| Moment    | The person must be able to answer                                              |
| --------- | ------------------------------------------------------------------------------ |
| Start     | Which Farol build is this, and is it isolated from Legacy?                     |
| Work      | Which task and Browser surface are selected?                                   |
| Wait      | What exact decision is blocking progress?                                      |
| Authorize | What may Computer do once, and what remains unavailable?                       |
| Recover   | Did the task fail, become unavailable, or leave an unknown submission outcome? |
| Inspect   | What lifecycle fact was retained without exposing content?                     |
| Configure | Which runtime/provider/host capabilities are genuinely ready?                  |

## Required lifecycle language

The same vocabulary appears in task tabs, Browser status, Computer, Activity, and the fixture
control:

- `Running`: local output is still changing.
- `Waiting`: one explicit decision is required.
- `Complete`: the final result is retained with its task.
- `Failed`: the task stopped with a recorded reason.
- `Unavailable`: the required local capability is not ready; no implicit resubmission occurs.
- `Outcome unknown`: the operation may have been submitted; inspect Activity before retrying.

Unknown outcome is deliberately distinct from failure. The interface must never offer an
automatic retry when duplicate submission is possible.

## Design constraints

- Use the macOS system type stack and familiar window, navigation, toolbar, focus, and keyboard
  conventions while making the five direction compositions materially distinct. System
  typography is the native default; the Watch Rail study also renders two bundled, rights-clear
  typefaces because the owner asked for a sharper typographic voice.
- Keep the app useful at `1180 x 760` and `760 x 640`; compact mode may collapse labels but must
  retain every primary route.
- A hidden sidebar route must still have menu and keyboard parity in the production app.
- Primary actions cannot depend only on color or a transient toast.
- Honor reduced motion and strong keyboard focus. Long task labels truncate without moving task
  ownership or state off-screen.
- Preserve one clear Farol identity without adding decorative texture, fake depth, or gratuitous
  animation.
- Do not introduce persistent permissions or product runtime state in the prototype.

## Fixture and baseline provenance

All prototype data is synthetic. The shared comparison fixture is `Atlantic workspace check` in
two matched scenes: `Browser / Running` and `Computer / Waiting`. No network, account,
filesystem, command, screenshot, native-host, signing, or publication action is represented as
performed.

Keeper's Slate and Watch Rail reuse the same fixture, scenes, viewports, and evidence format; the
earlier directions are preserved unchanged as the comparison baseline.

The visual baseline was read from the existing sealed Farol evidence set at source commit
`a5e253426fe487ce8732dfec94fdf993c87a3228`. Its saved `vnext/artifacts/e2e/report.json` records
`sourceDirty: false`, source tree digest
`650df9c58546094e0fa75c982b06c3d72ce763d3c9c9ddaf60ad75b574802a67`, and screenshots for
Browser, Computer wait, compact Settings, Setup, failure, and runtime-death states. The design-lab
branch starts from that exact commit. The old screenshots are reference evidence, not acceptance
of this new visual direction.

## Acceptance boundary

The lab may establish visual hierarchy, DOM interaction, state language, keyboard paths, focus
return, compact layout, reduced motion, local rendering, and screenshot dimensions. It cannot
establish production WebContentsView stacking, hit testing, menu parity, native focus behavior,
IPC safety, live provider readiness, signing, release, or Legacy replacement.

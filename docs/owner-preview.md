# Farol Next owner preview

## Open it

From the repository root:

```bash
task run
```

An ordinary launch starts with no synthetic tasks. To exercise the retained fixture
deliberately, use:

```bash
task run -- --demo
```

This command does not build. It verifies that the committed repository source identity
matches `_output/package/artifact.json`, copies the candidate into a private unique
temporary launch snapshot, verifies that final launch path, and launches only those
verified bytes. A concurrent `task package` can replace the canonical package but
cannot replace the running snapshot. The snapshot and its frozen manifest are removed
when the owner launcher observes that launch exit. An ungraceful launcher kill or host
shutdown can leave its private temporary directory behind; it is never reused as a
candidate or promotion source. If the candidate is absent or stale, the command says
to commit the intended source and run `task package`; it never falls back to old
bytes.

The Taskfile starts the owner guard and Node verifier from an allowlisted environment,
and the owner launcher passes only `HOME`, locale, `TMPDIR`, and a fixed system `PATH`
to the packaged process. Node, Electron, dynamic-loader, proxy, and other ambient
shell switches are not inherited. Arbitrary same-owner processes that directly
rewrite the private temporary snapshot after verification remain inside the trusted
local-owner boundary; this unsigned local preview is not a security boundary against
its owner.

Invoking `tooling/run-preview.mjs` directly is unsupported and refused. The private
Taskfile marker that distinguishes the owner entrypoint is an interface guard, not an
authentication or same-owner security boundary.

`task preview` is the separate development command. It may rebuild `_output/build/app` and
is not evidence about the packaged candidate.

## Setup inside the app

Normal packaged Preview and Dev use the sidebar Guided Setup. Opening, returning
to, restarting or reviewing Setup selects that same surface; first run does not
open the legacy modal. The shared selection predicate controls only Setup. Dev's
Codex home, diagnostics and automatic app-verification guard remain Dev-only.
The explicit `--demo` surface and the isolated E2E legacy-journey mode are separate.

Packaged Preview checks the NEW connector from an ordinary ChatGPT conversation.
Use the current unused challenge shown on Add to ChatGPT, then choose **Check
attachment** to inspect the local receipt. This action never sends a browser
message. A consumed, stale or unknown challenge is not offered as a fresh check.
Embedded sign-in is optional for Computer and is never claimed as verified by
completing that optional step. Settings keeps the existing workspace write,
Workspace shell and full Git/user-settings approvals.

The retained five-stage qualification journey is exercised only by its explicit
fixture lane. `task test:e2e:guided-setup:package` separately checks the normal
packaged sidebar, folder selection, navigation and reopen with disposable state
and hidden windows. The guarded lane also checks compact Browser tabs, tab close,
task-menu Setup, native page bounds and the bottom status strip at normal and compact
widths, using only a local HTTP composer fixture. It proves native userData/sessionData
is beneath the owned disposable root before UI actions. Preview uses an explicit
user-data-dir; HOME and the Dev-only appData override alone are insufficient. It is
not a live account, native picker or NEW connector proof.
`task test:e2e:guided-setup` checks both environments; `-- --dev-only`
selects a focused disposable Dev diagnostic. The fixture uses physical temporary
paths and waits for the folder access check before the next navigation action.

## What the controls do

- Setup and Settings can open the isolated ChatGPT sign-in surface, persist approved
  workspaces and exclusions, verify native read access, select and attest a Codex
  executable, and run the bounded host and Agent checks. Visiting or skipping a step
  never marks it verified.
- Setup's Connect step configures the tunnel this preview's Computer connector is
  reached through. Three actions happen outside Farol, in OpenAI's own pages: create
  the tunnel, create a Restricted runtime key scoped to Tunnels Read and Use, and
  attach the connector inside ChatGPT. Farol ships the written steps for each and
  automates none of them; the tunnel ID goes in this step's Tunnel ID field, the key
  in its Runtime key field, and `Check attachment` then confirms ChatGPT can reach the
  connector. There is no video and no executable-search step: finding a supported
  executable on this Mac is the product's own job, not an instruction to the owner.
- Ordinary launch has no synthetic task tabs. Real read-only or attachment tasks are
  created only after context preview and an explicit submit; provider, delivery, and
  outcome-unknown states remain distinct.
- With the explicit `--demo` flag, both task tabs are fixed synthetic fixtures. They
  are not an owner task registry.
- `Allow once` releases one synthetic Computer response for whichever demo task is
  actually waiting. It cannot read a path or run a command.
- `Finish demo response` lets the selected scripted response reach its terminal state.
  It does not publish, install, release, or update anything.
- Activity contains only allowlisted lifecycle facts. It omits prompts, answers,
  tool payloads, paths, and bearer values.
- Computer owns approved workspace instructions, guidance, list/search/read and
  explicit write/edit/rename/delete authority. Changes require a stable operation ID
  and exact source digest; an unknown outcome never authorizes a blind repeat.
  Choose **Workspace shell** and verify the folder again to expose ordinary
  sandboxed commands through `computer_shell_start/read/cancel`. Shell handles retain
  incremental stdout/stderr and actual root exit/signal. Network stays denied.
  Full Git requires **Approve full Git and user settings**, then another Verify.
  This grants the selected repository's object history and linked metadata plus
  read access to the declared ordinary user Git settings; it does not grant arbitrary
  account-home access or system Git configuration. Git remains the standard CLI,
  including allowed hooks. Generic file tools still hide `.git`. See the exact
  [Computer policy and cleanup limits](computer-parity.md).
- A restricted first Computer-only trial uses a disposable approved repository and
  foreground commands. `/bin/ps` and deliberately detached-descendant cleanup remain
  unqualified; a successful group signal is not full tree cleanup. Compare the NEW
  connector's serving build, owner challenge receipt and fresh client catalogue.
  An old cached Farol Dev catalogue is not evidence about this preview. Keep V0 as
  fallback. This scope does not qualify full V0 parity.
- Model and Product Agent remain disabled in this preview baseline. Their positive
  verification is not qualified; a disabled Agent returns `AGENT_NOT_READY` without
  a child launch. Ordinary Computer and its separate connector do not require
  embedded ChatGPT login, Model, Product Agent or a Codex/Claude task grant.
- Export support writes schema 2 build/configuration/readiness metadata plus a
  content-free current native-Agent summary. It contains no workspace path or ID,
  prompt, answer, file content, token, cookie, or child/thread identifier.
- `Control+Command+S` or View -> Show/Hide Sidebar switches between the full Watch
  Rail sidebar and its 72 px rail; below 980 px it opens the full sidebar as an
  overlay. `Command+K` opens the quick switcher. Native task pages are hidden while a
  shell overlay or Setup is open so the overlay receives clicks, Escape, and focus.
- The Settings authority row reports the contract-tested TaskGrant continuity core;
  the separate Native Agent row reports whether the current selected host actually
  completed the bounded check. Changing Computer policy invalidates that proof.

On macOS, closing the window leaves this preview application and its in-memory local
runtime running. Launching the same exact build again or clicking its Dock icon
reopens one window; it does not create a second instance. A different or unverifiable
build is refused instead of silently opening the already-running bytes. A launch that
arrives while the primary is still starting waits for the same initialization promise;
it is acknowledged only after the runtime, task views, and streams are ready. ACK files
are published complete through a private temporary file and an exclusive atomic link.
`Command+Q` quits the application and its exact utility process. Explicit demo task
state is in memory and is not promised across Quit; product configuration is persisted
and read back separately.

## If something goes wrong

- The app will not start and reports `SETTINGS_CORRUPT`: settings written by a newer
  build were kept byte for byte rather than silently rewritten by an older one. Go
  back to the newer build. Do not delete the settings file to make an older one start.
- A workspace reports `WORKSPACE_ROOT_CHANGED` after an external volume was
  reconnected: macOS gave it a new device number, so the folder no longer matches the
  identity recorded when it was verified. Remove it in Computer and add it again;
  `Verify` alone does not resolve this.
- A guarded edit reports that its outcome is unknown: the change may already be in the
  file. Farol neither repeats it nor deletes anything, and the version it could not
  confirm stays in a hidden `.farol-stage-*` folder beside the file to compare and
  remove by hand.
- A task asks to return to the previous conversation: nothing is lost. Go back to that
  task's own conversation or start a new one; the switch completes on the next request
  either way.
- The sign-in window was left open, or a closed task still reports
  `TASK_CONTEXT_RESIDUE`: quitting and reopening this preview sweeps both.
- Every case above touches only this preview's own state under the app-data root named
  `Farol Next Preview`. Legacy `Farol.app`, `~/.farol`, and any installed
  `codex-chatgpt-web` profile are never read or written by it.

## Product boundary

The bundle ID is `local.farol.next.preview`; its browser partition is
`persist:farol-next-preview`; its user and session data resolve under the Electron
app-data root named `Farol Next Preview`. Runtime HTTP/SSE uses an OS-assigned loopback
port and per-launch in-memory bearers. The complete implemented/absent ownership table
is [`../resources.json`](../resources.json).

Legacy `Farol.app`, `~/.farol`, its launchers, tunnel, provider route, browser
partition, updater, and installed `codex-chatgpt-web` profile are outside this
preview's ownership.

## Optional local promotion — owner action only

Preview the exact non-mutating plan:

```bash
task promote
```

If the destination and receipt are absent and you choose to make the local preview
durable outside the checkout, run this owner action:

```bash
task promote -- --destination "$HOME/Applications/Farol Next Preview.app" --apply
```

The operation derives the owner's home from the operating-system account identity,
never from the `HOME` environment variable, and accepts only the fixed app slot directly
below that real, non-symlinked, owner-controlled home. It refuses an unsafe home before
creating anything. A digest-attested Python helper opens that directory component by
component and performs every mutation relative to the retained directory descriptor,
so replacing its pathname cannot redirect the copy or cleanup into a Legacy root. It
refuses any existing destination, copies into a newly claimed Next-only path, verifies
the destination bytes against the source artifact digest, and writes
`$HOME/Applications/Farol Next Preview.app.receipt.json`. It never overwrites an
application and never writes inside Legacy roots. This unsigned local Preview is not
a signed, notarized, published, or independent-recipient release.

If the copy is interrupted before the receipt exists, the exact Preview destination
may be partial and remains fail-closed. After confirming the sibling receipt is absent,
the owner may move only `Farol Next Preview.app` to Trash and run the same command
again; the tool never removes an existing destination on a later invocation.

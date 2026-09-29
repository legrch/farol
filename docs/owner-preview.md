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

Normal packaged Preview and Dev use sidebar Guided Setup, the compact Browser
with top tabs and a bottom status bar, and the same owned embedded home/sign-in
surface. Return, Restart, Review and task-menu Setup use the shared selection
predicate. Explicit demo and isolated legacy test mode remain separate. Private
Dev homes, native shortcuts and host diagnostic authority remain Dev-only.

**Check inside Farol** is the default connection-check method. Add a separate NEW
ChatGPT app for the current tunnel and explicitly save its exact name on Add to
ChatGPT. Farol never guesses a target from its build environment or an old app name.
The selection is stored in `config.json`, bound to the
current tunnel and connector generation. A changed generation requires a new
selection; a pending/unknown check cannot be retargeted.

Run the embedded check only when ready to send one message. The existing route
uses a temporary Instant conversation, checks the exact app before typing and
again before Send, and keeps the result visible until **Return to Setup**. Missing,
ambiguous, conflicting or lost app selection and owner drafts fail before Send.
Only the correlated local MCP receipt for the current build/runtime/workspace and
challenge proves attachment. A chip label or a provider reply is not that proof.
The durable attempted/pending journal prohibits blindly replaying an unknown send.

**Check manually in external ChatGPT** remains a separate, explicitly chosen
method. It shows the current unused challenge and reads the local receipt; it
never sends a browser message. Activating Computer and its tunnel does not require
embedded login. The embedded check itself does require a verified embedded account.
Skipping optional login never writes sign-in evidence or grants workspace access.
Settings retains workspace write, Workspace shell and full Git/user-settings grants.

`task test:e2e:guided-setup` checks normal Preview and Dev navigation, folder
selection, the selected page's sidebar, compact native geometry, close and reopen
with owned hidden windows. `-- --dev-only` is the focused Dev lane.
`task test:e2e:guided-setup -- --behavior` checks fresh/returning normal Preview:
credentials save/cancel, activation without embedded login, explicit app selection,
one embedded fixture submission, an actual built MCP receipt, visible reply,
Return to Setup, stale runtime recovery and pending no-replay/retarget refusal.
The packaged equivalents use `task test:e2e:guided-setup:package` and
`task test:e2e:guided-setup:package -- --behavior`.

Every native lane proves physical userData/sessionData is beneath its owned
profile before UI actions, uses finite waits and records actual owned child exits.
The folder picker, tunnel control plane, app chip, account and model reply are
local fixtures. The behavior lane sends only to its owned loopback page; it does
not qualify a live account, provider selection, native picker or NEW connector.
A live embedded verification still needs the owner's explicit action and current
permission; these fixtures do not authorize a provider Send.

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

## Setup access transitions and receipt timing

A newly picked folder remains read-only until the owner confirms the local-work
proposal beside that folder. This single in-Setup approval requests guarded file
edits, workspace command mode and full Git/history/user-settings access. The
confirmation identifies the folder and explains the shared command mode. Cancel
keeps the read-only choice. Existing exclusions remain in place. Full Git may
expose old excluded content or sensitive user settings; it is never inferred from
the native picker. Read-only use remains available.

Settings edit/Git/recheck/command controls lead to this same explicit Setup
transition. Its existing backend commands pause the running connector, apply
and read back each admitted change, verify the selected folder and all saved
folder checks, then restore a previously ready connection. A failed or unknown
step stops the sequence; partial settings remain visible and no automatic retry
or ChatGPT Send occurs. A lost reply or failed settings write/readback fences
subsequent folder/connector changes. Recheck reads the native bootstrap snapshot
without ending sign-in or probing ChatGPT; an exact matching readback releases
the fence but never resumes the permission plan. Read-only and full-Git
revocation are applied before verification, even when the folder is inaccessible. Remove confirmation is beside its folder, not below the
complete list.

An app-bound temporary connection check can finish its local observation from
the exact current MCP receipt while provider answer rendering continues. This
is a distinct receipt-confirmed outcome, not model-answer completion. Lost Send
acknowledgement remains unknown; receipt observation never sends another message.
The first home-to-created-conversation transition is preserved, while a second
conversation, cancellation or closed surface invalidates the observation. The
owner can still read the page and explicitly return to Setup.

The app field uses the exact name shown in ChatGPT. A name such as Farol Dev
does not choose the build environment: the selected tunnel/generation, serving
identity and local receipt bind it. Reuse the app already connected to this
tunnel; do not create a duplicate or move credentials for a display-name change.

These changes require their own clean-source/package and native qualification.
Source policy fixtures and the historical1b owner receipt do not qualify new
bytes; the earlier packaged returning/pending FAIL and denied native repeat
remain preserved until their supported remedy.

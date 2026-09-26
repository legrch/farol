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
matches `dist/package/artifact.json`, copies the candidate into a private unique
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

`task preview` is the separate development command. It may rebuild `dist/app` and
is not evidence about the packaged candidate.

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
- Computer owns workspace list/search/read plus explicit access and exclusion changes.
  A guarded edit requires preview and confirmation, checks the expected digest, and
  stores a content-free mutation receipt. `Verified commands` is off by default. When
  explicitly enabled and the workspace is verified again, `Git status` runs one fixed
  Apple Git operation at that workspace root with no caller-supplied executable,
  arguments, environment, path, or network access. Output and runtime are bounded and
  the output is not persisted. Generic file tools hide `.git`; a linked or external
  Git worktree metadata path fails closed as unavailable.
- The Codex Agent verification creates one actual native child for a fixed read-only
  compatibility assignment. A green result means lineage, unchanged TaskGrant,
  workspace enforcement, bounded same-child rejoin, durable retention, and parent
  delivery were all observed for that assignment. It is not a generic Agent launcher.
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

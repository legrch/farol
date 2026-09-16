# Farol Next owner preview

## Open it

From the repository root:

```bash
task next:run
```

This command does not build. It verifies that the committed `vnext/` source identity
matches `vnext/dist/package/artifact.json`, copies the candidate into a private unique
temporary launch snapshot, verifies that final launch path, and launches only those
verified bytes. A concurrent `task next:package` can replace the canonical package but
cannot replace the running snapshot. The snapshot and its frozen manifest are removed
when the owner launcher observes that launch exit. An ungraceful launcher kill or host
shutdown can leave its private temporary directory behind; it is never reused as a
candidate or promotion source. If the candidate is absent or stale, the command says
to commit the intended source and run `task next:package`; it never falls back to old
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

`task next:preview` is the separate development command. It may rebuild `dist/app` and
is not evidence about the packaged candidate.

## What the controls do

- Setup states the current boundary: the local runtime and Browser fixture work;
  live ChatGPT, native Computer, native Agent, and filesystem access do not.
- Both task tabs are fixed synthetic demos. They are not an owner task registry.
- `Allow once` releases one synthetic Computer response for whichever demo task is
  actually waiting. It cannot read a path or run a command.
- `Finish demo response` lets the selected scripted response reach its terminal state.
  It does not publish, install, release, or update anything.
- Activity contains only allowlisted lifecycle facts. It omits prompts, answers,
  tool payloads, paths, and bearer values.
- `Control+Command+S` or View -> Show/Hide Sidebar switches between the full Watch
  Rail sidebar and its 72 px rail; below 980 px it opens the full sidebar as an
  overlay. `Command+K` opens the quick switcher. Native task pages are hidden while a
  shell overlay or Setup is open so the overlay receives clicks, Escape, and focus.
- The Settings authority row reports the contract-tested TaskGrant continuity core.
  It is not a claim that this product preview selected the native Computer boundary
  or admitted a native Agent.

On macOS, closing the window leaves this preview application and its in-memory local
runtime running. Launching the same exact build again or clicking its Dock icon
reopens one window; it does not create a second instance. A different or unverifiable
build is refused instead of silently opening the already-running bytes. A launch that
arrives while the primary is still starting waits for the same initialization promise;
it is acknowledged only after the runtime, task views, and streams are ready. ACK files
are published complete through a private temporary file and an exclusive atomic link.
`Command+Q` quits the application and its exact utility process. The demo state is in
memory and is not promised across Quit.

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
task next:promote
```

If the destination and receipt are absent and you choose to make the local preview
durable outside the checkout, run this owner action:

```bash
task next:promote -- --destination "$HOME/Applications/Farol Next Preview.app" --apply
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

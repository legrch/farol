# Farol Next owner preview

## Open it

From the repository root:

```bash
task next:run
```

This command does not build. It verifies that the committed `vnext/` source identity
matches `vnext/dist/package/artifact.json`, verifies the bundle at
`vnext/dist/package/Farol Next Preview.app`, and then launches those exact bytes. If
the candidate is absent or stale, the command says to commit the intended source and
run `task next:package`; it never falls back to old bytes.

`task next:preview` is the separate development command. It may rebuild `dist/app` and
is not evidence about the packaged candidate.

## What the controls do

- Setup states the current boundary: the local runtime and Browser fixture work;
  live ChatGPT, native Computer, native Agent, and filesystem access do not.
- Both task tabs are fixed synthetic demos. They are not an owner task registry.
- `Allow fixture check` releases one synthetic Computer response for the selected
  demo task. It cannot read a path or run a command.
- `Finish demo response` lets the selected scripted response reach its terminal state.
  It does not publish, install, release, or update anything.
- Activity contains only allowlisted lifecycle facts. It omits prompts, answers,
  tool payloads, paths, and bearer values.

On macOS, closing the window leaves this preview application and its in-memory local
runtime running. Launching it again or clicking its Dock icon reopens one window; it
does not create a second instance. `Command+Q` quits the application and its exact
utility process. The demo state is in memory and is not promised across Quit.

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

The operation refuses any existing destination, copies into a newly claimed Next-only
path, verifies the destination bytes against the source artifact digest, and writes
`$HOME/Applications/Farol Next Preview.app.receipt.json`. It never overwrites an
application and never changes Legacy. This unsigned local Preview is not a signed,
notarized, published, or independent-recipient release.

If the copy is interrupted before the receipt exists, the exact Preview destination
may be partial and remains fail-closed. After confirming the sibling receipt is absent,
the owner may move only `Farol Next Preview.app` to Trash and run the same command
again; the tool never removes an existing destination on a later invocation.

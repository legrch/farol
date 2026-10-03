# Build and launch a candidate

Produce a verified package from clean committed source, then launch an isolated
copy of those exact bytes. Begin with [development setup](setup.md) and the
required [source gate](testing.md#source-gate).

## Build a candidate

```sh
task ci:fast
task package
npm run verify:package
```

`task package` is the only candidate-producing entrypoint. It starts from an empty
allowlisted environment through the owner guard, binds source/build/dependency
inputs, embeds the pinned Electron runtime, and verifies the final package.
`npm run package` deliberately refuses direct packaging.

**Check:** the candidate and `_output/package/artifact.json` agree with the intended
clean source/build identity. An internally consistent package cannot override the
reviewed compiler, dependency, or resource contracts.

## Launch a candidate

```sh
task run
```

The command verifies the source/package identity, copies the candidate into a new
private isolated launch snapshot, verifies the final path, and launches only those
bytes. It does not build or install. Concurrent packaging cannot replace this copy.

A second launch reopens only an exact running build with the required nonce-bound
acknowledgment. Initialization requests wait for the same startup. Another or
unverifiable build is refused; Quit it normally before switching.

The launcher removes its snapshot after observed app exit. An interrupted launcher
can leave an unused private temporary copy. Deliberate same-user mutation of the
unsigned snapshot is outside its integrity threat boundary.

Direct execution from `_output/package` or direct `tooling/run-preview.mjs`
invocation bypasses supported admission and is unsupported.

## Launch modes

| Command                            | Meaning                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `task run`                         | Ordinary packaged candidate with the product profile    |
| `task run -- --hidden`             | Same admission/profile with every product window hidden |
| `task run -- --demo`               | Explicit scripted tasks                                 |
| `task dev`                         | Working-tree build in the separate Dev profile          |
| `task dev -- --acceptance-profile` | Further isolated Dev acceptance profile                 |

Hidden mode requires normal Quit/drain and does not qualify visible UI. It refuses
an existing-instance reopen. An older primary can leave its version-3 background
request unverified; normal Quit is the remedy. Test-only debug/profile overrides
are not enabled by this mode.

Follow the [native display policy](testing.md#display-and-focus-policy) for tests.
Ordinary development and product launches retain normal foreground behavior.

## Establish an installed baseline

The managed updater requires the fixed `$HOME/Applications/Farol.app` slot and an
accepted installation receipt. A plain copied archive does not create that receipt.
The source promotion workflow is:

```sh
task promote
```

Inspect the plan and obtain the applicable installation authority, then explicitly apply:

```sh
task promote -- --apply
```

Promotion verifies the candidate and active-work obligations, installs only into
an empty fixed slot, and writes the receipt. Home comes from the OS account;
changing the shell's `HOME` cannot redirect it. An occupied slot is a refusal.
Preserve and reconcile an existing installation rather than deleting it to make
this check pass.

Older `Farol Next Preview.app` installations use
[closed preview maintenance](../maintenance/preview-cutover.md). Naming a bundle
`Farol.app` does not migrate an old updater or establish its baseline.

## Next

Use [native/package tests](testing.md#native-lanes) for the evidence your task needs.
For an accepted installation, follow [updates](../guides/updates.md). Read
[profile identities](../reference/profiles.md) before comparing environments.

---

[Development](README.md) · [Documentation](../README.md)

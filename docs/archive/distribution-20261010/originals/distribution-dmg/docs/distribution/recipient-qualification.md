# Recipient qualification and final bind

This is the Distribution preparation exit. It consumes an accepted Release/Identity
package and first-install contract; it does not define another installer, updater,
release manifest, baseline schema or journal. An absent accepted input stops the
corresponding step. The current downloadable script stops at `PREPARED`.

## Current evidence and blockers

The accepted base fixture is `0.1.8-owner.beta.1`, build `10`, source commit
`1eb30bd23df22c9581d277280f8e0699612786b5`, bundle `local.farol.next.preview`.
Its measured version-2 app tree digest is
`c872194547d19691da7252572f63dd36074624115e6eaa5004dfab4545335ea6`.
DMG mount, layout, copy, content verification and unmount passed with the reviewed
Distribution foundation. These facts do not qualify that app for a new recipient.

The artifact declares Node embedded in Electron. Its packaged `main.cjs` and
`computer-mcp.cjs` retain `/usr/bin/python3`, `/usr/bin/xcrun` and
`/usr/bin/xcode-select`; `computer-safe-open.py` is packaged. The matching source
constructs the default native workspace without an embedded-interpreter override.
That default attests Python under Xcode/Command Line Tools. Built-in Computer
operation therefore has a known developer-tool dependency in this fixture. Do not
market it as a clean-Mac app or resolve it by installing developer tooling.

Read-only packaged-byte inspection is dependency-negative evidence; it does not
launch Farol. A stock-only `PATH` bootstrap smoke test covers the shell preparation
path, not absolute interpreter selectors in the app. Absence of a scanned string
would also be insufficient to prove dependency closure. Final Go/Identity bytes,
a real recipient account and an authentic first-launch baseline are still needed.

## Release and Identity inputs

The cutover destination is `/Applications/Farol.app`. Dev keeps a distinct app,
bundle/profile identity, state and update eligibility. An existing
`~/Applications/Farol.app` is observed and adopted only through Release's explicit
contract. Finding it does not authorize Finder replacement, deletion, state copy
or a second install executor. Distribution refuses it before downloading the DMG.

Release/Identity and Lead must provide the following before final binding:

- The exact accepted app and authoritative package descriptor/attestation, including
  app tree digest, source/build identity, channel, architecture and final bundle ID.
- The accepted package-content verifier and physical resource/notices attestation
  for that final identity and embedded backend/runtime layout.
- The first-install/adoption entrypoint and operation observation contract, including
  the target/profile derived by their owner, refusal before effects, installed and
  outcome-unknown behavior. Observe the same operation; never dispatch it again to
  recover a missing acknowledgement.
- Authentic drag first-launch baseline acceptance and publication, based on the
  measured installed physical tree and accepted descriptor. A missing, mismatched,
  unreadable or interrupted baseline blocks update. A self-reported hash, copied
  promotion receipt or successful app copy is insufficient.

These are required semantics, not a proposed wire/receipt schema or an invented
CLI. Shared package, resource, identity and release metadata files remain Lead-owned.
Until that owner supplies exact bytes and contracts, there is no valid shared patch
that Distribution can infer by replacing a bundle string in the existing verifier.

## Exact producer bind step

Run the commands from the accepted checkout with its declared Node toolchain. This
is maintainer tooling; the recipient runs only the stock-macOS bootstrap and app.
Set the task-specific variables from Lead's accepted package/source selection,
independently of the descriptor being verified, never `latest` or inferred labels.
`distribution_output` must name a new directory outside the app.

```sh
node tooling/distribution/dmg.mjs \
  --app "${distribution_app:?accepted app required}" \
  --artifact "${distribution_artifact:?accepted descriptor required}" \
  --version "${distribution_version:?exact release required}" \
  --build-version "${distribution_build:?exact build required}" \
  --channel "${distribution_channel:?exact channel required}" \
  --arch arm64 \
  --bundle-id io.github.legrch.farol \
  --app-sha256 "${distribution_app_digest:?accepted app tree digest required}" \
  --source-commit "${distribution_source_commit:?accepted source commit required}" \
  --source-tree-digest "${distribution_source_digest:?accepted source tree digest required}" \
  --output "${distribution_output:?new output directory required}"
```

The current upstream verifier accepts only the pre-cutover identity and refuses
this final identity. Lead must supply the accepted verifier binding first. Do not
weaken the verifier, edit the artifact to pass, or bypass it with the physical-test
primitive. The builder measures the actual image and emits its JSON/SHA256SUMS;
retain these outputs for the exact image under review. Native container bytes may
vary while accepted app content and layout stay identical.

After Release's first-install binding is implemented, measure the exact script and
DMG files for the immutable release. Use those measured hashes in the generator:

```sh
/usr/bin/shasum -a 256 tooling/distribution/install-alpha.sh
/usr/bin/shasum -a 256 "${distribution_image:?exact generated DMG required}"
node tooling/distribution/command.mjs \
  --version "${distribution_version:?}" --build-version "${distribution_build:?}" \
  --channel "${distribution_channel:?}" --arch arm64 \
  --bundle-id io.github.legrch.farol \
  --dmg-sha256 "${distribution_image_digest:?measured image digest required}" \
  --installer-sha256 "${distribution_script_digest:?measured script digest required}"
```

Review the emitted line before publication. Both assets must belong to that exact
release tag. Publishing is Lead's separate action. SHA-256 checks consistency with
trusted publication, not independent publisher authenticity. Current skeleton
success is only `PREPARED`; it does not invoke the pending first-install entrypoint.

## Qualification matrix

| Case                                                           | Required result                                                           | Current evidence                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| System, user, old Preview slot or dangling link already exists | Refuse before DMG download; preserve existing app/state                   | Disposable shell/filesystem tests                |
| Existing app appears during download/mount                     | Refuse after observation; detach only owned mount; preserve app           | Disposable shell/filesystem test                 |
| Distinct Dev app is present                                    | Production preparation preserves Dev and its state                        | Full generated bootstrap with boundary doubles   |
| Unsupported hardware or identity                               | Refuse; do not reinterpret Dev as production                              | Policy fixtures                                  |
| Multiline/control-byte value                                   | Refuse before URL or checksum records are created                         | Regression from three failing multiline cases    |
| Download/verify fails, or mounted payload is wrong             | No install or launch; owned cleanup; no retry                             | Shell with HTTP/hardware/mount doubles           |
| Attach acknowledgement lost                                    | One exact owned cleanup; no new attach; retain evidence if detach unknown | Explicit failure doubles                         |
| Modified downloaded script                                     | Refuse before executing it or downloading DMG                             | Emitted one-liner with real shell/shasum         |
| Stock-only bootstrap environment                               | Preparation uses stock macOS utilities                                    | Dependency smoke only                            |
| Built-in app with no global Python/Node/Go/Homebrew/Xcode      | Normal setup and built-in operations work                                 | BLOCKED for old fixture; final recipient NOT_RUN |
| Exact final app DMG, browser download and Gatekeeper           | Mount/copy/eject/open in real fresh account or recipient                  | NOT_RUN                                          |
| Drag first-launch baseline and N to N+1                        | Authentic baseline, eligibility, configuration retention and recovery     | NOT_RUN                                          |

For the actual recipient, record macOS/hardware, exact downloaded hashes, app/build/
source/channel, first open, setup, built-in read/edit, normal Quit/reopen, separate
Dev, baseline, update and recovery. Keep quarantine. Use only Apple's per-app
`System Settings > Privacy & Security > Open Anyway` flow when appropriate; stop on
a damaged/harmful warning or unavailable exception. No global Gatekeeper change or
mandatory xattr removal. Codex/Claude/Git prerequisites are a separate feature check.

A disposable HOME, fixture app or test-owned byte copy does not make this a fresh
macOS account. Provisioning an account/VM and final install remains an explicit
Lead/owner step against accepted final bytes. Never claim source mocks, a static
reference scan or the prior accepted fixture as that acceptance.

# Install the unsigned Farol technical alpha

Use the exact release and architecture sent by the maintainer. This alpha is
unsigned and not notarized. Its base app must be qualified for a fresh install;
the distribution preparation fixture alone is not that qualification.

1. Check that this is an Apple silicon Mac and there is no existing `Farol.app`
   in `/Applications` or `~/Applications`. If Farol or an older Preview is present,
   stop and use the maintainer's supported migration/update instructions. Do not
   replace an existing app in Finder.
2. Download the exact `Farol-<VERSION>-macos-arm64.dmg` from the release sent to you.
   Compare its file SHA-256 with the maintainer's published value in Terminal:

   ```sh
   /usr/bin/shasum -a 256 /absolute/path/to/Farol-<VERSION>-macos-arm64.dmg
   ```

   The version and channel must match the instructions. Hash comparison proves
   consistency with that publication, not independent publisher authenticity.

3. Open the DMG. For a release qualified for drag first install, drag `Farol.app`
   onto the `Applications` link. Wait for the copy, then eject the Farol disk.
4. Open the copied `Farol.app` from Applications. If macOS blocks it as an
   unidentified developer, and you trust this exact release, use
   `System Settings > Privacy & Security > Open Anyway`, then review the prompt
   and choose `Open`. This is Apple's per-app exception flow; see
   [Apple's current instructions](https://support.apple.com/en-us/102445).
   If the exception is unavailable or macOS reports the app is damaged or harmful,
   stop and send the maintainer the exact message. Do not disable Gatekeeper or
   remove quarantine as an installation step.
5. Complete Farol setup. Before trying an update, confirm that the maintainer's
   Release baseline check passed for this exact installed build. A successful copy
   or open does not prove update eligibility. Quit and reopen normally once.

No repository checkout, Homebrew, Xcode or global Python/Node/Go should be needed
for the qualified base app. Coding-provider features may have separately documented
Codex/Claude/Git prerequisites. If the base app asks for developer tooling, record
that as a failed recipient check.

The optional one-line bootstrap must name the exact release/channel and verify
both the script and DMG SHA-256. Review the supplied line/script before executing
it. The current skeleton prints `PREPARED`, leaves the verified DMG under Downloads,
and does not install, launch or register Farol. A complete installer awaits the
accepted Release first-install entrypoint.

For an alpha report, send only the release/build, macOS version, hardware, exact
error, whether copy/eject/first open/Quit/reopen passed, and baseline/update outcome.
Do not include credentials, browser profiles, private conversations or workspace data.
